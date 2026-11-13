# ADR 0046 — Review en Herdr: abrir el tab al entrar en review

Estado: aceptada.

## Contexto

El plugin `herdr-reviewr` (`persiyanov.reviewr`) muestra el diff de un
worktree y envía los comentarios por línea al input del agente (ADR 0043).
Hoy hay que abrirlo a mano con su atajo (`prefix+alt+r`) y, normalmente, el
pane del capitán vive en el checkout principal, así que el toggle revisa la
rama equivocada. Además su `auto_open` solo escucha los eventos
`worktree.created` / `worktree.opened` de Herdr, y crew crea los worktrees con
`git worktree add` directo (ADR 0003), no con `herdr worktree create/open`:
esos eventos nunca llegan para una tarea del crew.

## Decisión

1. **Opt-in por proyecto.** `.crew/config.yaml` declara la superficie:

   ```yaml
   review:
     herdr_tab: reviewr        # off (por defecto) | reviewr | <plugin-id>
   ```

   - ausente o `off`: no se abre nada (comportamiento anterior).
   - `reviewr` es el alias de `persiyanov.reviewr`; cualquier otro id se usa
     tal cual como `--plugin`.
   - Se valida al leer la config del proyecto: si está presente debe ser un
     string no vacío (`PROJECT_CONFIG_INVALID`).

2. **Se abre al entrar en review.** El pipeline, tanto desde el daemon como
   desde `crew task run`, abre el pane después de `store.requestReview` y
   antes de devolver el resultado. El comando es explícito, no depende de
   eventos ni de `auto_open`:

   ```sh
   herdr plugin pane open --plugin <id> --entrypoint pane \
     --placement tab --cwd <worktree de la tarea> --no-focus
   ```

   El `cwd` es el worktree de la tarea, nunca el checkout principal. La config
   global del plugin no se toca.

3. **Fail-soft.** Si Herdr no está disponible, el plugin no está instalado o
   está deshabilitado, o el comando falla, la tarea sigue en `review` y el
   event log registra `review.surface_failed` con el motivo (`plugin`,
   `worktree`, `reason`). Nunca se falla ni se retrasa la transición por no
   poder abrir la superficie. Un alta correcta registra
   `review.surface_opened`.

4. **Una superficie por worktree.** Antes de abrir se listan los panes de
   Herdr: si ya hay un pane del plugin con el `cwd` del worktree, se enfoca
   (`herdr plugin pane focus`) en vez de abrir otro. Esto hace idempotente
   tanto el paso automático como el manual.

5. **Manual y reabrible.** `crew task review <id> --herdr` abre el tab bajo
   demanda aunque la tarea ya esté en review (por ejemplo si se cerró el tab),
   sin abrir el editor. Usa el plugin configurado o `reviewr` si no hay
   config.

6. **La decisión sigue siendo de ADR 0043.** Abrir el tab no cambia el intake:
   reviewr sigue enviando un pegado con `crew-decision:` y el crew lo registra
   con `crew task decision`. Este ADR solo gobierna dónde vive la superficie,
   no cómo llega la firma.

## Consecuencias

- Al llegar a review la persona ve el diff de la rama correcta sin montar el
  pane ni cambiar el `cwd` a mano.
- El coste es un bloque de config, un runner de Herdr y un event type; no hay
  daemon, dependencia ni plugin nuevo.
- Si Herdr no está en marcha (o el plugin no está instalado), el flujo de
  review del buffer sigue intacto: el fallo queda trazado, no bloquea.

## Alternativas descartadas

- **Activar `auto_open` del plugin.** Depende de eventos de worktree de Herdr
  que crew no emite al crear worktrees con `git worktree add`; además abre en
  cada worktree, no solo en review.
- **Reutilizar el toggle manual.** Delega en el `cwd` del pane del capitán
  (checkout principal) y no permite fijar placement, worktree ni foco.
- **Un watch de eventos del plugin dentro del daemon.** Duplica el intake de
  ADR 0043 y añade estado que el CLI ya resuelve abriendo el pane.
