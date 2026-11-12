# ADR 0044 — Preview en vivo por tarea

Estado: aceptada.

## Contexto

Cada tarea nace en su propio worktree y su propia rama (`crew/tsk_...`), así
que dos tareas independientes no comparten ficheros. Pero firmar un PR sin ver
el cambio funcionando obliga a arrancar un dev server a mano en
`~/.local/share/crew/worktrees/...` o a hacer `gh pr checkout`: el flujo de
review no ofrece ninguna URL. La persona no puede revisar "on the fly" antes
de firmar, y el checkout principal no debe tocarse.

## Decisión

1. **La config del proyecto declara cómo se sirve.** En `.crew/config.yaml`:

   ```yaml
   preview:
     command: npm run dev -- --port {port}
     port: 4321            # opcional; base, por defecto 4321
   ```

   - `{port}` se sustituye por el puerto asignado. Si el comando no lo
     contiene, crew exporta `PORT=<puerto>` en el entorno del proceso.
   - Sin `preview.command`, `crew task preview` falla con
     `PREVIEW_NOT_CONFIGURED` y enseña el ejemplo. La config se valida al leer
     el proyecto (`preview.command` no vacío, `preview.port` entero 1..65535).

2. **Un comando por tarea, no un servidor global.** `crew task preview <id>`
   resuelve el workspace como `task clean` (`resolveWorkspace`) y arranca el
   comando **en el worktree de la tarea**, en segundo plano y desacoplado del
   CLI (detached, sobrevive a su salida), escuchando en `127.0.0.1`. Espera a
   que el puerto responda (timeout acotado, 60 s por defecto) e imprime
   `Preview tsk_...: http://localhost:<puerto> (pid N)`.

   Es idempotente: con una preview viva imprime la URL existente sin duplicar
   el proceso. `--stop` manda SIGTERM y, si hace falta, SIGKILL al **grupo de
   procesos** (porque `npm run` deja un hijo), limpia el registro y no falla si
   ya estaba parada. `--json` devuelve `{ taskId, url, port, pid, running }`.

3. **Puertos propios y sin colisiones.** El puerto es la base configurada más
   el primero libre: nunca reutiliza el de otra preview viva ni uno que el
   sistema ya ocupa. Dos tareas en review a la vez obtienen 4321, 4322… y el
   puerto elegido se recuerda mientras esa preview siga viva. La comprobación
   de disponibilidad se hace bindeando `127.0.0.1`, no conectando a ciegas.

4. **Estado operativo y trazabilidad.** El registro vive en
   `~/.local/share/crew/previews/<taskId>.json` (`taskId`, `port`, `pid`,
   `url`, `command`, `startedAt`); es lo que permite parar el proceso y
   detectar registros huérfanos. El log del proceso va a
   `~/.local/share/crew/previews/<taskId>.log`, y si el arranque falla el error
   imprime su ruta. El event log existente registra `preview.started` y
   `preview.stopped` con puerto, pid y URL: no se añaden columnas a `tasks`.

5. **Review y show enseñan la URL.** `crew task show` imprime
   `Preview: http://...` cuando hay una viva. `buildReviewBuffer` añade en la
   cabecera `#  Preview   <url>` o, sin preview,
   `#  Preview   none (crew task preview <id>)`. `crew task clean` para la
   preview antes de borrar el worktree, y `crew task preview` funciona mientras
   exista el worktree (develop, review o done).

6. **Solo worktrees locales.** Un workspace remoto (`runner.repo_path`) devuelve
   `PREVIEW_UNSUPPORTED_REMOTE`: el puerto local no puede servir un worktree que
   vive en otra máquina. El runner "shared" (host remoto que ve el mismo
   worktree) sí funciona porque el worktree es local para este CLI.

## Consecuencias

- Revisar un PR con el cambio ya servido no exige mergear, hacer checkout ni
  tocar el checkout principal.
- Dos tareas independientes se pueden revisar en paralelo: ramas separadas,
  worktrees separados y previews en puertos distintos. Si dos tareas comparten
  un fichero, no eran independientes.
- La superficie nueva es un subcomando, un bloque de config y un registro en
  disco; no hay daemon nuevo ni dependencias nuevas (`node:child_process` y
  `node:net` bastan).
- El proceso sobrevive al CLI por diseño; `--stop`, `task clean` y los
  registros huérfanos son las vías de limpieza.

## Alternativas descartadas

- **Un dev server global sobre v2 en un puerto fijo**: todas las tareas
  comparten puerto y no se puede revisar dos a la vez; además habría que
  reiniciarlo y apuntarlo al worktree activo.
- **Auto-arrancar la preview al entrar en review**: consume recursos y abre
  puertos sin que la persona lo pida, y contradice la regla de que solo se
  sirve lo que se pide. `review` muestra la URL si ya está viva, no la arranca.
- **Un túnel público**: expone el worktree a la red y añade autenticación y
  dependencias externas para un caso que se resuelve en `127.0.0.1`.
