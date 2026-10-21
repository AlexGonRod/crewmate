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

Estado: **completada**.

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

Estado: **completada**.

- `daemon run --concurrency <n>` ejecuta hasta N tareas en paralelo; por defecto
  N = 1. `--once` mantiene el contrato de una sola tarea.
- Cada tarea conserva su worktree, rama, run y lease `task:<id>` independientes.
  El lease se renueva y se libera al terminar, también si el pipeline falla.
- El scheduler respeta prioridad, `maxTasks`, concurrencia y cooldown ante
  `TASK_LEASED`; las tareas no iniciadas permanecen `queued` al abortar.
- La cancelación propaga `AbortSignal` a agentes, verificación y espera de CI.
- Se prueban concurrencia, colisión de lease, cancelación y reinicio mediante
  reconciliación.

Referencia: ADR 0012.

### 2.6 Resumen de riesgo y estado

Estado: **completada**.

- Clasificación de riesgo por cambio (bajo, medio, alto) con reglas explícitas
  y deterministas: rutas sensibles, tamaño del cambio, churn, hallazgos del
  tester, verificaciones y CI.
- El pipeline registra el diff contra la rama base como artefacto `change`
  (archivos, líneas y rutas tocadas).
- Resumen reutilizable por CLI, daemon y capitán (`TaskSummary`): riesgo, CI,
  verificación, hallazgos del tester y estado del PR.
- `task show` incluye el resumen en JSON y texto; `crew status` resume lease,
  conteo por estado, runs activos y las tareas recientes con riesgo y CI; el
  daemon incluye riesgo y CI en el resultado de cada tarea procesada.
- El riesgo no decide por sí solo: informa al capitán y a la política de merge.

Referencia: ADR 0013.

### 2.7 Robustez operativa

Estado: **completada**.

- Lease, heartbeat, reconciliación y `task retry` ya existen.
- Cancelación y señales cubren agentes, verificación y CI, también con N > 1.
- Backoff exponencial con tope y reintentos automáticos por tarea
  (`daemon run --max-attempts`, `--backoff`), con límite de intentos y estado
  persistido (`attempts`, `next_attempt_at`, `last_error`, `retryable`).
- Los fallos permanentes (configuración, protocolo, CI, política de merge) no
  se reintentan; los transitorios reencolan la tarea con retardo creciente.
- Recuperación tras reinicio: un run perdido reencola la tarea cuando quedan
  intentos (`daemon reconcile --requeue`), conservando worktree y rama.
- El daemon como servicio del sistema queda para la Fase 4.

Referencia: ADR 0014.

### Criterios de salida de la Fase 2

- Un CI fallido impide llegar a `review`.
- `auto_merge` solo mergea con política, CI verde y tester aprobado.
- El daemon ejecuta N tareas concurrentes sin colisiones de worktree ni de
  estado.
- `crew status` o `task show` devuelve un resumen de riesgo y CI.
- La suite completa y los e2e de concurrencia pasan de forma repetible.

Los cinco criterios están cumplidos.

## Fase 3 — Capitán conversacional

Estado: **completada** (3.1–3.6). Queda ejecutar la misma demo con `opencode`
real en lugar del agente falso, que es una comprobación manual y no de código.

Esta fase entrega la experiencia de firstmate: hablar con un solo agente y que
este dirija el trabajo. La implementación recomendada es una sesión/skill de
`opencode` con `AGENTS.md`, no un parser de lenguaje natural dentro del núcleo.
El capitán invoca las operaciones deterministas de `crew`.

### 3.1 Capa capitán

Estado: **completada**.

- `crew captain init` escribe las instrucciones `AGENTS.md` del capitán en el
  repositorio, sin sobrescribir un archivo existente salvo con `--force`.
- `crew captain brief` devuelve un briefing compacto: proyectos, conteo por
  estado, lease, runs activos, tareas con riesgo/CI/verificación/tester/PR y la
  lista `attention` de lo que requiere decisión humana.
