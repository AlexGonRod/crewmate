# ADR 0006: Daemon con lease y reconciliación de runs

> Actualizado por ADR 0012: el daemon puede ejecutar N tareas en paralelo. El
> lease global, la cola y la reconciliación se mantienen; la ejecución ya no es
> necesariamente secuencial.

## Contexto

La Fase 1 necesita ejecutar tareas en cola sin intervención manual y detectar
runs que quedaron activos porque su proceso murió. No hay infraestructura
distribuida ni un servicio del sistema; la fuente de verdad es SQLite y varios
comandos CLI pueden compartir la misma base de datos.

## Decisión

- **Un daemon por base de datos** mediante la tabla `leases`. El owner es
  `host:pid`, el TTL por defecto es 30 s y se renueva con un heartbeat cada
  `TTL/3`, también durante tareas largas. Si el lease está ocupado, se falla con
  `DAEMON_RUNNING`.
- **Ejecución en proceso**: originalmente secuencial; desde el ADR 0012 el
  daemon toma hasta N tareas `queued` (prioridad descendente, `created_at`
  ascendente) y llama a `runPipeline` dentro del mismo proceso. El agente sigue
  corriendo en su propio grupo de procesos y su PID queda registrado en `runs`.
- **Cola explícita**: `task create` deja la tarea en `draft`; `task queue` la
  pasa a `queued`. Un fallo de arranque del daemon (`runPipeline` lanza) marca la
  tarea como `failed` para evitar un bucle de reintentos.
- **Reconciliación**: al arrancar y en cada ciclo se revisan los runs activos.
  Un run con PID muerto se marca `lost`; un run sin PID se considera perdido
  solo tras `--stale-after` (30 s por defecto). La tarea asociada pasa a
  `failed` con el motivo. `task retry` es la única forma de reencolarla.
- **Parada ordenada**: `SIGINT`/`SIGTERM` activan un `AbortSignal`, terminan el
  grupo de proceso del run activo y esperan a que `finishRun` registre el fallo.

## Consecuencias

- La supervisión y la recuperación son verificables sin añadir otro proceso ni
  otro estado: todo está en SQLite y en el event log (`run.lost`, `task.failed`).
- No hay reencolado automático, así que un agente roto no genera bucles.
- Si el daemon muere de forma abrupta, el agente puede quedar huérfano y la
  tarea se falla en la siguiente reconciliación en lugar de recuperarse.
- El modelo es de un solo host y un solo daemon; el trabajo futuro incluye
  workers separados, backoff y un servicio del sistema.
