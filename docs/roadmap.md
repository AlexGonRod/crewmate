# Roadmap

Documento vivo. Describe hacia dónde va `crew`, qué está terminado y cuáles son
los criterios para cerrar cada fase. Las decisiones estructurales se registran
en `docs/adr/`; este documento no sustituye esos ADRs.

## North star

El usuario habla con un **capitán** y no con una colección de comandos. El
capitán entiende la intención, hace las preguntas necesarias, pide consentimiento
antes de instalar o clonar algo, descompone el trabajo y utiliza el **motor
determinista** de `crew` para ejecutarlo, verificarlo, entregarlo y mergearlo.

El flujo objetivo es:

```text
> ahoy! mira mi proyecto de GitHub xyz, arregla el test de login flaky y añade dark mode

# El capitán comprueba el toolchain, pide consentimiento si falta algo,
# clona el proyecto, crea las tareas y lanza workers aislados.

  PR listo para revisar: https://github.com/you/xyz/pull/42
  (test flaky: riesgo bajo, CI verde)

> vale, mergea
```

El capitán no sustituye al motor ni toma decisiones de ejecución por su cuenta.
Traduce intención a operaciones verificables y escala las decisiones que
requieren autoridad humana.

## Principios

- **Motor determinista, capitán conversacional.** El núcleo no interpreta
  lenguaje natural: ejecuta operaciones con contratos, estados y evidencia.
- **Autoridad humana explícita.** Clonar, instalar toolchain, mergear o cambiar
  una política requiere consentimiento o una política declarada de antemano.
- **Fail-closed.** Sin verificación, sin CI verde o sin aprobación del tester no
  hay entrega.
- **Evidencia durable.** Cada comando, decisión y reporte queda registrado y es
  auditable.
- **Aislamiento.** Un worktree por tarea; ningún worker toca el checkout
  principal.
- **Proporcionalidad.** No se añade un agente, una fase o una instalación si el
  trabajo puede resolverse de forma más simple.

## Resumen de fases

| Fase | Estado | Objetivo |
|---|---|---|
| 0. Núcleo durable | Completada | Estado, worktrees, metodologías y recuperación |
| 1. Pipeline y entrega | Completada | Developer, tester, verificación, commit/PR y daemon |
| 2. Motor autónomo confiable | En curso | CI, auto-merge, concurrencia y resumen de riesgo |
| 3. Capitán conversacional | Pendiente | Chat, intake, planificación, supervisión y merge |
| 4. Runtime visible y escala | Pendiente | Sesiones visibles, remotos, memoria y scout |

## Fase 0 — Núcleo durable

Estado: **completada**.

- Estado durable en SQLite con event log y proyecciones.
- Worktree aislado por tarea y rama propia.
- Metodologías `free`, `spec` y `tdd` con gates de evidencia.
- Recuperación de runs perdidos y lease del daemon.
- Contratos versionados de spec, reporte, brief, harness y eventos.

Referencias: ADR 0001 a 0005.

## Fase 1 — Pipeline y entrega

Estado: **completada**.

- Pipeline developer → verificación determinista → tester independiente.
- Commit y entrega `local` o `pr`.
- Revisión humana con `task accept` / `task reject`.
- Daemon secuencial con lease, heartbeat y reconciliación.
- Harness `opencode` real, agente `fake` y detección automática.

Referencias: ADR 0006 a 0008.

## Fase 2 — Motor autónomo confiable

Estado: **en curso**.

Esta fase convierte el pipeline en una base fiable para que el capitán pueda
delegar sin supervisión constante. El capitán no debe construirse sobre un motor
que aún no sabe esperar CI, mergear con seguridad ni ejecutar tareas en paralelo.

### 2.1 Verificación independiente

Estado: **completada**.

- Comandos `verify` del proyecto y de cada criterio de aceptación.
- Timeout, exit code, salida y log durable.
- Gate determinista antes de invocar al tester.
- Evidencia incluida en el brief del tester.

Referencia: ADR 0008.

### 2.2 Distribución e instalación

Estado: **completada**.

- Paquete npm con binario `crew`.
- Build reproducible y `prepack`.
- Assets de contratos y agente falso incluidos en el paquete.
- Instalación local verificada con un flujo e2e.

### 2.3 Gate de CI

