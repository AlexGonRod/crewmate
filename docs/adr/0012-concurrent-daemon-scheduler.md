# ADR 0012: Scheduler concurrente del daemon

## Contexto

El daemon de la Fase 1 ejecutaba una sola tarea cada vez. El lease global y la
reconciliación ya evitaban dos daemons sobre la misma base de datos, pero una
tarea lenta bloqueaba toda la cola. La Fase 2 necesita N tareas en paralelo sin
compartir worktree, rama, run ni estado, manteniendo N = 1 como valor seguro por
defecto.

## Decisión

- `daemon run --concurrency <n>` ejecuta hasta N tareas a la vez. El valor por
  defecto es 1; `--once` fuerza 1 porque su contrato es procesar una sola tarea.
- El scheduler mantiene un conjunto en memoria de tareas activas y consulta la
  cola por prioridad descendente y `created_at` ascendente excluyendo esas
  tareas. Cada tarea conserva su worktree, rama, run y artefactos.
- `runPipeline` adquiere un lease `task:<id>` antes de tocar el worktree o el
  estado. Si otro proceso ya lo tiene, falla con `TASK_LEASED` sin modificar la
  tarea. El lease se renueva cada 10 s y se libera al terminar, también en caso
  de error. Así un `task run` manual y el daemon no ejecutan la misma tarea.
- Si el daemon encuentra `TASK_LEASED`, deja la tarea en cola y aplica un
  cooldown de un intervalo antes de reintentarla, para no girar en vacío ni
  robar el trabajo a otro proceso. `--once` termina con `idle` en ese caso.
- El lease global del daemon sigue siendo el de la base de datos. Se mantiene
  mientras haya tareas activas y se libera solo después de esperar a que todas
  terminen o sean abortadas.
- `maxTasks` limita cuántas tareas se lanzan, no cuántas terminan. El daemon deja
  de admitir trabajo al alcanzar el límite y drena las activas antes de salir con
  `stopped: max_tasks`.
- La cancelación propaga `AbortSignal` a los procesos de agente, comandos de
  verificación y espera de CI. Al abortar se termina el grupo de proceso de cada
  run activo, se espera a que el pipeline registre el fallo y las tareas que aún
  no habían empezado permanecen `queued`.
- La reconciliación de runs perdidos sigue ejecutándose en cada ciclo y cubre
  también a las tareas concurrentes.

## Alternativas descartadas

- **Concurrencia ilimitada**: sin un límite explícito, una cola grande puede
  saturar CPU, memoria y límites del forge.
- **Marcar `queued -> starting` al seleccionar**: deja tareas colgadas si el
  daemon muere entre la selección y la creación del run, y complica la
  reconciliación.
- **Confiar solo en el lease global**: no protege frente a un `task run` manual
  concurrente, que puede compartir la misma base de datos.
- **Fallar la tarea cuando otro proceso la tiene**: convierte una colisión
  transitoria en un fallo permanente y pierde trabajo válido.
- **Esperar al proceso sin `AbortSignal`**: el apagado ordenado se bloquea hasta
  el timeout de la tarea o del CI.

## Consecuencias

- El daemon usa más recursos solo cuando se pide explícitamente N > 1.
- El orden de finalización y de `onTask` ya no coincide necesariamente con el
  orden de la cola; los tests y consumidores no deben asumirlo.
- Sigue habiendo un solo daemon por base de datos. La concurrencia es entre
  tareas, no entre workers de distintos hosts.
- Un proceso externo que retenga el lease de una tarea la mantiene fuera del
  daemon hasta que expire o termine; el cooldown evita un bucle de reintentos.
