# crew

Orquestador de múltiples agentes agnóstico al lenguaje. Esta entrega cubre la
**Fase 0** y la **Fase 1**: metodología de desarrollo declarativa
(`free`, `spec`, `tdd`), pipeline developer → tester → git/PR, ejecución con
harness reales (`opencode`) con detección automática, y un daemon con lease que
procesa la cola y reconcilia runs perdidos. El núcleo sigue siendo pequeño y
verificado.

El diseño combina dos ideas:

- El **plano de ejecución** de [firstmate](https://github.com/kunchenguid/firstmate/):
  tareas, worktrees, ciclo de vida, reportes y recuperación.
- El **plano de entorno** de [gentle-ai](https://github.com/Gentleman-Programming/gentle-ai):
  contratos versionados, manifiestos de harness y distribución multiplataforma.

## Estado

Fase 0 completada y pipeline de Fase 1 implementado:

- Proyectos registrados y tareas con estado durable en SQLite.
- Worktree aislado por tarea.
- Metodologías `free`, `spec` y `tdd`, con gates de evidencia.
- Pipeline developer → verificación determinista → tester independiente → commit
  → revisión humana.
- Briefs por rol y contratos de reporte `crew.report/v1`, v2 y v3.
- Comandos `verify` del proyecto ejecutados por el orquestador, con exit code,
  salida y log durable.
- Rechazo del tester o de la verificación con feedback y límite configurable de
  iteraciones.
- Entrega `local` o `pr` (GitHub mediante `gh`); `task accept` exige PR mergeado
  salvo `--force`.
- Harness `opencode` real, además del agente falso.
- Detección de binarios, `--harness auto` y `crew harness list`.
- Cola de tareas y daemon con lease único, heartbeat y parada ordenada.
- Reconciliación de runs perdidos y `task retry` explícito.
- Agente falso con escenarios de desarrollador y tester.
- CLI con salida humana y `--json`.
- Event log append-only y `doctor`.
- Tests unitarios y e2e.

Fuera de alcance todavía: PTY, provisioning, merge automático, memoria, UI web,
hosts remotos y daemon como servicio del sistema (systemd/launchd).

## Requisitos

- Node.js >= 24 (probado con Node 26, que incluye `node:sqlite`).
- pnpm.
- git.
- `gh` autenticado solo si se usa `--delivery pr`.
- tmux (opcional, para fases posteriores).

## Instalación

```sh
pnpm install
```

## Uso rápido

Dentro de un repositorio git:

```sh
pnpm crew init
pnpm crew --json project add . --name demo
pnpm crew --json task create \
  --project demo \
  --title "Mi primera tarea" \
  --brief "Crea un fichero de ejemplo" \
  --acceptance "El fichero existe" \
  --acceptance "El fichero tiene contenido"
pnpm crew --json task run tsk_... --harness fake --env CREW_FAKE_SCENARIO=spec_success
pnpm crew --json task show tsk_...
pnpm crew --json task accept tsk_...
pnpm crew task clean tsk_... --force
```

`--json` es una opción global y debe ir antes del subcomando.

## Comandos

| Comando | Descripción |
|---|---|
| `crew init [--force]` | Escribe `.crew/config.yaml` en el repo actual |
| `crew project add <path> [--name]` | Registra un repositorio |
| `crew project list` | Lista proyectos |
| `crew harness list` | Lista harnesses, disponibilidad y capacidades |
| `crew task create --project <ref> --title <t> (--brief <texto> \| --brief-file <path> \| --spec-file <path>) [--methodology free\|spec\|tdd] [--acceptance <texto>] [--non-goal <texto>] [--delivery local\|pr]` | Crea una tarea en `draft` |
| `crew task list [--state <state>]` | Lista tareas |
| `crew task show <id>` | Detalle, runs, reporte, mensajes, artefactos y eventos |
| `crew task run <id> [--harness <id>] [--tester-harness <id>] [--agent <n>] [--model <n>] [--tester-agent <n>] [--tester-model <n>] [--max-iterations <n>] [--delivery local\|pr] [--timeout <s>] [--env K=V] [--quiet]` | Ejecuta el pipeline en un worktree |
| `crew task queue <id>` | Encola una tarea en `draft` para el daemon |
| `crew task retry <id>` | Reencola una tarea `failed` |
| `crew task answer <id> --text <texto>` | Responde y encola un nuevo intento |
| `crew task cancel <id>` | Cancela la tarea y su proceso activo |
| `crew task clean <id> [--force]` | Elimina el worktree; nunca borra la rama |
| `crew task accept <id> [--force]` | Acepta una tarea en `review`; con `pr`, verifica que el PR esté mergeado |
| `crew task reject <id> [motivo...] [--reason <texto>]` | Rechaza, guarda feedback y reencola al developer |
| `crew daemon run [--once] [--interval <s>] [--max-tasks <n>] [--harness <id>] [--tester-harness <id>] [--max-iterations <n>] [--quiet]` | Procesa la cola de tareas |
| `crew daemon status` | Muestra lease, runs activos y tareas en cola |
| `crew daemon reconcile [--stale-after <s>]` | Marca runs muertos como perdidos y falla sus tareas |
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
   - `pr`: se hace push y se abre un PR en GitHub con `gh`.
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

`auto_merge` y `scout` se rechazan explícitamente con `DELIVERY_UNSUPPORTED`.

## Daemon

El daemon procesa tareas en estado `queued` de forma secuencial:

```sh
pnpm crew --json task queue tsk_...
pnpm crew daemon run --harness fake --env CREW_FAKE_SCENARIO=success
pnpm crew daemon status
```

- Solo puede haber un daemon por base de datos. El lease (`leases`) incluye
  owner `host:pid`, TTL y heartbeat; si está ocupado, falla con `DAEMON_RUNNING`.
- En cada ciclo reconcilia runs activos: si el PID ya no existe (o nunca se
  registró y superó `--stale-after`), marca el run como `lost` y la tarea como
  `failed` con el motivo. `crew task retry <id>` la reencola.
- `--once` procesa como mucho una tarea y sale; sin tareas termina con
  `stopped: idle`.
- `SIGINT`/`SIGTERM` paran el bucle, terminan el grupo de proceso del agente
  activo y esperan a que se registre el fallo. La tarea queda `failed` y se puede
  reintentar.

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

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm test:e2e
```

## Licencia

MIT.