Estado: **completada**.

- Integración con GitHub Actions mediante los check-runs del commit del PR.
- El estado de CI se consulta antes de pasar a `review`; `task accept` exige que
  el último resultado sea `passed`.
- `verify` sigue siendo el fallback para proyectos sin CI configurada.
- Un CI fallido, desconocido o agotado por timeout bloquea la entrega con un
  error claro.
- El resultado se guarda como artefacto `ci` y evento `ci.completed`, y se
  reutilizará en el auto-merge de la Fase 2.4.

Referencia: ADR 0010.

### 2.4 Auto-merge con guardrails

Estado: **completada**.

- `delivery: auto_merge` por proyecto, opt-in explícito mediante
  `auto_merge.method` (`merge`, `squash` o `rebase`).
- Requisitos: política declarada, CI configurado y verde, verificación aprobada,
  tester aprobado y PR abierto, no draft y mergeable.
- `pr` sigue siendo el modo manual por defecto.
- Sin política falla con `MERGE_POLICY_REQUIRED`; sin CI falla con
  `CI_REQUIRED_FOR_AUTO_MERGE` antes de lanzar agentes.
- El actor `crew` ejecuta el merge y registra método, motivo y estado final en el
  artefacto `merge` y el evento `merge.completed`.
- Un merge rechazado deja la tarea en `review` para resolución humana.

Referencia: ADR 0011.

### 2.5 Concurrencia y scheduler

Estado: **pendiente**.

- El daemon podrá ejecutar N tareas en paralelo; por defecto N = 1 para preservar
  el comportamiento actual.
- Cada tarea conserva su worktree, rama, run y lease independientes.
- El scheduler respeta prioridad, límites de concurrencia y recuperación.
- Se prueban colisiones de estado, cancelación y reinicio del daemon.

### 2.6 Resumen de riesgo y estado

Estado: **pendiente**.

- Clasificación de riesgo por cambio (bajo, medio, alto) con reglas explícitas.
- Resumen reutilizable por CLI, daemon y capitán: riesgo, CI, verificación,
  hallazgos del tester y estado del PR.
- El riesgo no decide por sí solo: informa al capitán y a la política de merge.

### 2.7 Robustez operativa

Estado: **en curso**.

- Lease, heartbeat, reconciliación y `task retry` ya existen.
- Pendiente: pulir cancelación, señales, reintentos y recuperación tras reinicio
  en escenarios concurrentes.
- El daemon como servicio del sistema queda para la Fase 4.

### Criterios de salida de la Fase 2

- Un CI fallido impide llegar a `review`.
- `auto_merge` solo mergea con política, CI verde y tester aprobado.
- El daemon ejecuta N tareas concurrentes sin colisiones de worktree ni de
  estado.
- `crew status` o `task show` devuelve un resumen de riesgo y CI.
- La suite completa y los e2e de concurrencia pasan de forma repetible.

## Fase 3 — Capitán conversacional

Estado: **pendiente**.

Esta fase entrega la experiencia de firstmate: hablar con un solo agente y que
este dirija el trabajo. La implementación recomendada es una sesión/skill de
`opencode` con `AGENTS.md`, no un parser de lenguaje natural dentro del núcleo.
El capitán invoca las operaciones deterministas de `crew`.

### 3.1 Capa capitán

Estado: **pendiente**.

- Sesión de harness con instrucciones `AGENTS.md` y skills de capitán.
- Puede consultar estado, crear tareas, responder, reintentar y pedir merges.
- No escribe directamente en los repositorios de trabajo.
- Traduce la conversación a comandos y valida el resultado antes de responder.

Referencia: ADR 0009.

### 3.2 Intake de proyecto

Estado: **pendiente**.

- Resolver una URL de GitHub y comprobar que el repositorio es accesible.
- Pedir consentimiento antes de instalar toolchain o dependencias.
- Clonar bajo `projects/` y registrar el proyecto automáticamente.
- Detectar rama por defecto, forge y comandos de verificación disponibles.

### 3.3 Intención, plan y tareas

Estado: **pendiente**.

- Convertir una petición en una o varias tareas con título, brief, criterios y
  metodología.
- Identificar dependencias y trabajos que pueden ejecutarse en paralelo.
- Pedir confirmación cuando la petición sea ambigua, destructiva o afecte a
  secretos, producción o merge.