- El capitán compone comandos de la CLI, no escribe en los repositorios de
  trabajo y valida la salida antes de informar.
- La capa se apoya en el mismo `TaskSummary` del motor, así que no hay un
  segundo modelo de verdad.

Referencia: ADR 0009 y ADR 0015.

### 3.2 Intake de proyecto

Estado: **completada**.

- `crew project clone <url>` resuelve URLs HTTPS, SSH y `owner/repo` de
  GitHub, comprueba el acceso con `git ls-remote` y clona bajo
  `<dataDir>/projects/<owner>-<repo>`.
- El proyecto se registra automáticamente con su rama por defecto, remote y
  forge.
- Se detectan los comandos de verificación disponibles (`package.json`,
  `Cargo.toml`, `go.mod`, `pyproject.toml`, `Makefile`) y se escriben en
  `.crew/config.yaml`.
- El consentimiento es explícito: la CLI devuelve lo que falta (toolchain,
  `node_modules`) y el comando sugerido, pero nunca instala nada.

Referencia: ADR 0016.

### 3.3 Intención, plan y tareas

Estado: **completada**.

- Formato de plan `crew.plan/v1` (YAML o JSON) con título, brief, criterios,
  metodología, no-objetivos, entrega y dependencias por tarea.
- `crew plan validate` comprueba el esquema, los criterios obligatorios, las
  dependencias y los ciclos, y devuelve los grupos de ejecución (qué se puede
  hacer en paralelo) y el aviso de coste cuando una capa es grande.
- `crew plan apply` crea las tareas, registra las dependencias y puede
  encolarlas (`--queue`).
- El motor respeta las dependencias: el daemon no toma una tarea con
  dependencias pendientes y una dependencia fallida la bloquea.
- La confirmación antes de aplicar (petición ambigua, destructiva, secretos,
  producción o merge) la pide el capitán con la plantilla `AGENTS.md`.

Referencia: ADR 0017.

### 3.4 Supervisión y estado

Estado: **completada**.

- Política de ejecución declarativa en la configuración global
  (`scheduling.concurrency` y `scheduling.mode`), con el flag `--concurrency`
  como override.
- En modo `serial` el daemon no ejecuta a la vez dos tareas del mismo
  proyecto; en modo `parallel` sí.
- `crew progress <id>` informa del avance en lenguaje natural: etapa,
  intento, tiempo transcurrido, riesgo, verificación, CI, eventos recientes y
  qué toca ahora (en cola, en backoff, esperando dependencias, necesita
  respuesta, bloqueada, lista para revisión o fallida con su motivo).
- El briefing del capitán mantiene la lista `attention` con las decisiones
  reales; el resto se consulta bajo demanda.
- El estado se recupera tras reiniciar la sesión o el daemon desde SQLite.

Referencia: ADR 0018.

### 3.5 Merge y aceptación conversacional

Estado: **completada**.

- `crew task merge <id>` evalúa las puertas: tarea en `review`, tester
  aprobado, verificación en verde, CI en verde (si hay resultado registrado),
  PR abierto, no draft y mergeable.
- Si falta algo falla con `MERGE_BLOCKED` y enumera qué falta y por qué; la
  tarea se queda en `review`.
- Si todo está en orden, mergea el PR con el método de la política del proyecto
  (`--method` lo sobrescribe) y acepta la tarea, guardando el artefacto
  `merge` y el evento `merge.completed`.
- La autorización se registra en el event log con el evento `task.authorized`
  (actor, acción y resultado de cada puerta).
- `--accept-only` acepta sin tocar el PR, para proyectos sin GitHub.

Referencia: ADR 0019.

### 3.6 Demo de aceptación

Estado: **completada** (con el agente falso; el mismo flujo con `opencode`
real es el último paso manual de la fase).

