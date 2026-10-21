# ADR 0021 — Memoria de proyecto durable

Estado: aceptada.

## Contexto

La Fase 4 pide "memoria de proyecto para no repetir contexto entre sesiones".
Hoy, cada sesión del capitán empieza de cero: si el usuario explica que el
proyecto usa pnpm y nunca npm, o que hay una trampa con el worktree de Windows,
esa información se pierde al terminar la tarea. Peor: los agentes tampoco la
reciben, así que cada tarea vuelve a descubrir las mismas convenciones.

## Decisión

1. **Memoria durable en SQLite.** La tabla `memories` guarda una nota por
   proyecto con `kind` (`convention`, `decision`, `pitfall`, `glossary`,
   `context`), `title`, `body`, `source` (`captain`, `user`, `agent`), la tarea
   de la que salió (si la hubo) y sus marcas de tiempo. Cada alta y cada baja
   queda en el event log (`memory.added`, `memory.removed`).

2. **La memoria llega a los agentes.** El brief de cada run incluye una sección
   "Project memory" con las notas del proyecto. Es el punto clave: la memoria no
   solo evita que el capitán repita contexto, también evita que cada agente
   invente sus propias convenciones. Se presenta como contexto, nunca como
   instrucciones que anulen la tarea o sus criterios de aceptación.

3. **La memoria llega al capitán.** `crew --json captain brief` incluye la
   memoria del proyecto (o de todos los proyectos), de modo que el capitán
   empieza la sesión sabiendo lo que ya se decidió.

4. **Quién la escribe.** La escribe el capitán o la persona, de forma
   explícita: `crew memory add --project <ref> --kind <kind> --title <t> --body
   "<texto>"`. El motor no extrae memoria automáticamente: deducirla de los
   reportes añadiría ruido y decisiones silenciosas.

5. **Es editable y caducable.** `crew memory list` y `crew memory rm` permiten
   revisarla y quitarla cuando deja de ser cierta.

## Consecuencias

- Una sesión siguiente no repite lo que ya se sabe y los agentes trabajan con
  las convenciones del proyecto desde el primer prompt.
- La memoria es explícita y auditable: se puede leer, corregir y borrar.
- Sigue siendo del tamaño del motor: una tabla más y una sección más en el
  brief.

## Alternativas descartadas

- Un archivo de notas en el repositorio: no se versiona con el estado del
  proyecto y complica saber qué es del usuario y qué del agente.
- Extraer la memoria de los reportes automáticamente: produce duplicados y
  decisiones implícitas que nadie ha revisado.
- Incluir la memoria en el prompt del sistema del harness: la capa de brief es
  el punto donde ya vive el contexto de la tarea.
