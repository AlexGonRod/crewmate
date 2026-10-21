# ADR 0020 — Demo de aceptación de la Fase 3 y toma de leases muertos

Estado: aceptada.

## Contexto

La Fase 3 se cierra cuando el flujo completo funciona de extremo a extremo: un
repositorio, dos cambios, workers en worktrees aislados, un informe con riesgo y
CI, una autorización de merge y ninguna tarea perdida aunque el daemon muera a
mitad del flujo.

Al automatizar esa demo apareció un problema de recuperación: cuando el daemon
muere de golpe, su lease sigue vigente hasta su TTL (30 s). Durante ese
intervalo, ningún daemon nuevo puede arrancar, aunque el proceso que lo
detentaba ya no exista. La recuperación tras reinicio quedaba bloqueada por un
proceso fantasma.

## Decisión

1. **La demo de aceptación es un test end-to-end.**
   `test/e2e/acceptance.test.ts` recorre el flujo completo con el agente
   falso: registra el proyecto, valida y aplica un plan con dos tareas, las
   ejecuta con concurrencia 2 en worktrees aislados, comprueba el resumen con
   riesgo y CI, acepta las tareas con `crew task merge --accept-only` y
   verifica que la autorización queda en el event log.

2. **Un reinicio a mitad del flujo no pierde tareas.** La segunda parte de la
   demo mata al daemon y a su agente mientras una tarea está en marcha,
   ejecuta `crew daemon reconcile --requeue` y comprueba que la tarea se
   reencola y se completa después. El criterio de la Fase 3 queda cubierto por
   una prueba, no por una promesa.

3. **Se puede tomar el lease de un proceso muerto.** `Store.acquireLease`
   comprueba el propietario del lease: si el `owner` tiene el formato
   `host:pid` y el host es esta máquina, se comprueba si el proceso sigue
   vivo. Si está muerto, el lease se libera y se puede tomar de inmediato, sin
   esperar al TTL. Un lease de un proceso vivo nunca se toma, y un lease de
   otra máquina se respeta hasta que expira.

4. **El estado sigue siendo la fuente de verdad.** La demo no necesita estado
   en memoria: todo se reconstruye desde SQLite, así que un reinicio de la
   sesión del capitán o del daemon no pierde tareas ni decisiones.

## Consecuencias

- Un daemon que muere se recupera en segundos en lugar de esperar al TTL.
- La Fase 3 tiene un criterio de aceptación verificable en la CI.
- La comprobación de vida del proceso solo aplica al mismo host: los leases
  remotos siguen dependiendo del TTL.

## Alternativas descartadas

- Reducir el TTL del lease: seguiría habiendo una ventana y menos margen para
  un daemon lento.
- Forzar el lease con un comando manual: añade una operación manual que hay que
  recordar justo cuando el sistema está roto.
- Un heartbeat más frecuente: reduce la ventana, no la elimina.