La demo está automatizada en `test/e2e/acceptance.test.ts` y recorre el flujo
completo:

1. El usuario proporciona un repositorio y dos cambios.
2. El capitán comprueba el toolchain y pide consentimiento si falta algo.
3. Clona y registra el proyecto.
4. Crea dos tareas con criterios de aceptación (un plan).
5. Ejecuta los workers en worktrees aislados, en paralelo.
6. Reporta cada tarea con riesgo y estado de CI.
7. El usuario dice “mergea” y el capitán aplica la política correcta.
8. Un reinicio a mitad del flujo no pierde tareas ni decisiones.

Además, `Store.acquireLease` toma el lease de un proceso muerto (mismo host),
así que un daemon que muere se recupera sin esperar al TTL.

Referencia: ADR 0020.

## Fase 4 — Runtime visible y escala

Estado: **completada**.

Queda fuera del núcleo del roadmap, como mejora posterior, mover también la
base de datos y las forjas al host remoto.

- Sesiones visibles en tmux/PTY, con capacidad de observar o intervenir.
  **Completada** (ADR 0023): `task run --session tmux` ejecuta el agente en una
  sesión `crew-<taskId>-<rol>` observable e intervenible, con la salida
  capturada en el log del run; `crew sessions list|kill` las gestiona.
- Workers en hosts remotos alcanzables por SSH. **Completada** (ADR 0026 y
  ADR 0028): un proyecto declara `runner.host` y el agente y la verificación se
  ejecutan por `ssh`. Con `runner.repo_path`, además, el worktree, el commit y
  el push ocurren en el host remoto; sin él, el worktree tiene que ser visible
  desde el host remoto.
- Memoria de proyecto para no repetir contexto entre sesiones. **Completada**
  (ADR 0021): notas durables por proyecto que llegan al brief de cada agente y
  al briefing del capitán.
- Tareas de investigación (`scout`) con informes independientes.
  **Completada** (ADR 0022): el modo `scout` es un recorrido propio del
  pipeline (sin verificación, tester, commit ni PR) que termina en `review`
  con un informe `crew.report/v3` guardado como artefacto `scout`, y
  `crew scout` lo crea en una línea.
- UI web o servicio del sistema. **Completada** (ADR 0025 y ADR 0027): `crew ui`
  sirve un panel de solo lectura (resumen, tareas, eventos) en `127.0.0.1`, sin
  dependencias externas, y `crew service install|status|uninstall` despliega el
  daemon como servicio del usuario (launchd en macOS, systemd --user en
  Linux), sin sudo y con reinicio automático.
- Soporte de más forges además de GitHub. **Completada** (ADR 0024): una
  interfaz `Forge` con implementaciones de GitHub (`gh`) y GitLab (`glab`);
  el motor, el merge conversacional y `task accept` ya no hablan con `gh`
  directamente. El gate de CI sigue siendo de GitHub Actions.

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
- ADR 0012: scheduler concurrente del daemon.
- ADR 0013: evaluación de riesgo y resumen de estado.
- ADR 0014: reintentos automáticos con backoff.
- ADR 0015: capa de capitán con instrucciones y briefing.
- ADR 0016: intake de proyecto con clonado y consentimiento.
- ADR 0017: planes de tareas con dependencias.
- ADR 0018: política de ejecución y reporte de progreso.
- ADR 0019: merge conversacional con puertas.
- ADR 0020: demo de aceptación y toma de leases muertos.
- ADR 0021: memoria de proyecto.
- ADR 0022: tareas scout.
- ADR 0023: sesiones visibles.
- ADR 0024: capa de forjas.
- ADR 0025: UI web de solo lectura.
- ADR 0026: workers remotos por SSH.
- ADR 0027: el daemon como servicio del sistema.
- ADR 0028: workspace remoto con worktree, commit y push en el host remoto.
- ADR 0029: observabilidad y diagnóstico del workspace remoto.
