# ADR 0023 — Sesiones visibles: ejecutar el agente en tmux

Estado: aceptada.

## Contexto

La Fase 4 pide "sesiones visibles en tmux/PTY, con capacidad de observar o
intervenir". Hoy el agente corre como un proceso hijo: su salida va a un log y a
la consola de quien lanzó el daemon. Si el agente se atasca, pide una decisión
interactiva o simplemente tarda, la persona no puede ver qué está pasando ni
intervenir.

El motor ya sabe todo lo necesario (comando, argumentos, entorno, directorio,
timeout, cancelación), así que la sesión visible no necesita un agent
distinto: es otra forma de lanzar el mismo comando.

## Decisión

1. **Un backend de sesión en `tmux`.** `src/app/session.ts` crea una sesión
   `crew-<taskId>-<rol>` con el comando del agente, con `remain-on-exit` activo
   para que el pane quede disponible con su salida después de terminar. El
   motor espera a que el pane muera y lee su código de salida
   (`#{pane_dead_status}`).

2. **La salida sigue siendo la misma.** El contenido del pane se captura y se
   escribe en el log del run, de modo que el reporte se puede parsear desde el
   output igual que en el modo normal. El stdin del agente se redirige al
   fichero de brief, que ya existe en el worktree.

3. **Se elige, no se impone.** `task run --session tmux` ejecuta el agente en
   una sesión visible; el daemon puede propagarlo con `--session tmux`. Sin el
   flag, el comportamiento es el de siempre.

4. **La persona puede intervenir.** Con la sesión viva,
   `tmux attach -t crew-<taskId>-developer` muestra el agente en marcha y
   permite interrumpirlo. `crew sessions list` muestra las sesiones del
   proyecto, su estado y el comando exacto para conectarse; `crew sessions kill
   <nombre>` las cierra.

5. **Las sesiones se limpian a mano.** Al terminar, la sesión queda con su
   salida para poder revisarla; el usuario la cierra cuando ya no la necesita.
   El motor no las borra automáticamente para no perder el contexto visible.

## Consecuencias

- El agente se puede observar e intervenir sin cambiar el motor.
- La cancelación y el timeout funcionan igual: si el run se aborta, la sesión
  se mata.
- Requiere `tmux` en la máquina; sin él, el motor sigue funcionando en modo
  normal y `crew sessions list` lo indica.

## Alternativas descartadas

- Una PTY propia del motor: mucho más código (gestión de terminal, resize,
  teclas) para recrear lo que tmux ya hace y además se puede observar desde
  fuera.
- Un servidor de streaming de la salida: obliga a la persona a mirar la
  consola de `crew` en lugar de una terminal aparte.
- Grabar y reproducir la sesión: no permite intervenir en vivo.
