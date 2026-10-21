# ADR 0018 — Política de ejecución y reporte de progreso en lenguaje natural

Estado: aceptada.

## Contexto

El daemon growaba por su cuenta (concurrencia 1) y el captain no tenía una
forma de preguntar "cómo va esto" sin leer el event log a mano. Además, con N
tareas en paralelo, dos tareas del mismo proyecto pueden pisarse: las ramas y
los worktrees son independientes, pero el repositorio principal es el mismo.

Fase 3.4 pide lanzar tareas según la política del proyecto, reportar avances sin
inundar de logs y escalar solo las decisiones reales.

## Decisión

1. **Política de ejecución en la configuración global.** La configuración de
   `crew` admite:

   ```yaml
   scheduling:
     concurrency: 2
     mode: serial
   ```

   `concurrency` es el número máximo de tareas simultáneas y `mode` decide si
   dos tareas del mismo proyecto pueden correr a la vez. Por defecto
   `concurrency: 1` y `mode: serial`, que es el comportamiento actual.

   Precedencia: `--scheduling serial|parallel` fija el modo de forma
   explícita; si no se pasa, `--concurrency N` implica modo `parallel` (quien
   pide N tareas a la vez las quiere en paralelo); si no se pasa ninguno, manda
   la configuración global.

2. **Modo serial por proyecto.** En modo `serial` el daemon excluye del
   scheduler los proyectos que ya tienen una tarea en marcha, de modo que dos
   tareas del mismo repositorio nunca se ejecutan simultáneamente. En modo
   `parallel` no hay esa restricción.

3. **`crew progress <id>`.** Devuelve el estado de la tarea en lenguaje
   natural: en qué etapa está, qué intento es, cuánto tiempo lleva, su riesgo,
   su verificación y su CI, los eventos recientes y, sobre todo, **qué toca
   ahora**: si espera en la cola, si está en backoff, si depende de otra tarea,
   si necesita una respuesta, si está bloqueada, si está lista para revisión o
   si ha fallado (con el motivo). Es la respuesta que el capitán da al usuario
   sin volcar logs.

4. **Escalado solo de decisiones reales.** El briefing del capitán mantiene la
   lista `attention` con `waiting_input`, `blocked`, `review` y `failed`, y
   cada tarea en review indica si su PR está listo. El resto del estado se
   consulta bajo demanda con `crew progress`.

5. **Recuperación tras reinicio.** El estado vive en SQLite: el daemon
   reconcilia los runs perdidos al arrancar y el capitán recupera el contexto
   con `crew status` o `crew --json captain brief`, sin depender de la sesión
   anterior.

## Consecuencias

- La política de ejecución es declarativa y global, con override por comando.
- Las tareas del mismo proyecto no se pisan por defecto, y el modo `parallel`
   sigue disponible para repositorios con repos separados.
- El capitán tiene una respuesta corta y accionable por tarea, no un volcado
  de eventos.

## Alternativas descartadas

- Dejar la política solo en los flags: obligaría al usuario a repetirla en
  cada arranque del daemon.
- Serializar todo el sistema: impediría el paralelismo entre proyectos, que es
  justo donde el trabajo sí es independiente.
- Un canal de progreso en vivo: obligaría al núcleo a mantener estado de
  suscripción; el patrón de consultar el estado es más simple y suficiente.
