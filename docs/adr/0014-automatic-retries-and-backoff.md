# ADR 0014 — Reintentos automáticos, backoff y recuperación tras reinicio

Estado: aceptada.

## Contexto

Hasta la Fase 2.6, un fallo de agente (crash, timeout, salida sin reporte) o la
pérdida de un run tras reiniciar la máquina dejaban la tarea en `failed` de
forma definitiva. Solo un humano podía reencolarla con `task retry`, y el
daemon no distinguía entre un fallo permanente (una spec inválida, una política
de merge ausente, un reporte malformado) y uno transitorio (el agente se
murió, el proceso se perdió).

Con N tareas en paralelo, dejar una tarea caída bloquea el resultado esperado
del lote sin que nada explique por qué ni cuándo volverá a intentarse.

## Decisión

1. **Clasificación de fallos.** `src/app/retry.ts` decide si un error admite
   reintento. Los `CrewError` con código de configuración o protocolo
   (`REPORT_INVALID`, `SPEC_REQUIRED`, `MERGE_POLICY_REQUIRED`,
   `CI_REQUIRED_FOR_AUTO_MERGE`, `INVALID_TASK`, `HARNESS_NOT_FOUND`, …) son
   permanentes; el resto, incluidos los errores inesperados, se consideran
   transitorios. Un CI fallido nunca se reintenta: es un resultado real.

2. **Backoff exponencial.** `src/core/backoff.ts` calcula
   `base * 2^(intento - 1)` con tope de 15 minutos. La base por defecto son
   60 s.

3. **Estado persistido.** La tabla `tasks` incorpora `attempts`,
   `next_attempt_at`, `last_error` y `retryable` (migración de esquema v5, con
   `ALTER TABLE` para bases existentes). `next_attempt_at` es lo que permite
   que la cola ignore una tarea que todavía espera su turno.

4. **Reintentos en el daemon.** `daemon run --max-attempts <n>` fija el número
   máximo de intentos por tarea; por defecto 1, es decir, sin reintentos
   automáticos. `--backoff <segundos>` fija la base del retardo. Cuando un
   intento falla con un error transitorio y quedan intentos, el daemon reencola
   la tarea con `task.requeued` (evento con motivo, retardo e intento) en lugar
   de dejarla en `failed`. El resultado por tarea incluye `attempt` y
   `retryInMs`.

5. **Recuperación tras reinicio.** `reconcileStaleRuns` acepta `requeue`,
   `maxAttempts` y `backoffMs`. Con reintentos habilitados, un run perdido
   (daemon o máquina reiniciados) reencola la tarea en lugar de fallarla, y el
   trabajo continúa sobre el mismo worktree y la misma rama. El daemon aplica
   esta política al arrancar; `daemon reconcile --requeue` permite hacerlo a
   mano.

6. **Nada de reintentos ciegos.** El número de intentos, el retardo y el
   resultado de cada intento quedan en el event log, y `crew status` muestra
   cuántas tareas esperan su backoff.

## Consecuencias

- Un fallo de agente no termina el lote: la tarea vuelve a la cola con un
  retardo creciente y un límite explícito.
- Los fallos permanentes no se repiten, así que un error de configuración sigue
  siendo visible de inmediato.
- La recuperación tras reinicio conserva el trabajo ya hecho en el worktree y
  en la rama de la tarea.
- El reintento consume un lanzamiento del daemon: `--max-tasks` cuenta
  lanzamientos, no tareas distintas.

## Alternativas descartadas

- Reintentar dentro del pipeline: mezclaría la política de reintentos con el
  flujo de una tarea y impediría que el daemon controlase el ritmo global.
- Backoff fijo: castiga igual un fallo momentáneo y uno persistente.
- Reintentar también los fallos de CI o de política: son resultados
  deterministas y volver a ejecutarlos no aporta información.
