# crew

Orquestador de múltiples agentes agnóstico al lenguaje. Las **Fases 0, 1 y 2**
están completadas: metodología de desarrollo declarativa (`free`, `spec`,
`tdd`), pipeline developer → verificación → tester → git/PR, gate de CI, entrega
con auto-merge, harness reales (`opencode`) con detección automática, y un daemon
con lease que procesa la cola en paralelo, reintenta con backoff y reconcilia
runs perdidos. El núcleo sigue siendo pequeño y verificado.

El objetivo a medio plazo es una capa **capitán** conversacional encima de este
motor: hablar con un agente que entiende la petición, clona el proyecto, lanza
workers aislados y entrega PRs listos para revisar. El detalle está en el
[roadmap](docs/roadmap.md).

El diseño combina dos ideas:

- El **plano de ejecución** de [firstmate](https://github.com/kunchenguid/firstmate/):
  tareas, worktrees, ciclo de vida, reportes y recuperación.
- El **plano de entorno** de [gentle-ai](https://github.com/Gentleman-Programming/gentle-ai):
  contratos versionados, manifiestos de harness y distribución multiplataforma.

## Estado

Fases 0, 1 y 2 completadas:

- Proyectos registrados y tareas con estado durable en SQLite.
- Worktree aislado por tarea.
- Metodologías `free`, `spec` y `tdd`, con gates de evidencia.
- Pipeline developer → verificación determinista → tester independiente → commit
  → revisión humana.
- Briefs por rol y contratos de reporte `crew.report/v1`, v2 y v3.
- Comandos `verify` del proyecto ejecutados por el orquestador, con exit code,
  salida y log durable.
- Gate de CI de GitHub Actions antes de pasar a `review`, con resultado durable.
- Rechazo del tester o de la verificación con feedback y límite configurable de
  iteraciones.
- Entrega `local`, `pr` o `auto_merge` (GitHub con `gh`, GitLab con `glab`);
  `task accept` exige el PR/MR mergeado salvo `--force`.
- Harness `opencode` real, además del agente falso.
- Detección de binarios, `--harness auto` y `crew harness list`.
- Cola de tareas y daemon con lease único, heartbeat, concurrencia configurable
  y parada ordenada.
- Reintentos automáticos con backoff exponencial y recuperación de runs
  perdidos tras reinicio.
- Reconciliación de runs perdidos y `task retry` explícito.
- Los leases de procesos muertos se pueden tomar de inmediato: un daemon que
  muere no bloquea el siguiente más de un instante.
- Clasificación de riesgo por cambio con reglas explícitas y resumen reutilizable
  (`task show` y `crew status`) con riesgo, CI, verificación, tester y estado del
  PR.
- Agente falso con escenarios de desarrollador y tester.
- CLI con salida humana y `--json`.
- Capa capitán: instrucciones `AGENTS.md` instalables y briefing compacto con
  riesgo, CI y decisiones pendientes.
- Event log append-only y `doctor`.
- Tests unitarios y e2e.
- Paquete npm instalable con binario `crew`.

El resto del alcance y las fases pendientes están en el
[roadmap](docs/roadmap.md).

## Roadmap

| Fase | Estado | Objetivo |
|---|---|---|
| 0. Núcleo durable | Completada | Estado, worktrees, metodologías y recuperación |
| 1. Pipeline y entrega | Completada | Developer, tester, verificación, commit/PR y daemon |
| 2. Motor autónomo confiable | Completada | CI, auto-merge, concurrencia, riesgo y reintentos |
| 3. Capitán conversacional | Completada | Capa capitán, intake, planes, supervisión y merge |
| 4. Runtime visible y escala | Completada | Sesiones visibles, remotos, memoria, scout, forjas y UI |

Detalle, criterios de salida y dependencias: [docs/roadmap.md](docs/roadmap.md).
La separación entre motor y capitán está registrada en el
[ADR 0009](docs/adr/0009-engine-and-captain-layer.md).

## Requisitos

- Node.js >= 24 (probado con Node 26, que incluye `node:sqlite`).
- git.
- `gh` autenticado solo si se usa `--delivery pr`.
- pnpm solo para desarrollo.
- tmux (opcional, para fases posteriores).

## Guía

La ruta corta para working con él: [`docs/guide.md`](docs/guide.md). Con la CLI
instalada: `crew guide` (o `crew guide --open` para abrirla en tu editor).

## Instalación

Global desde npm:

```sh
npm install -g @alexgonrod/crewmate
crew version
```

Desde el repositorio:

```sh
pnpm install
pnpm build
node dist/crew.js version
```

## Uso rápido

Dentro de un repositorio git:

```sh
crew init
crew --json project add . --name demo
crew --json task create \
  --project demo \
  --title "Mi primera tarea" \
  --brief "Crea un fichero de ejemplo" \
  --acceptance "El fichero existe" \
  --acceptance "El fichero tiene contenido"
crew --json task run tsk_... --harness fake --env CREW_FAKE_SCENARIO=spec_success
crew --json task show tsk_...
crew --json task accept tsk_...
crew task clean tsk_... --force
```

`--json` es una opción global y debe ir antes del subcomando.

## Comandos

| Comando | Descripción |
|---|---|
| `crew init [--force]` | Escribe `.crew/config.yaml` en el repo actual |
| `crew project add <path> [--name]` | Registra un repositorio |
| `crew project clone <url> [--dir <path>] [--name <name>]` | Clona un repositorio de GitHub, detecta su toolchain y lo registra |
| `crew project list` | Lista proyectos |
| `crew harness list` | Lista harnesses, disponibilidad y capacidades |
| `crew ask "<petición>" [--project <ref>] [--harness <id>] [--timeout <s>]` | Lanza al capitán con la petición literal y devuelve su respuesta |
| `crew chat [--project <ref>] [--harness <id>] [--timeout <s>]` | Conversación multi-turno con el capitán (`/exit` para salir) |
| `crew task create --project <ref> --title <t> (--request <texto> \| --request-file <path>) (--brief <texto> \| --brief-file <path> \| --spec-file <path>) [--methodology free\|spec\|tdd] [--acceptance <texto>] [--non-goal <texto>] [--delivery local\|pr] [--no-request]` | Crea una tarea en `draft` con la petición de la persona |
| `crew task list [--state <state>]` | Lista tareas |
| `crew task show <id>` | Detalle, runs, reporte, mensajes, artefactos, eventos y resumen de riesgo/CI |
| `crew task run <id> [--harness <id>] [--tester-harness <id>] [--agent <n>] [--model <n>] [--tester-agent <n>] [--tester-model <n>] [--max-iterations <n>] [--delivery local\|pr] [--timeout <s>] [--env K=V] [--quiet]` | Ejecuta el pipeline en un worktree |
| `crew task queue <id>` | Encola una tarea en `draft` para el daemon |
| `crew task retry <id>` | Reencola una tarea `failed` |
| `crew task answer <id> --text <texto>` | Responde y encola un nuevo intento |
| `crew task cancel <id>` | Cancela la tarea y su proceso activo |
| `crew task clean <id> [--force]` | Elimina el worktree; nunca borra la rama |
| `crew task accept <id> [--force]` | Acepta una tarea en `review`; con `pr`, verifica que el PR esté mergeado |
| `crew task merge <id> [--by <quien>] [--method <merge\|squash\|rebase>] [--delete-branch] [--accept-only]` | Comprueba las puertas y mergea o acepta la tarea; si falta algo, explica qué falta |
| `crew task reject <id> [motivo...] [--reason <texto>]` | Rechaza, guarda feedback y reencola al developer |
| `crew daemon run [--once] [--interval <s>] [--max-tasks <n>] [--concurrency <n>] [--scheduling <serial\|parallel>] [--max-attempts <n>] [--backoff <s>] [--harness <id>] [--tester-harness <id>] [--max-iterations <n>] [--quiet]` | Procesa la cola de tareas |
| `crew daemon status` | Muestra lease, runs activos y tareas en cola |
| `crew ui [--port <n>] [--host <host>]` | Sirve un panel web de solo lectura con el estado del crew |
| `crew sessions list` | Lista las sesiones visibles de agente (tmux) y cómo conectarse |
| `crew sessions kill <name>` | Cierra una sesión visible |
| `crew scout --project <ref> --title <t> --question <pregunta> [--queue]` | Crea una tarea de investigación que produce un informe |
| `crew memory add --project <ref> --kind <kind> --title <t> --body <texto>` | Añade una nota durable al proyecto |
| `crew memory list --project <ref> [--kind <kind>]` | Lista la memoria del proyecto |
| `crew memory rm <id>` | Elimina una nota de la memoria |
| `crew progress <id> [--events <n>]` | Informa del avance de una tarea en lenguaje natural y de qué toca ahora |
| `crew status [--limit <n>]` | Resumen global: lease, conteo por estado, runs activos y tareas recientes con riesgo y CI |
| `crew plan validate <file>` | Valida un plan y muestra los grupos de ejecución y avisos |
| `crew plan apply <file> [--project <ref>] [--queue] [--delivery <modo>]` | Crea las tareas del plan, registra sus dependencias y opcionalmente las encola |
| `crew captain brief [--project <ref>] [--limit <n>]` | Briefing para el capitán: proyectos, estado, riesgo y lo que requiere decisión humana |
| `crew captain init [--force]` | Escribe las instrucciones `AGENTS.md` del capitán en el repositorio |
| `crew role list` / `crew role show <rol>` / `crew role init <rol>` | Contratos de rol (developer, tester, scout, captain) y de dónde salen |
| `crew daemon reconcile [--stale-after <s>] [--requeue] [--max-attempts <n>] [--backoff <s>]` | Marca runs muertos como perdidos y falla o reencola sus tareas |
| `crew report --task <id> --run <id> [--file <path\|->] [--status <s>] [--summary <t>]` | Registra un reporte |
| `crew events [--task <id>] [--follow] [--limit <n>]` | Muestra el event log |
| `crew doctor` | Comprueba base de datos, harnesses, runs, worktrees y proyectos |
| `crew version` | Muestra la versión |

Códigos de salida de `task run`: `0` si la tarea termina en `review` o `done`,
`2` si queda en `waiting_input` o `blocked`, `1` para `failed`/`cancelled`. En
`daemon run --once` el código es `1` si la tarea procesada no termina en
`review`/`done`; en modo continuo sale con `0` tras una parada ordenada.

## Harnesses

- `fake`: agente de prueba incluido; no requiere binarios externos.
- `opencode`: ejecuta `opencode run --format json --auto` con el brief como
  mensaje. El agente trabaja en el worktree aislado de la tarea.
- `auto`: elige el primer harness real detectado en `PATH`. Si no hay ninguno,
  falla con `HARNESS_UNAVAILABLE` antes de crear el worktree.

```sh
pnpm crew harness list
pnpm crew --json task run tsk_... --harness opencode
pnpm crew --json task run tsk_... --harness auto
```

El harness por defecto se puede fijar en `~/.config/crew/config.yaml`:

```yaml
harness: opencode
timeout_seconds: 1800
agents:
  developer:
    harness: opencode
    # agent: build
    # model: provider/model
  tester:
    harness: opencode
review:
  max_iterations: 3
delivery: local
```

`opencode` se lanza con `--auto` para que pueda editar el worktree sin
confirmaciones interactivas. Las reglas de permisos que el usuario haya denegado
explícitamente en su configuración de opencode se siguen respetando.

Los comandos de verificación se declaran en el proyecto:

```yaml
# <repo>/.crew/config.yaml
verify:
  - pnpm test
  - pnpm lint
verify_timeout_seconds: 600
```

El gate de CI se activa por proyecto y requiere un modo con PR (`pr` o
`auto_merge`):

```yaml
ci:
  provider: github_actions
  timeout_seconds: 900
  interval_seconds: 10
```

El orquestador espera a que terminen los checks del commit del PR antes de pasar
la tarea a `review`. Si fallan, quedan pendientes hasta el timeout o no se reportan, la
tarea falla y conserva el PR y el artefacto `ci` para diagnóstico. `task accept`
exige el último resultado `passed` cuando el proyecto tiene `ci`; `--force`
omite esa comprobación. Si no hay `ci`, los comandos `verify` siguen siendo el
gate principal. Decisión registrada en el
[ADR 0010](docs/adr/0010-ci-gate.md).

El auto-merge es opt-in y exige una política explícita y CI configurado:

```yaml
delivery: auto_merge
auto_merge:
  method: squash
  delete_branch: false
```

`method` es obligatorio (`merge`, `squash` o `rebase`) y `delete_branch` es
opcional. Sin política la tarea falla con `MERGE_POLICY_REQUIRED`; sin `ci`,
con `CI_REQUIRED_FOR_AUTO_MERGE`. El merge solo se intenta con verificación y
tester aprobados, CI verde y PR mergeable; GitHub sigue aplicando la protección
de rama. El actor `crew` registra el resultado en el artefacto `merge` y el
evento `merge.completed`. Si el merge falla, la tarea queda en `review` para
resolverlo manualmente. Decisión registrada en el
[ADR 0011](docs/adr/0011-auto-merge.md).

## Pipeline de desarrollo

`task run` y el daemon ejecutan el mismo pipeline:

1. **Developer**: implementa en el worktree y emite un reporte v1/v2.
2. **Verificación**: el orquestador ejecuta, de forma determinista y en orden,
   los comandos de `verify` del proyecto y los `verify` de cada criterio de
   aceptación. Guarda exit code, duración, salida y log de cada comando.
3. **Tester**: agente independiente, solo lectura, revisa el diff y la evidencia
   de verificación, y emite un reporte `crew.report/v3` con `approve` o `reject`.
4. **Git**: si la verificación y el tester aprueban, se hace commit.
5. **Delivery**:
   - `local`: la rama queda lista para revisión local.
   - `pr`: se hace push y se abre un PR en GitHub con `gh`. Si el proyecto
     declara `ci`, se espera a que los checks terminen; un fallo o timeout falla
     la tarea antes de `review`.
   - `auto_merge`: como `pr`, y después intenta el merge con la política del
     proyecto. Si tiene éxito, la tarea pasa a `done`; si falla, queda en
     `review` con el motivo registrado.
6. **Review**: la tarea queda en `review`. `task reject` reencola al developer con
   el feedback; `task accept` la marca `done`.

Si un comando de verificación falla o expira, la tarea se rechaza sin invocar al
tester: el developer recibe la salida y la ruta del log como
`review_feedback`. Si todos pasan, el tester recibe la evidencia y puede revisar
el diff y los criterios. El tester rechaza con `status: failed` y al menos un
`finding` de severidad `blocking`.

Ambos tipos de rechazo comparten el contador `review_iterations`. Tras
`review.max_iterations` rechazos (3 por defecto) la tarea falla y requiere
`task retry`.

Con `--delivery pr`, `task accept` consulta el estado real del PR:

```sh
pnpm crew --json task accept tsk_...
# error PR_NOT_MERGED si sigue abierto
pnpm crew --json task accept tsk_... --force
```

`auto_merge` se rige por el ADR 0011; `scout` se rechaza con
`DELIVERY_UNSUPPORTED`.

## Reintentos y backoff

Un fallo de agente (crash, timeout, salida sin reporte) no termina el lote: el
daemon puede reencolar la tarea con un retardo creciente.

```sh
# Hasta 3 intentos por tarea, con backoff base de 30 s
pnpm crew daemon run --max-attempts 3 --backoff 30

# Recuperar tareas cuyo run se perdió al reiniciar la máquina
pnpm crew daemon reconcile --requeue --max-attempts 3
```

- `--max-attempts` es el número máximo de intentos por tarea; por defecto 1
  (sin reintentos automáticos).
- `--backoff` es la base del retardo: `base * 2^(intento - 1)`, con tope de 15
  minutos.
- Solo se reintentan fallos transitorios. Los errores de configuración o
  protocolo (spec inválida, reporte malformado, política de merge ausente) y un
  CI fallido son definitivos.
- Cada reintento queda registrado con el evento `task.requeued`; la tarea
  guarda `attempts`, `next_attempt_at`, `last_error` y `retryable`.
- `crew status` muestra cuántas tareas esperan su backoff.

Ver ADR 0014.

## Daemon

El daemon procesa tareas en estado `queued`, una por defecto y hasta N con
`--concurrency`:

```sh
pnpm crew --json task queue tsk_...
pnpm crew daemon run --harness fake --env CREW_FAKE_SCENARIO=success
pnpm crew daemon run --concurrency 2 --max-tasks 4
pnpm crew daemon status
```

- Solo puede haber un daemon por base de datos. El lease (`leases`) incluye
  owner `host:pid`, TTL y heartbeat; si está ocupado, falla con `DAEMON_RUNNING`.
- Cada tarea mantiene su worktree, rama, run y lease `task:<id>`. Si otro
  proceso ya la está ejecutando, el daemon la deja en cola con un cooldown y
  sigue con la siguiente; un `task run` manual tampoco puede duplicarla.
- El scheduler respeta prioridad, `--max-tasks` (tareas lanzadas),
  `--concurrency` y `--once` (fuerza una tarea). Las tareas no iniciadas siguen
  `queued` cuando el daemon se detiene.
- En cada ciclo reconcilia runs activos: si el PID ya no existe (o nunca se
  registró y superó `--stale-after`), marca el run como `lost` y la tarea como
  `failed` con el motivo. `crew task retry <id>` la reencola.
- `--once` procesa como mucho una tarea y sale; sin tareas termina con
  `stopped: idle`.
- `SIGINT`/`SIGTERM` paran el bucle, terminan el grupo de proceso de todos los
  agentes activos, cancelan verificación y espera de CI, y esperan a que se
  registre el fallo. Las tareas afectadas quedan `failed` y se pueden reintentar.

El orden de finalización con `--concurrency` mayor que 1 no tiene por qué
coincidir con el orden de la cola.

El daemon ejecuta las tareas en el mismo proceso que supervisa. Si el daemon
muere de forma abrupta, el agente puede quedar huérfano; al siguiente arranque,
la reconciliación lo detecta y falla la tarea en lugar de dejarla colgada.

## Metodología

Cada tarea declara cómo debe trabajar el agente:

- `free`: brief libre y reporte `crew.report/v1` o v2. Compatible con Fase 0.
- El tester siempre usa `crew.report/v3`; su veredicto no sustituye los gates de
  evidencia del developer.
- `spec`: la tarea requiere una spec `crew.spec/v1` con criterios de aceptación.
  Para `done`, el reporte v2 debe incluir evidencia `passed` para cada criterio.
- `tdd`: además de la spec, exige evidencia de las fases `red` y `green` en
  `tests`.

La resolución es: `--methodology` > `.crew/config.yaml` > `free`. `crew init`
escribe `methodology: spec` para proyectos nuevos.

```sh
# Crear una tarea spec con criterios desde la CLI
pnpm crew --json task create \
  --project demo \
  --title "Añadir endpoint" \
  --brief "Implementa GET /health" \
  --acceptance "Devuelve 200" \
  --acceptance "Incluye test de integración"

# O con un fichero spec JSON/YAML
pnpm crew --json task create \
  --project demo \
  --title "Añadir endpoint" \
  --spec-file specs/health.yaml

# Escape hatch para tareas sin criterios formales
pnpm crew --json task create \
  --project demo \
  --title "Actualizar README" \
  --brief "Documenta los comandos" \
  --methodology free
```

Si un reporte `done` no cubre la spec, la tarea falla con `REPORT_INCOMPLETE`.
La evidencia del developer es autodeclarada, pero los comandos `verify` los
ejecuta el orquestador antes de invocar al tester. La salida queda en
`verifications` y se muestra en `task show`.

## Sesiones visibles

```sh
crew task run <id> --session herdr   # o tmux, o auto (por defecto)
crew sessions list                   # sesiones de los dos backends
crew sessions kill <name>
```

- El agente se ejecuta en una sesión visible para poder observarlo e
  intervenir. Hay dos backends: **tmux** y **Herdr**; `auto` usa Herdr si su
  servidor está corriendo y cae a tmux si no.
- Con Herdr, cada sesión es un workspace etiquetado `crew-<taskId>-<rol>` cuyo
  pane ejecuta el agente: aparece en tu TUI con su estado real (`working`,
  `blocked`, `done`, `idle`) y puedes Attach a él.
- Con tmux, la sesión es `crew-<taskId>-<rol>` y se abre con
  `tmux attach -t <nombre>`.

Ver ADR 0023 y ADR 0031.

## La autoridad de merge

Un gate no es "los checks pasan": es **quién tiene la autoridad para firmar**.

```yaml
# .crew/config.yaml del proyecto
delivery:
  mode: no-mistakes      # no-mistakes | direct-PR | local-only
  yolo: false            # el capitán puede fusionar trabajo verde sin preguntar
```

- La **ruta** decide la exigencia técnica: `no-mistakes` (verificación +
  tester + CI + PR), `direct-PR` (PR sin reviewer independiente) o
  `local-only` (todo el rigor, pero aterrizaje local).
- La **autoridad** decide quién firma: sin `yolo`, solo una persona; con
  `yolo`, el capitán fusiona lo verde y en alcance.
- `yolo` **nunca** autoriza un PR rojo, un check requerido sin reportar ni un
  cambio de riesgo `high`. Esos tres escalan siempre.
- La firma de una persona es el artefacto que deja `crew task review`, no una
  palabra: todo merge pasa por esa puerta y queda registrado.

Ver ADR 0032 y el skill `crew-merge-authority`.

## Contratos de rol

Cada rol tiene un contrato con la forma de un `AGENTS.md`: reglas duras por
prioridad, procedimiento, definición de terminado y qué se reporta. Viaja en
el brief del agente, así que siempre se lee.

```sh
crew --json role list                  # contratos y de dónde salen
crew --json role show tester           # el contrato del tester
crew --json role init tester           # lo escribe en el proyecto, para editarlo
```

- `developer`: no escribe fuera de su worktree, no toca el pipeline, no
  declara nada hecho sin evidencia y no se sale del brief.
- `tester`: no modifica el código, no confía en el informe del developer,
  ejecuta las verificaciones él mismo y rechaza con un hallazgo bloqueante.
- `scout`: solo lee; su entregable es el informe, y no arregla "de paso".

Un proyecto puede cambiar el contrato de un rol con
`crew role init <rol>`: lo escribe en `.crew/roles/<rol>.md` y ese manda
sobre el del motor.

Ver ADR 0034.

## Skills

Los skills son la capa de procedimientos: cosas que solo aplican en una
situación concreta y que no tienen sentido pagar en cada sesión.

```sh
crew --json skills list      # los que ven tus agentes
crew --json doctor           # avisa si no hay ninguno
```

El brief de cada agente incluye los skills disponibles (con su descripción
truncada), para que sepa qué puede cargar. Los del crew se instalan en tu
proyecto o global:

```sh
npx skills add AlexGonRod/crewmate --skill crew-review -a opencode
```

| Skill | Para qué |
| --- | --- |
| `crew-review` | revisar una tarea y decidir accept/reject en el editor |
| `crew-merge-authority` | cuándo fusionar sin preguntar y qué escala siempre |
| `crew-guidelines` | dónde vive cada hecho y la regla de un solo dueño |
| `crew-memory` | escribir, corregir y podar la memoria del proyecto |
| `crew-scout` | cuándo investigar en vez de construir |
| `stow` | barrer la sesión y archivar lo aprendido (adaptado de firstmate) |

Ver ADR 0033.

## Revisión en el editor

```sh
crew task review <id>     # abre el brief, los gates y el diff en $EDITOR
crew task answer <id>     # responde a las preguntas del agente en el editor
```

- `crew task review` escribe un *review buffer* con el brief, el riesgo, el
  estado de los gates y el diff completo, y lo abre en `$EDITOR` (`CREW_EDITOR`
  > `VISUAL` > `EDITOR` > `nvim`).
- Decides escribiendo dos líneas:

  ```
  crew-decision: accept
  crew-reason: it matches the brief
  ```

  `accept` merges (pasando las mismas puertas que `crew task merge`),
  `reject` devuelve la tarea con el motivo, y cualquier otra cosa (incluido
  cerrar sin tocar nada) **no cambia nada**.
- `crew task answer` hace lo mismo con las preguntas de una tarea en
  `waiting_input`; `--text` sigue disponible para scripts.
- La decisión queda registrada como artefacto `review` de la tarea.

Ver ADR 0030.

## Daemon como servicio

```sh
crew service install            # launchd en macOS, systemd --user en Linux
crew service status
crew service logs --lines 50
crew service uninstall
```

- El servicio corre como el usuario (sin `sudo`): `~/Library/LaunchAgents/` en
  macOS y `~/.config/systemd/user/` en Linux.
- Es el mismo daemon (`crew daemon run --json`), con la misma base de datos y
  los mismos paths que el CLI de la terminal.
- Reinicio automático si se cae, y logs en `<data>/logs/daemon.log`.
- `crew service install --dry-run` imprime la unidad y los comandos sin tocar
  el sistema.

Ver ADR 0027.

## Workers remotos

```yaml
# .crew/config.yaml
runner:
  host: builder@server
  ssh_options: ["-o", "BatchMode=yes"]
  repo_path: /srv/repos/mi-proyecto     # opcional
  worktree_root: /srv/worktrees         # opcional
```

```sh
crew task run tsk_... --host builder@server   # sobrescribe el host
```

- El agente y los comandos de verificación se ejecutan por `ssh` contra el host
  configurado, con el mismo contrato de reporte, timeout y cancelación.
- Solo se reenvían las variables `CREW_*` y el `PATH`: el entorno del comando
  remoto es el del host remoto.
- **Sin `repo_path`**: el host remoto tiene que ver la misma ruta del worktree
  (sistema de archivos compartido, volumen montado o clon espejo). La base de
  datos, el commit, el push y las forjas siguen siendo locales (ADR 0026).
- **Con `repo_path`**: el worktree se crea en el host remoto, el agente trabaja
  allí, y el commit y el push salen de allí con las credenciales del host. La
  base de datos, los informes y los logs siguen siendo locales, y el pull
  request se crea desde aquí (ADR 0028).

- `crew doctor` comprueba que el host responde, que el repositorio existe
  allí y que la raíz de worktrees se puede escribir. Todas las llamadas a
  `ssh` son no interactivas (`BatchMode=yes`, `ConnectTimeout=10`), así que un
  host que pide contraseña falla en segundos en vez de colgar el daemon.
- La ubicación de cada tarea (`local`, `shared` o `remote`) aparece en
  `task show`, `task list`, `crew status`, el panel web y el briefing del
  capitán.

Ver ADR 0026, ADR 0028 y ADR 0029.

## UI web

```sh
crew ui --port 4173
```

- Panel de solo lectura con el estado, lo que requiere atención y la tabla de
  tareas (riesgo, CI, verificación, tester y PR), refrescado cada 3 s.
- API JSON: `/api/summary`, `/api/tasks`, `/api/tasks/<id>` y
  `/api/events?task=<id>`.
- No expone métodos que muten el estado: toda acción sigue pasando por la CLI.
- Escucha en `127.0.0.1` por defecto; publicarlo es una decisión explícita.

Ver ADR 0025.

## Forjas

El motor habla con las forjas tras una interfaz común:

| Forja | CLI | Estado |
|---|---|---|
| GitHub | `gh` | PR: push, creación, gate de CI y auto-merge |
| GitLab | `glab` | MR: push, creación y merge; el gate de CI sigue siendo de GitHub Actions |

La forja se deduce del remote del proyecto (`github.com`, `gitlab.com`). Un
proyecto GitLab puede entregar con `--delivery pr`: push, merge request,
aceptación tras el merge y merge conversacional. Un proyecto con `ci`
configurado y una forja no compatible falla con `CI_PROVIDER_UNSUPPORTED` en
lugar de saltarse el gate.

Ver ADR 0024.

## Sesiones visibles

Para ver (o intervenir en) al agente mientras trabaja:

```sh
crew task run tsk_... --harness opencode --session tmux
```

- El agente corre en una sesión tmux `crew-<taskId>-<rol>`: te puedes conectar
  con `tmux attach -t crew-<taskId>-developer` y ver (o interrumpir) lo que
  hace.
- La salida del pane se captura y se escribe en el log del run, así que el
  reporte se lee igual que en modo normal.
- `crew sessions list` muestra las sesiones, su estado y el comando para
  conectarse; `crew sessions kill <nombre>` las cierra.
- Sin `tmux` instalado, el motor sigue funcionando en modo normal.

Ver ADR 0023.

## Tareas scout

Para investigar antes de cambiar:

```sh
crew scout --project demo --title "Cómo se drena la cola" \
  --question "Investiga el scheduler del daemon y explica cómo se eligen las tareas" --queue
```

- El scout es un recorrido propio del pipeline: sin verificación, sin tester,
  sin commit, sin PR y sin CI.
- El agente trabaja en modo investigación (no modifica ficheros) y entrega un
  informe `crew.report/v3` con `findings` y preguntas abiertas.
- El informe se guarda como artefacto `scout` y aparece en `task show` y en el
  briefing del capitán.
- La tarea scout termina en `review`: el capitán resume el hallazgo.

Ver ADR 0022.

## Memoria de proyecto

Notas durables por proyecto (convenciones, decisiones, trampas, glosario) para
no repetir contexto entre sesiones.

```sh
crew memory add --project demo --kind convention \
  --title "Usar pnpm" --body "El proyecto usa pnpm, nunca npm install." --source user
crew memory list --project demo
crew memory rm mem_...
```

- La memoria se incluye en el brief de cada agente: los workers trabajan con
  las convenciones del proyecto desde el primer prompt.
- También aparece en `crew --json captain brief`, así que una sesión nueva
  empieza sabiendo lo que ya se decidió.
- Cada alta y cada baja queda en el event log (`memory.added`,
  `memory.removed`).

Ver ADR 0021.

## Demo de aceptación

El flujo completo de la Fase 3 está automatizado en
`test/e2e/acceptance.test.ts`: plan con dos tareas, workers en worktrees
aislados y en paralelo, informe con riesgo y CI, merge conversacional y
recuperación tras matar el daemon a mitad del flujo (la tarea se reencola y se
completa).

## Merge conversacional

```sh
crew task merge tsk_... --by user
```

Antes de tocar nada se evalúan las puertas: la tarea está en `review`, el
tester aprobó, la verificación está en verde, el CI está en verde (si hay
resultado registrado), y el PR existe, está abierto, no es draft y es
mergeable.

- Si falta algo, el comando falla con `MERGE_BLOCKED` y enumera qué falta y por
  qué; la tarea se queda en `review` y no se fuerza nada.
- Si todo está en orden, mergea el PR con el método de la política del
  proyecto (`--method` lo sobrescribe) y acepta la tarea.
- La autorización queda en el event log con el evento `task.authorized`.
- `--accept-only` acepta la tarea sin tocar el PR (proyectos sin GitHub).

Ver ADR 0019.

## Política de ejecución y progreso

La configuración global de `crew` (`~/.config/crew/config.yaml`) declara cómo
se ejecuta la cola:

```yaml
scheduling:
  concurrency: 2
  mode: serial
```

- `concurrency`: tareas simultáneas (por defecto 1).
- `mode: serial`: dos tareas del mismo proyecto nunca corren a la vez;
  `parallel` lo permite.
- Precedencia: `--scheduling serial|parallel` fija el modo; `--concurrency N`
  implica `parallel`; sin ninguno de los dos, manda la configuración.

Para informar del avance sin volcar logs:

```sh
crew progress tsk_...
```

```text
Task tsk_... [review] Añadir endpoint
Stage: review · attempt 1 · elapsed 2m 14s · updated 2026-01-01T10:00:00.000Z
Next: ready for review: accept it or request changes
Risk: medium (score 2) · verify passed · ci passed
```

Ver ADR 0018.

## Planes de tareas

Una petición con varios cambios se expresa como un plan, se valida y se aplica.

```yaml
schema: crew.plan/v1
tasks:
  - key: api
    title: Añadir GET /health
    brief: Implementa el endpoint de salud
    acceptance:
      - Devuelve 200
  - key: docs
    title: Documentar el endpoint
    brief: Actualiza el README
    acceptance:
      - Menciona el endpoint
    depends_on:
      - api
```

```sh
crew --json plan validate plan.yaml       # grupos de ejecución y avisos de coste
crew --json plan apply plan.yaml --queue  # crea y encola las tareas
```

- `validate` comprueba esquema, criterios obligatorios, dependencias y ciclos, y
  devuelve los grupos: la primera capa son las tareas sin dependencias (en
  paralelo) y cada capa posterior depende de la anterior.
- `apply` crea las tareas, registra las dependencias y con `--queue` las
  encola.
- El motor respeta las dependencias: el daemon no toma una tarea con
  dependencias pendientes y una dependencia fallida la deja en `blocked`.

Ver ADR 0017.

## Intake de proyecto

```sh
# Clona, detecta los comandos de verificación y registra el proyecto
pnpm crew --json project clone https://github.com/acme/widgets
```

- Acepta URLs HTTPS, SSH y la forma corta `owner/repo` de GitHub.
- Comprueba el acceso antes de clonar y registra el proyecto con su rama por
  defecto, remote y forge.
- Escribe `.crew/config.yaml` con los comandos de verificación detectados
  (`package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml`, `Makefile`).
- Nunca instala nada: devuelve la lista `consent` con lo que falta (toolchain,
  `node_modules`) y el comando sugerido, para que la persona lo autorice.

Ver ADR 0016.

## Capa capitán

El capitán es el agente principal: habla con la persona y dirige el trabajo
mediante la CLI de `crew`. El núcleo no cambia: el capitán solo compone comandos
y valida su salida.

```sh
# Un turno: crew compone el prompt y lanza al capitán
pnpm crew ask "añade un endpoint de salud, con tests"

# Multi-turno; /exit para salir
pnpm crew chat

# Instalar las instrucciones del capitán en el repositorio
pnpm crew captain init

# Contexto compacto antes de decidir
pnpm crew --json captain brief
```

La petición de la persona viaja literal: `crew ask` la pone en el prompt, el
capitán la pasa con `--request` al crear la tarea y el worker la recibe en
`## Request (as the person asked it)`. `task create` sin `--request` falla con
`REQUEST_REQUIRED` (solo `--no-request`, para herramientas, se salta la puerta).
Ver ADRs 0034 y 0035.

`captain init` escribe un `AGENTS.md` con las reglas: todo cambio pasa por
`crew task create`/`run`, nunca se editan los worktrees, se consulta el estado
antes de actuar, se escalan solo las decisiones reales y no se mergea sin
comprobar política, CI, verificación y veredicto del tester. No sobrescribe un
`AGENTS.md` existente salvo con `--force`.

`captain brief` devuelve proyectos (rama, forge, entrega, auto-merge, CI y
comandos de verificación), conteo de tareas por estado, lease, runs activos, las
tareas recientes con riesgo, CI, verificación, tester y PR, y una lista
`attention` con lo que necesita decisión humana (`waiting_input`, `blocked`,
`review`, `failed`). Ver ADR 0015.

## Riesgo y resumen de estado

Después de cada commit, `crew` registra el diff contra la rama base (archivos,
líneas y rutas tocadas) como artefacto `change`. Con esos datos y las señales de
la tarea (hallazgos del tester, verificaciones y CI) calcula una
clasificación de riesgo determinista:

| Nivel | Puntuación |
|---|---|
| `low` | menos de 2 puntos |
| `medium` | 2 o 3 puntos |
| `high` | 4 puntos o más |

Cada regla suma puntos: rutas sensibles (autenticación, migraciones,
infraestructura, CI) +4, manifiestos de dependencias +2, tamaño del cambio
(+2/+3 por más de 5/20 archivos), churn (+1/+2 por más de 100/500 líneas),
avisos del tester (+2/+3), hallazgo bloqueante +4, verificación fallida +2 y
CI fallido +2. El resumen incluye siempre los motivos.

El riesgo informa, no decide: el merge sigue exigiendo tester aprobado,
verificaciones en verde y CI en verde.

```sh
# Resumen de una tarea
pnpm crew --json task show tsk_... | jq '.summary'

# Vista global
pnpm crew status --limit 5
```

El resumen (`TaskSummary`) es el mismo que consumen la CLI, el daemon y el
capitán. Ver ADR 0013.

## Arquitectura

```
CLI
 ├─ app/            casos de uso (projects, run-stage, pipeline, daemon)
 ├─ core/           tipos, IDs ULID, máquina de estados, redacción
 ├─ store/          SQLite: event log + proyecciones
 ├─ git/            worktrees, commit, GitHub (gh)
 ├─ spec/           carga y validación de specs
 ├─ brief/          briefs estructurados por metodología
 ├─ protocol/       validación del reporte y gates de metodología
 ├─ verify/         ejecución determinista de comandos de verificación
 ├─ adapters/       harness (fake, opencode) y backend (process)
 ├─ config/         rutas XDG y configuración
 └─ doctor/         diagnóstico
```

Decisiones clave:

- **Event log + proyecciones**, no event sourcing completo. Cada comando escribe
  eventos y actualiza tablas en una transacción SQLite.
- **SQLite es la fuente de verdad**; los ficheros son logs y artefactos.
- **Un worktree por tarea**; el checkout principal no se toca.
- **Contrato de reporte explícito**: `crew report` o un fichero JSON en
  `CREW_REPORT_PATH`.
- **Metodología verificable**: la spec y sus criterios se guardan en SQLite y se
  enforcean al registrar el reporte, no solo en el prompt.
- **Fail-closed**: sin reporte válido no hay `done`, la evidencia incompleta
  falla, los comandos `verify` deben pasar, el tester debe aprobar, y `clean` no
  borra trabajo sucio sin `--force`.
- **Un daemon por base de datos** con lease y heartbeat; la recuperación es
  explícita (`daemon reconcile` + `task retry`), nunca un reencolado silencioso.
- **Motor y capitán separados**: el motor determinista ejecuta operaciones y
  guarda evidencia; la futura capa capitán solo interpreta intención y llama al
  motor (ADR 0009).

## Contratos

En `contracts/`:

- `report.v1.schema.json`, `report.v2.schema.json` y `report.v3.schema.json`
- `spec.v1.schema.json`
- `brief.v1.schema.json`
- `harness.v1.schema.json`
- `event.v1.schema.json`

## Rutas

| Qué | Ruta |
|---|---|
| Config global | `~/.config/crew/config.yaml` |
| Datos | `~/.local/share/crew/` |
| Estado | `~/.local/state/crew/crew.db` |
| Worktrees | `~/.local/share/crew/worktrees/` |
| Config de proyecto | `<repo>/.crew/config.yaml` |

Se pueden sobreescribir con `CREW_CONFIG_DIR`, `CREW_DATA_DIR`, `CREW_STATE_DIR`
y `CREW_DB_PATH`, o con `--db`.

## Desarrollo

`pnpm crew` ejecuta el CLI directamente desde TypeScript.

```sh
pnpm crew version
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm test:e2e
```

## Licencia

MIT.
