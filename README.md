# crew

Orquestador de múltiples agentes agnóstico al lenguaje. Esta entrega cubre la
**Fase 0** y parte de la **Fase 1**: metodología de desarrollo declarativa
(`free`, `spec`, `tdd`) y ejecución con harness reales (`opencode`), incluida la
detección y selección automática. El núcleo sigue siendo pequeño y verificado,
sin daemon ni supervisión real.

El diseño combina dos ideas:

- El **plano de ejecución** de [firstmate](https://github.com/kunchenguid/firstmate/):
  tareas, worktrees, ciclo de vida, reportes y recuperación.
- El **plano de entorno** de [gentle-ai](https://github.com/Gentleman-Programming/gentle-ai):
  contratos versionados, manifiestos de harness y distribución multiplataforma.

## Estado

Fase 0 completada y Fase 1 en curso:

- Proyectos registrados y tareas con estado durable en SQLite.
- Worktree aislado por tarea.
- Metodologías `free`, `spec` y `tdd`, con gates de evidencia.
- Brief generado y contratos de reporte `crew.report/v1` y `crew.report/v2`.
- Harness `opencode` real, además del agente falso.
- Detección de binarios, `--harness auto` y `crew harness list`.
- Agente falso con escenarios de éxito, fallo, bloqueo, input, crash,
  reporte malformado, progreso y timeout.
- CLI con salida humana y `--json`.
- Event log append-only y `doctor`.
- Tests unitarios y e2e.

Fuera de alcance todavía: daemon, watcher, supervisión, PTY, provisioning,
review, PRs, merge, memoria, UI web y hosts remotos.

## Requisitos

- Node.js >= 24 (probado con Node 26, que incluye `node:sqlite`).
- pnpm.
- git.
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
| `crew task create --project <ref> --title <t> (--brief <texto> \| --brief-file <path> \| --spec-file <path>) [--methodology free\|spec\|tdd] [--acceptance <texto>] [--non-goal <texto>] [--delivery local]` | Crea una tarea en `draft` |
| `crew task list [--state <state>]` | Lista tareas |
| `crew task show <id>` | Detalle, runs, reporte, mensajes, artefactos y eventos |
| `crew task run <id> [--harness fake\|opencode\|auto] [--timeout <s>] [--env K=V] [--quiet]` | Ejecuta la tarea en un worktree |
| `crew task answer <id> --text <texto>` | Responde y encola un nuevo intento |
| `crew task cancel <id>` | Cancela la tarea y su proceso activo |
| `crew task clean <id> [--force]` | Elimina el worktree; nunca borra la rama |
| `crew report --task <id> --run <id> [--file <path\|->] [--status <s>] [--summary <t>]` | Registra un reporte |
| `crew events [--task <id>] [--follow] [--limit <n>]` | Muestra el event log |
| `crew doctor` | Comprueba base de datos, harnesses, runs, worktrees y proyectos |
| `crew version` | Muestra la versión |

Códigos de salida de `task run`: `0` si la tarea termina en `done`, `2` si queda
en `waiting_input` o `blocked`, `1` para `failed`/`cancelled`.

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
```

`opencode` se lanza con `--auto` para que pueda editar el worktree sin
confirmaciones interactivas. Las reglas de permisos que el usuario haya denegado
explícitamente en su configuración de opencode se siguen respetando.

## Metodología

Cada tarea declara cómo debe trabajar el agente:

- `free`: brief libre y reporte `crew.report/v1` o v2. Compatible con Fase 0.
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
La evidencia es autodeclarada: la verificación independiente de tests queda para
una fase posterior.

## Arquitectura

```
CLI
 ├─ app/            casos de uso (projects, run-task)
 ├─ core/           tipos, IDs ULID, máquina de estados, redacción
 ├─ store/          SQLite: event log + proyecciones
 ├─ git/            worktrees, ramas, preflight
 ├─ spec/           carga y validación de specs
 ├─ brief/          briefs estructurados por metodología
 ├─ protocol/       validación del reporte y gates de metodología
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
  falla, y `clean` no borra trabajo sucio sin `--force`.

## Contratos

En `contracts/`:

- `report.v1.schema.json` y `report.v2.schema.json`
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
