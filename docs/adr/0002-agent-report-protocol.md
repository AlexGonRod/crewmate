# ADR 0002: Protocolo de reporte `crew.report/v1`

## Contexto

Un harness solo debe poder terminar una tarea si demuestra qué hizo y cómo lo
verificó. Al mismo tiempo, el protocolo debe funcionar con agentes distintos y
con herramientas que no pueden ejecutar el CLI de crew.

## Decisión

Definir un esquema JSON versionado, validado con Ajv, con dos vías de entrega:

1. `crew report --task <id> --run <id> --file <json>`.
2. Un fichero JSON en `CREW_REPORT_PATH`, dentro del worktree.
3. Fallback opcional: un bloque ` ```crew-report ` al final de la salida.

Estados permitidos: `done`, `failed`, `blocked`, `needs_input`, `progress`.

Reglas:

- `done` mueve la tarea a `done`; `needs_input` a `waiting_input`; `blocked` a
  `blocked`; `failed` a `failed`.
- `progress` no termina la tarea.
- Un run sin reporte terminal se marca `failed`.
- El reporte se redacta antes de persistirse para evitar secretos.

## Consecuencias

- El ciclo de vida depende de evidencia, no de la salida del proceso.
- Los agentes pueden reportar sin acceso al CLI si escriben el fichero.
- Cambios de formato requieren una nueva versión del esquema.
