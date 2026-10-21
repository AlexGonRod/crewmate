# ADR 0015 — Capa capitán como instrucciones y briefing, no como lógica

Estado: aceptada.

## Contexto

La Fase 3 pide un capitán conversacional: una persona habla y un agente dirige
el trabajo. El núcleo de `crew` es determinista y verificable, así que no
conviene meter un bucle de lenguaje natural dentro del motor. La opción
recomendada desde el ADR 0009 es que el capitán sea una sesión de `opencode`
con instrucciones (`AGENTS.md`) que opera la CLI.

Faltaban dos piezas para que esa sesión sea útil:
instrucciones instalables en el repositorio del usuario y un contexto compacto
que el capitán pueda leer antes de decidir.

## Decisión

1. **Instrucciones instalables.** `crew captain init` escribe un `AGENTS.md` en
   el repositorio actual con las reglas del capitán: todo cambio pasa por
   `crew task create`/`run`, nunca se editan los worktrees, se consulta el
   estado antes de actuar, se escala solo lo que requiere autoridad humana y no
   se mergea sin comprobar política, CI, verificación y veredicto del tester.
   Sin `--force` no sobrescribe un `AGENTS.md` existente.

2. **Briefing compacto.** `crew captain brief` devuelve un único objeto JSON
   con: proyectos registrados (rama por defecto, forge, entrega, política de
   auto-merge, CI y comandos de verificación), conteo de tareas por estado, runs
   activos, lease del daemon, las tareas recientes con su `TaskSummary` (riesgo,
   CI, verificación, tester, PR) y una lista `attention` con lo que requiere
   decisión humana: `waiting_input`, `blocked`, `review` y `failed`.

3. **El capitán no escribe código.** El núcleo sigue siendo el único que toca
   los repositorios de trabajo. La capa capitán solo compone comandos de la
   CLI y valida su salida antes de informar.

4. **El briefing es parte del contrato.** Al ser el mismo `TaskSummary` que
   usan el daemon y `task show`, el capitán ve exactamente los mismos datos que
   el resto del sistema, sin un segundo modelo de verdad.

## Consecuencias

- El capitán se puede instalar en cualquier repositorio con un comando y
  empieza a trabajar con el mismo modelo de datos del motor.
- `attention` evita que el capitán inunde al usuario con el estado de todo:
  solo se escala lo accionable.
- El núcleo no crece: la capa capitán son instrucciones más un lector de
  estado.
- La conversación y las decisiones quedan en el event log del motor, así que el
  estado se recupera tras reiniciar la sesión.

## Alternativas descartadas

- Un comando `crew chat` con bucle LLM propio: duplicaría la lógica del
  agente y quitaría la trazabilidad del event log.
- Un parser de lenguaje natural dentro del núcleo: harder to test and violates
  the deterministic-core principle.
- Un canal de eventos push para el capitán: el polling de un briefing es
  suficiente y no añade estado al motor.
