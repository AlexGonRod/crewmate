# ADR 0026 — Workers remotos por SSH

Estado: aceptada.

## Contexto

La Fase 4 pide "workers en hosts remotos alcanzables por SSH". La razón
habitual es ejecutar los agentes en máquinas más potentes, o en una red donde el
repositorio ya está desplegado.

Hacer esto bien implica mover al host remoto no solo el agente, sino también
el worktree, el commit, el push y la creación del PR: si el worktree queda en
la máquina local, el agente remoto no ve el código y el commit local no
recoge lo que el agente escribió. Ese cambio toca el núcleo entero del
pipeline.

## Decisión

1. **El runner remoto ejecuta el agente y la verificación.** Un proyecto
   declara su runner:

   ```yaml
   runner:
     host: builder@server
     ssh_options: ["-o", "BatchMode=yes"]
   ```

   y `task run --host <host>` lo sobrescribe para una ejecución concreta.

2. **El comando remoto se construye de forma explícita.** `src/app/runner.ts`
   compone `ssh <opciones> <host> "cd <worktree> && env <CREW_*> <comando>
   <args>"`. Solo se reenvían las variables `CREW_*` y el `PATH`: el entorno
   del host remoto es el del usuario remoto, no el local.

3. **El worktree tiene que ser visible en el host remoto.** Esta es la
   condición de uso: el host remoto ve la misma ruta de worktree (sistema de
   archivos compartido, volumen montado o clon espejo). Con esa condición, el
   agente remoto trabaja sobre el mismo código, el commit local recoge sus
   cambios y el push y el PR siguen siendo locales, con los gates intactos.

4. **El resto del motor no cambia.** La base de datos, el event log, los
   worktrees, el commit, el push y las forjas siguen siendo locales. Solo se
   substituye el proceso del agente y los comandos de verificación por su
   equivalente remoto.

5. **El cliente ssh conserva su entorno local.** El proceso `ssh` necesita
   `PATH`, `HOME` y `SSH_AUTH_SOCK` para autenticarse; lo que se cura es el
   entorno del comando remoto, no el del cliente.

## Consecuencias

- El agente y la verificación se ejecutan en el host configurado, con el mismo
  contrato de reporte, timeout, cancelación y logs.
- La condición del worktree compartido es explícita y está documentada: no es
  magia, y quien la configure sabe qué tiene que preparar en el host remoto.
- Si el host remoto no ve el worktree, la tarea falla con un error de
  verificación o de reporte, no con un cambio silencioso.

## Actualización

El ADR 0028 amplía este diseño: si el proyecto declara además
`runner.repo_path`, el worktree, el commit y el push ocurren en el host
remoto, y este ADR queda como el caso del sistema de archivos compartido.

## Alternativas descartadas

- Mover todo el pipeline al host remoto (worktree, commit y push remotos):
  es el diseño completo, pero exige que el estado del motor (SQLite) también
  viva allí o que se sincronice; es un trabajo de una fase propia.
- Montar el repositorio por NFS como parte del motor: depende del
  despliegue.
- Un agente que suba y baje el código: multiplica el tráfico y el riesgo de
  perder cambios.
