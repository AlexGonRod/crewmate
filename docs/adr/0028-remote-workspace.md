# ADR 0028 — Workspace remoto: worktree, commit y push en el host remoto

Estado: aceptada. Complementa al ADR 0026.

## Contexto

El ADR 0026 dejó esto así: el agente y la verificación se ejecutan en el host
remoto, pero el worktree sigue estando en la máquina local y el host remoto
tiene que ver esa misma ruta (sistema de archivos compartido o volumen
montado). Es un buen punto de partida, pero tiene dos límites reales:

1. **El push sigue siendo local.** Las credenciales de git viven en la
   máquina local, no en el host que tiene el código y las dependencias.
2. **El worktree local es un punto de fallo compartido.** Si el host remoto no
   ve el mismo sistema de archivos, no hay nada que hacer.

Además, "el agente escribe en un worktree que el motor no ve" es una fuente
clara de errores: el motor lee el informe, calcula el diff y hace el commit
sobre archivos que, en el mejor caso, están sincronizados por una red.

## Decisión

1. **El código de una tarea vive en un "workspace".** Un workspace es local
   (el worktree está en esta máquina) o remoto (el worktree está en el host
   configurado). `src/app/workspace.ts` define la interfaz: `git`,
   `gitOrThrow`, `writeFile`, `appendFile`, `readFile`, `exists` y `ensureDir`.

2. **Todo el pipeline pasa por el workspace.** Crear el worktree, escribir el
   brief y el spec, leer el informe del agente, ejecutar la verificación,
   hacer el commit, calcular el diff y hacer el push. El motor no sabe si el
   código está aquí o allí: solo conoce la interfaz.

3. **El proyecto declara el repositorio remoto.**

   ```yaml
   runner:
     host: builder@server
     repo_path: /srv/repos/mi-proyecto
     worktree_root: /srv/worktrees   # opcional
   ```

   Con `repo_path`, el worktree se crea en el host remoto
   (`<worktree_root>/<proyecto>/<taskId>`), el agente trabaja ahí, el commit se
   hace ahí y el push sale de ahí, con las credenciales del host remoto.

4. **El motor local conserva el estado.** La base de datos, el log de
   eventos, los informes validados, los briefs y los logs de verificación
   siguen en la máquina local. Solo el código viaja.

5. **Tres modos, según la configuración.**

   | Configuración | Dónde vive el código | Dónde corre el agente |
   | --- | --- | --- |
   | sin `runner` | local | local |
   | `runner.host` | local | remoto (sistema de archivos compartido) |
   | `runner.host` + `repo_path` | remoto | remoto |

   El primero es el modo normal. El segundo es el del ADR 0026. El tercero es
   el workspace remoto completo.

6. **El pull request se sigue creando desde aquí.** La rama ya está
   pusheada y el repositorio local conoce la misma URL de origen, así que
   `gh pr create --head <rama>` funciona sin que el worktree exista localmente.
   Las forjas y el gate de CI no cambian.

7. **`crew task clean` y `crew doctor` hablan con el workspace.** Limpiar o
   verificar el worktree de una tarea remota significa hablar con el host
   remoto, no con el disco local.

## Consecuencias

- Una tarea puede ejecutarse en un host con más CPU, con GPU, con las
  dependencias ya instaladas y con las credenciales de git, sin que el código
  pase por la máquina local.
- La implementación de las operaciones remotas es deliberadamente simple:
  `ssh host "cd <ruta> && git ..."` y, para los archivos, un heredoc con
  delimitador. No hay un protocolo de transferencia propio que mantener.
- El contenido viaja en la línea de órdenes de `ssh`, así que está sujeto al
  límite de longitud del sistema. Los briefs y los informes entran de sobra;
  un informe gigante no.
- Un fallo de red en mitad de una tarea deja el worktree remoto orphaned.
  `crew task clean --force` lo elimina desde aquí.

## Alternativas descartadas

- **Sincronizar el worktree local y el remoto con rsync: son dos fuentes de
  verdad y cualquier conflicto se resuelve en el momento peor.
- **Subir y bajar el código por commit: multiplica el tráfico y pierde cambios
  sin commitear.
- **Un agente en el host remoto que hable con el motor por una API: convierte
  el motor en un servicio distribuido; es un producto distinto.
- **Mover también la base de datos al host remoto: el motor dejaría de ser
  local y el daemon del servicio y el CLI dejarían de compartir estado.