- Mostrar el plan antes de lanzar workers costosos.

### 3.4 Supervisión y estado

Estado: **pendiente**.

- Lanzar tareas en cola o en paralelo según la política del proyecto.
- Reportar avances en lenguaje natural sin inundar al usuario con logs.
- Escalar solo decisiones reales: preguntas, bloqueos, conflictos o fallos que
  requieren autoridad humana.
- Recuperar la conversación y el estado tras reiniciar la sesión o el daemon.

### 3.5 Merge y aceptación conversacional

Estado: **pendiente**.

- “Mergea” comprueba política, CI, tester y estado real del PR.
- Si falta algo, explica qué falta y no fuerza el merge.
- Si todo está en orden y la política lo permite, ejecuta el merge o la
  aceptación y reporta el resultado.
- Toda autorización queda registrada en el event log.

### 3.6 Demo de aceptación

Estado: **pendiente**.

La Fase 3 se considera cerrada cuando este flujo funciona de extremo a extremo
con el agente falso y, después, con `opencode` real:

1. El usuario proporciona un repositorio de GitHub y dos cambios.
2. El capitán comprueba el toolchain y pide consentimiento si falta algo.
3. Clona y registra el proyecto.
4. Crea dos tareas con criterios de aceptación.
5. Ejecuta los workers en worktrees aislados.
6. Reporta cada PR con riesgo y estado de CI.
7. El usuario dice “mergea” y el capitán aplica la política correcta.
8. Un reinicio a mitad del flujo no pierde tareas ni decisiones.

## Fase 4 — Runtime visible y escala

Estado: **pendiente**.

- Sesiones visibles en tmux/PTY, con capacidad de observar o intervenir.
- Workers en hosts remotos alcanzables por SSH.
- Memoria de proyecto para no repetir contexto entre sesiones.
- Tareas de investigación (`scout`) con informes independientes.
- UI web o servicio del sistema.
- Soporte de más forges además de GitHub.

## Dependencias

```text
2.3 CI ───────────────► 2.4 auto-merge ───────────────► 3.5 merge conversacional
2.5 concurrencia ─────► 3.4 supervisión
2.6 riesgo ───────────► 3.5 resumen y decisión
3.1 capitán
3.2 intake ───────────► 3.3 plan ─────────────────────► 3.6 demo
```

El intake (3.2) y la capa capitán (3.1) pueden prototiparse contra el CLI actual,
pero no se debe prometer el flujo completo hasta cerrar CI, auto-merge y
concurrencia.

## Decisiones confirmadas

- **Capitán**: sesión/skill de `opencode` con `AGENTS.md`; no se implementa un
  `crew chat` con bucle LLM propio en esta etapa.
- **Auto-merge**: por proyecto y opt-in. `pr` manual es el modo por defecto.
- **Concurrencia**: el daemon arranca con N = 1 y permite N mayor de forma
  explícita.
- **CI**: GitHub Actions primero; los comandos `verify` siguen siendo el fallback
  genérico.
- **Scout**: se pospone a la Fase 4.

## No objetivos de esta etapa

- Instalar herramientas o dependencias sin consentimiento.
- Mergear sin política o confirmación.
- Introducir interpretación de lenguaje natural en el motor determinista.
- Soportar varios forges antes de estabilizar GitHub.
- Escribir directamente en la rama principal.
- Guardar secretos en logs, briefs o reportes.

## Riesgos y mitigaciones

- **El capitán interpreta mal la intención**: plan explícito, confirmación en
  acciones sensibles y operaciones deterministas verificables.
- **CI externo inestable**: timeout, reintentos acotados y fallback a `verify`.
- **Auto-merge peligroso**: política por proyecto, CI verde, tester aprobado y
  registro de auditoría.
- **Carreras con concurrencia**: leases, worktrees aislados y e2e de colisiones.
- **Coste de agentes**: límites de iteraciones, timeouts y resumen antes de
  lanzar workers.

## Referencias

- ADR 0007: pipeline developer → tester y revisión humana.
- ADR 0008: verificación independiente y determinista.
- ADR 0009: separación entre motor determinista y capa capitán.
- ADR 0010: gate de CI con GitHub Actions.
- ADR 0011: auto-merge con guardrails.
