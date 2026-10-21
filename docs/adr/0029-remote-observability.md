# ADR 0029 — El workspace remoto se ve y se diagnostica

Estado: aceptada. Complementa al ADR 0028.

## Contexto

Un workspace remoto cambia dos cosas que el motor antes daba por{supuestas:
dónde está el código y quién puede hablar con el host. Sin eso, un fallo
remoto se lee como un fallo cualquiera ("el agente no dejó informe") y nadie
sabe si el problema es la red, las credenciales o el repositorio.

Además, `ssh` sin más es interactivo: si el host pide contraseña, el proceso
se queda esperando y el daemon se queda colgado con una tarea tomada.

## Decisión

1. **La ubicación es parte del resumen de la tarea.** `TaskSummary.location`
   distingue tres casos: `local` (todo aquí), `shared` (el agente corre en un
   host remoto que ve el mismo worktree) y `remote` (worktree, commit y push
   en el host remoto). Aparece en `task show`, `task list`, `crew status`, el
   panel web y el briefing del capitán, y el proyecto del briefing declara su
   runner.

2. **El doctor comprueba el host.** Para cada proyecto con runner: que el host
   responda, que el repositorio exista allí (`git rev-parse --git-dir`) y que
   la raíz de worktrees se pueda escribir. Un proyecto con runner sin
   `repo_path` se avisa: el host tiene que ver el mismo worktree.

3. **Ninguna llamada a ssh es interactiva.** Todas las llamadas añaden
   `BatchMode=yes` y `ConnectTimeout=10` (el usuario puede sobrescribirlos con
   sus propias `ssh_options`, que van primero). Un host que pide contraseña
   falla en segundos con un error claro en vez de colgar el daemon.

4. **El resumen se calcula con caché por proyecto.** Resolver la ubicación
   lee la configuración del proyecto; el resolutor la cachea, así que listar
   cincuenta tareas no lee el mismo archivo cincuenta veces.

## Consecuencias

- Un fallo remoto se puede diagnosticar antes de tocar el pipeline: el doctor
  dice si el host responde y si el repositorio está donde debería.
- El daemon no se queda colgado esperando una contraseña: falla con
  `REMOTE_EXEC_FAILED` y la tarea se reintenta según la política.
- La configuración remota pasa a ser visible en la interfaz: el capitán puede
  decir "esta tarea corre en builder@server" sin abrir el fichero de
  configuración.

## Alternativas descartadas

- **Dejar el diagnóstico a ssh y al usuario**: cada fallo se convierte en una
  sesión de depuración manual.
- **Un subcomando `crew remote check` aparte**: el doctor ya es el sitio
  natural para "¿está todo bien en esta máquina?".
- **Un banner o un log de arranque**: informa una vez y se pierde; el estado
  del host cambia con el tiempo.
