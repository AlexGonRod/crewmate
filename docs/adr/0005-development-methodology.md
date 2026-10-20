# ADR 0005: Metodología de desarrollo declarativa y verificable

## Contexto

La Fase 0 permitía briefs libres y aceptaba reportes con tests autodeclarados. El
brief describía el objetivo, pero no imponía cómo trabajar ni exigía evidencia
estructurada. Eso hace imposible distinguir un agente que siguió un proceso
disciplinado de otro que solo declaró `done`.

## Decisión

Introducir una metodología por tarea con tres perfiles:

- `free`: comportamiento compatible con la Fase 0. Reporte `crew.report/v1` o v2.
- `spec`: SDD-lite. Exige una spec `crew.spec/v1` con criterios de aceptación y
  un reporte `crew.report/v2` con evidencia por criterio.
- `tdd`: añade a `spec` el ciclo rojo→verde→refactor. Para `done` exige al menos
  un test con `phase: red` y otro con `phase: green`.

Resolución: `--methodology` de la tarea > `methodology` del proyecto > `free`.
`crew init` escribe `methodology: spec` para proyectos nuevos; las
configuraciones existentes sin la clave siguen resolviendo a `free`.

La spec se guarda como JSON en `tasks.spec_json` y se expone al agente en
`.crew/spec.json` mediante `CREW_SPEC_PATH`. El brief se renderiza a partir de
la spec; no hay dos fuentes de verdad.

## Enforcement

La validación de evidencia se ejecuta en `Store.recordReport`, el único punto de
entrada para reportes (`task run` y `crew report`). Si un reporte `done` no cubre
todas las acceptance criteria, o un reporte `tdd` no incluye las fases `red` y
`green`, se lanza `REPORT_INCOMPLETE` y la tarea termina en `failed`. No hay
modo de aviso: la evidencia incompleta falla.

## Consecuencias

- La metodología deja de ser decoration en el prompt: afecta al contrato y al
  ciclo de vida.
- Los agentes deben emitir reportes v2 para tareas `spec`/`tdd`; v1 sigue
  válido para tareas `free`.
- La evidencia del reporte sigue siendo autodeclarada, pero los comandos
  `verify` se ejecutan de forma independiente desde el orquestador (ADR 0008).
- `--methodology free` es el escape hatch para tareas sin tests o sin criterios
  formales.
- Cambios futuros en spec o reporte requieren una nueva versión de esquema.
