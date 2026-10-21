# ADR 0031 — Sesiones visibles en tmux o en Herdr

Estado: aceptada. Complementa al ADR 0023.

## Contexto

El ADR 0023 dio al crew sesiones visibles para poder observar o intervenir a un
agente mientras trabaja, con tmux como implementación. tmux cumple: la sesión
sobrevive al cierre de la terminal.

Pero el entorno de trabajo ha cambiado. Herdr es un multiplexor pensado para
agentes: mantiene los panes vivos en un servidor de fondo, sabe si el agente
está `working`, `blocked`, `done` o `idle`, avisa cuando un agente termina o
necesita una decisión, y expone todo eso por CLI y por socket API. Además
habla con opencode, que es justo el harness que el crew usa.

La pregunta no es "herdr o tmux", sino "qué necesita el crew de un
multiplexor".

## Decisión

1. **La capa de sesiones es una interfaz, no un tmux.** `SessionBackend` define
   lo que el crew necesita: arrancar un comando en una sesión con nombre,
   capturarlo, saber si terminó y con qué código, matarlo y listarlas. Hay
   una implementación de tmux y otra de Herdr.

2. **`--session` elige el backend: `tmux`, `herdr` o `auto`.** `auto` usa
   Herdr si su servidor está corriendo y cae a tmux si no. El default es
   `auto`: el crew funciona en los dos mundos y no obliga a instalar nada.

3. **Una sesión de Herdr es un workspace etiquetado con el nombre de la
   sesión, cuyo pane raíz ejecuta el agente.** El nombre de la sesión es
   `crew-<taskId>-<rol>`, el mismo que en tmux, así que `crew sessions list` y
   `crew sessions kill` no cambian de semántica.

4. **El comando no se escribe en el terminal, se escribe en un fichero.** El
   comando del agente lleva el entorno entero delante y puede pesar varios
   kilobytes; una línea de terminal tiene un límite (unos 4 KiB en macOS) y se
   trunca. El crew escribe un script `session.sh` y el pane ejecuta
   `sh session.sh`.

5. **El código de salida lo escribe el propio comando.** Herdr no guarda el
   estado de salida de un proceso que ya terminó, así que el script ends con
   `printf '%s' "$?" > <exit>`. El crew lo lee igual que el informe del agente.

6. **El estado del agente se muestra, no se adivina.** Herdr clasifica cada
   pane como `working`, `blocked`, `done`, `idle` o `unknown`, y el crew lo
   enseña en `crew sessions list`. Con tmux, la fila solo puede decir
   "running" o "finished".

7. **El resto del motor no cambia.** El agente, la verificación, el informe,
   el commit, el gate y el daemon son los mismos. Cambiar de backend es
   cambiar dónde se ve el agente, no cómo se ejecuta la tarea.

## Consecuencias

- El crew convive con el multiplexor que la persona ya usa: si el trabajo vive
  en Herdr, los agentes del crew aparecen en la misma ventana, con su estado
  en la barra lateral, y se pueden intervenir desde el TUI.
- `blocked` es información nueva y valiosa: un agente que necesita una
  decisión se distingue de uno que está trabajando.
- Herdr es un proyecto joven (0.9.x) y su CLI cambia; el crew habla con él a
  través de un adaptador thin, y si el servidor no está corriendo falla con un
  mensaje claro en vez de colgarse.
- El backend de tmux se mantiene: es el que funciona en un servidor sin
  Herdr, y sigue siendo el que usan los tests.

## Alternativas descartadas

- **Sustituir tmux por Herdr sin más**: obliga a instalar Herdr y tener su
  servidor corriendo; el crew se quedaría sin sesiones visibles en un
  entorno normal.
- **Integrar el estado de Herdr en la base de datos**: el motor guardaría
  "el agente está bloqueado" y lo expondría en el panel web. Requiere un
  proceso que escuche el socket de Herdr; es una fase propia, no un añadido
  al backend de sesiones.
- **Usar `herdr agent start`**: sirve para agentes interactivos con un prompt;
  el agente del crew es un proceso con un brief por entrada estándar, así que
  la primitiva correcta es `pane run`.
