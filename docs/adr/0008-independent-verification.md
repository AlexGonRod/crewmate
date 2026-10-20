# ADR 0008: Verificación independiente y determinista

## Contexto

El pipeline de Fase 1 separa developer y tester, pero el tester seguía siendo un
agente LLM que decidía si ejecutar los tests y qué evidencia reportar. Un
veredicto `approve` podía basarse en una ejecución incompleta, en la salida del
propio developer o en una interpretación incorrecta. El orquestador no tenía una
señal objetiva para bloquear el commit.

## Decisión

El orquestador ejecuta los comandos de verificación declarados por el proyecto,
en el worktree y de forma secuencial, antes de invocar al tester:

- `.crew/config.yaml` admite `verify: [comando, ...]` y
  `verify_timeout_seconds`.
- Cada criterio de aceptación puede declarar su propio `verify`; se ejecuta
  junto con los comandos del proyecto, sin duplicados.
- Cada comando se lanza mediante el shell del sistema, con el worktree como
  directorio de trabajo y variables `CREW_*` (`CREW_VERIFY=1`).
- Se guarda en SQLite el comando, estado (`passed`/`failed`/`error`), exit code,
  señal, timeout, duración, cola de salida y ruta del log completo.
- Si algún comando falla o expira, la tarea se rechaza sin ejecutar al tester. El
  feedback incluye la salida y la ruta del log.
- Si todos pasan, el brief del tester incluye la evidencia y las rutas de los
  logs. El tester sigue siendo responsable de la revisión semántica y del diff.

Los comandos se ejecutan después de que el developer emite un reporte `done` y
antes del commit, por lo que un fallo nunca deja un commit parcial en la rama.

## Alternativas descartadas

- **Pedir al tester que ejecute los comandos y los reporte**: no es verificable;
  el LLM puede omitir comandos o resumir mal la salida.
- **Confiar en los `tests` del reporte**: sigue siendo evidencia autodeclarada.
- **Ejecutar solo tras el `approve` del tester**: gastaría un run del tester para
  descubrir un fallo determinista que el orquestador puede detectar antes.

## Consecuencias

- El gate de tests deja de depender del criterio del agente.
- Los proyectos sin `verify` mantienen el comportamiento anterior: el tester
  revisa manualmente. `doctor` avisa cuando falta configuración.
- El coste de ejecutar tests se paga en cada intento, también tras un rechazo.
- La verificación asume que el comando no modifica archivos versionados; si lo
  hace, esos cambios entrarán en el commit como cualquier cambio del worktree.
- La comparación con una línea base (tests que ya fallaban antes del cambio)
  queda para una fase posterior; por ahora un fallo de `verify` siempre bloquea.
