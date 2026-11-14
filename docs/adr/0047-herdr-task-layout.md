# ADR 0047 — Tab de Herdr por tarea: 3 panes (developer/tester/reviewer)

Estado: aceptada.

## Contexto

Con el modo interactivo (ADR 0031, punto 8) cada run abría su propio tab en el
workspace compartido `crew-sessions`: el developer, el tester y el reviewer de
una misma tarea vivían en tabs separados, y el reviewer (ADR 0046) abría otro
tab más al entrar en review. Para seguir una tarea había que saltar entre
cuatro tabs, y la relación entre los agentes de la misma tarea no se veía.

## Decisión

Con backend Herdr e interactive, una tarea usa **un tab con 3 panes**:

- columna izquierda dividida en 2 panes horizontales: el agente de developer
  (pane superior) y el de tester (pane inferior), ambos interactivos;
- columna derecha, de altura completa, reservada para el reviewer: al entrar
  en review el crew abre ahí el pane del plugin de review (ADR 0046).

La geometría se construye con dos splits en este orden (Herdr divide el pane
que recibe): primero `pane split --direction right` desde el pane raíz (la
columna derecha), después `pane split --direction down` sobre el raíz (la
columna izquierda). Todos los comandos llevan `--no-focus`: el foco del pane
que llama no cambia. El tab se crea con `cwd` = worktree de la tarea.

La topología vive en un estado por tarea (`<sessions>/layout-<taskId>.json`)
con los ids de tab y de los tres panes. El run de developer crea el layout; el
run de tester lo reutiliza y arranca su agente en el pane inferior. Si el tab
ya no existe, se reconstruye (nunca se apila un segundo tab para la misma
tarea). Al entrar en review, el crew abre el pane del plugin dividiendo el
placeholder de la columna derecha y cierra el placeholder, de forma que el
pane del plugin hereda la columna completa; si falla, cae al placement de tab
independiente de ADR 0046.

Un fin de run correcto (informe válido y agente settled) deja el agente `idle`
en su pane y el tab vivo: el reviewer necesita el layout y la persona puede
leer la conversación. Un fallo, bloqueo o timeout cierra el pane (y con él el
agente), y el tab solo cuando ningún otro run de la tarea lo usa. El backend
tmux no cambia; el resto del motor (leases, event log, pipeline) tampoco.

## Consecuencias

- Una tarea se sigue entera en un tab: los tres agentes están visibles con su
  estado real (`working`, `blocked`, `idle`) y se pueden intervenir a mano.
- El foco del calling pane nunca cambia durante la creación del layout.
- Los estados por run siguen en `<sessions>/<name>.json`; el layout es un
  fichero más en el mismo directorio y no aparece en `crew sessions list`.
- Herdr 0.9.x es joven: el crew habla con primitivas (`pane split`, `plugin
  pane open --target-pane`) verificadas contra el CLI; si cambian, el modo
  cae a un tab por run con un aviso en el log del run.

## Alternativas descartadas

- **Abrir el plugin de review con `--placement tab`.** Es el comportamiento
  previo (ADR 0046): el reviewer queda fuera del tab de la tarea.
- **Precrear el pane del reviewer con el plugin dentro.** `plugin pane open`
  no puede reutilizar un pane existente: siempre divide; de ahí el placeholder
  que se cierra al entrar en review.
- **Un tab por run pero agrupados.** Herdr no agrupa tabs de un workspace por
  tarea; la relación seguiría sin verse.
