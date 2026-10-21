# ADR 0027 — El daemon como servicio del sistema

Estado: aceptada.

## Contexto

El daemon se lanza hoy a mano (`crew daemon run`). Eso significa que nadie
recuerda encenderlo, que se muere al cerrar la sesión y que no hay forma de
que el sistema lo levante después de un reinicio.

Un orquestador que trabaja mientras hay una terminal abierta es una demo, no
una herramienta. La Fase 4 dejaba explícito este punto: "UI web o servicio del
sistema".

## Decisión

1. **Un solo comando, dos gestores.** `crew service install|status|uninstall|logs`
   habla con el gestor nativo de la plataforma: `launchd` en macOS y `systemd`
   --user en Linux. El usuario no elige el formato; el motor detecta la
   plataforma y `--manager` solo sirve para forzar uno (o para depurar en otro
   sistema).

2. **Unidad de usuario, no de sistema.** `~/Library/LaunchAgents/` y
   `~/.config/systemd/user/`: el servicio corre como el usuario, sin sudo, sin
   pedir permisos especiales y sin tocar nada del sistema. Es la misma decisión
   que un editor o un lenguaje: el daemon trabaja con tus credenciales, tus
   repositorios y tu configuración.

3. **El servicio es el mismo daemon.** La unidad ejecuta `crew daemon run
   --json`: no hay un segundo modo de ejecución que mantener. El planificador,
   los leases, los reintentos y la reconciliación son los del motor.

4. **El servicio hereda los paths del usuario.** La unidad fija
   `CREW_CONFIG_DIR`, `CREW_DATA_DIR`, `CREW_STATE_DIR` y `CREW_DB_PATH` con
   los valores resueltos en el momento de instalar, de modo que el daemon del
   servicio y el CLI de la terminal hablan de la misma base de datos.

5. **Reinicio y estado.** En macOS, `RunAtLoad` + `KeepAlive` con
   `ThrottleInterval`: el daemon vuelve solo si se cae, sin insistencia. En
   Linux, `Restart=always` con `RestartSec=10`. Los logs van a
   `<data>/logs/daemon.log` y `daemon.error.log`, y `crew service logs` los
   lee.

6. **Todo es reversible y dry-runnable.** `crew service install --dry-run`
   imprime la unidad y los comandos sin tocar el sistema. `uninstall` descarga
   la unidad y borra el archivo. `status` no falla si el servicio no está
   instalado: informa.

## Consecuencias

- El daemon sobrevive al cierre de la terminal y al reinicio de la máquina.
- Instalar y desinstalar no requiere `sudo` ni deja residuos fuera del
  directorio del usuario.
- La configuración de concurrencia, reintentos e intervalo se fija en el
  momento de instalar (`--concurrency`, `--max-attempts`, `--backoff`,
  `--interval`); cambiar la política global después requiere reinstalar la
  unidad, que es explícito.
- `status` devuelve código de salida 1 cuando el servicio no está corriendo,
  para que un script pueda comprobarlo.

## Alternativas descartadas

- `sudo` y una unidad de sistema: da permisos innecesarios al daemon y complica
  el estado del usuario.
- Un `cron` que lance el daemon: no hay control de proceso, ni logs, ni
  apagado limpio, ni vuelta atrás si el daemon muere.
- Un servicio propio con un supervisor embebido: duplica lo que launchd y
  systemd ya hacen bien.
- Un instalador por plataforma (homebrew, npm postinstall): más superficie de
  mantenimiento y peor experiencia para un paquete que no se publica.
