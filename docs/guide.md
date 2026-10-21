# Guía de uso de `crew`

`crew` es un orquestador de agentes: tú le dices **qué** quieres, el motor
determinista se encarga del **cómo** (worktree aislado, agente, verificación,
tester, commit, pull request, gates) y tú decides **cuándo** se acepta un
cambio.

Esta guía es la ruta corta para working con él. No es la referencia completa
(eso es el [README](../README.md) y los ADR en `docs/adr/`), es el "haz esto,
esto es lo que pasa".

---

## 1. Instalación (una vez)

```sh
cd /ruta/al/repo/crew
pnpm install
pnpm build
npm link          # deja `crew` en el PATH, apuntando a este repo
```

`npm link` crea un enlace global: el comando `crew` **ejecuta el código de este
repo**, así que después de cambiar código solo necesitas:

```sh
pnpm build        # reconstruye dist/crew.js
```

> Si mueves o borras el repo, el enlace global se rompe. Rehaz `npm link` o
> instala el paquete de otra forma.

Comprueba que todo está en su sitio:

```sh
crew doctor      # base de datos, harnesses, paths, worktrees
crew version
```

---

## 2. Configuración global

La configuración global vive en `~/.config/crew/config.yaml` y afecta a todos
los proyectos. No hace falta editar el YAML a mano:

```sh
crew config show                      # lo que hay y lo que se está usando
crew config set harness opencode      # el harness por defecto
crew config set timeout_seconds 900   # timeout por tarea
crew config set scheduling.concurrency 2
crew config set scheduling.mode parallel
crew config path
```

Claves que se pueden fijar: `harness`, `timeout_seconds`, `delivery`,
`review.max_iterations`, `scheduling.concurrency`, `scheduling.mode` y
`agents.{developer,tester}.{harness,agent,model}`.

---

## 3. El bucle de trabajo

### 3.1 Registrar un proyecto

```sh
cd /ruta/al/proyecto
git init                      # el proyecto tiene que ser un repo
crew init                     # escribe .crew/config.yaml
crew project add . --name mi-proyecto
```

`crew init` detecta el harness, la metodología y deja `verify: []`. Edita
`.crew/config.yaml` para poner los comandos de verificación del proyecto:

```yaml
schema: crew.project/v1
name: mi-proyecto
default_branch: main
methodology: spec
verify:
  - npm test
  - npm run lint
```

Sin `verify`, el gate de verificación bloquea el merge (por diseño: no se
acepta lo que no se ha comprobado).

### 3.2 Crear y ejecutar una tarea

```sh
crew task create --project mi-proyecto \
  --title "Añadir GET /health" \
  --brief "Devuelve 200 y un JSON con el estado" \
  --methodology spec

crew task run tsk_... --harness auto
```

O encola y deja que el daemon la coja:

```sh
crew task queue tsk_...
crew daemon run --once      # procesa lo que haya en la cola
```

### 3.3 Revisar y decidir

Cuando la tarea llega a `review` (y solo entonces), se abre en tu editor:

```sh
crew task review tsk_...
```

El buffer lleva el brief, el riesgo, los gates y el diff. Escribes:

```
crew-decision: accept      # o reject
crew-reason: encaja con el brief
```

- `accept` → mergea pasando los gates (verificación + tester + CI).
- `reject` → la tarea vuelve a la cola con tu motivo, y el agente lo recibe.
- Si cierras sin escribir nada → **no pasa nada**. El valor por defecto nunca
  es aceptar.

El editor se elige con `CREW_EDITOR` > `VISUAL` > `EDITOR` > `nvim`.

### 3.4 Preguntas del agente

Si el agente necesita una decisión, la tarea pasa a `waiting_input`:

```sh
crew task answer tsk_...        # abre el editor con las preguntas
crew task answer tsk_... --text "usa el adaptador que ya existe"
```

---

## 4. El daemon (y por qué como servicio)

El daemon es el que recoge las tareas encoladas, las ejecuta y aplica los
reintentos. Como servicio del sistema sobrevive al cierre de la terminal:

```sh
crew service install        # launchd en macOS, systemd --user en Linux
crew service status
crew service logs --lines 50
crew service uninstall
```

Sin servicio, `crew daemon run` en otra terminal vale, pero se muere al
cerrarla.

Políticas útiles:

```sh
crew daemon run --concurrency 2 --scheduling parallel
crew daemon run --max-attempts 3 --backoff 60   # reintentos con backoff
```

---

## 5. Ver el agente trabajar

```sh
crew task run tsk_... --session herdr    # o --session tmux, o --session auto
crew sessions list
```

Con **Herdr**, la sesión es un workspace etiquetado `crew-<taskId>-<rol>`: lo
ves en tu TUI, con su estado real (`working`, `blocked`, `done`, `idle`), y
puedes entrar. Con **tmux**, es una sesión `crew-<taskId>-<rol>` y se abre con
`tmux attach -t <nombre>`.

`auto` (el default) usa Herdr si su servidor está corriendo y cae a tmux si no.

---

## 6. El capitán (hablar con el crew)

El capitán es una sesión de `opencode` con instrucciones del proyecto:

```sh
crew captain init          # escribe AGENTS.md en el repo
crew captain brief         # contexto compacto para decidir
```

En `opencode`, abre el repo y habla con el capitán: "añade un endpoint de
salud, con tests". El capitán usa la CLI determinista, no edita código.

---

## 7. Varias tareas de golpe (planes)

```yaml
# plan.yaml
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
    depends_on:
      - api
```

```sh
crew plan validate plan.yaml
crew plan apply plan.yaml --queue
```

El motor respeta las dependencias y lanza en paralelo lo que puede.

---

## 8. Memoria del proyecto

Notas durables que llegan al brief de cada agente (convenciones, decisiones,
trampas):

```sh
crew memory add --project mi-proyecto --kind convention \
  --title "Commits en inglés" --body "Usamos imperative mood."
crew memory list --project mi-proyecto
```

---

## 9. Investigación sin cambios

```sh
crew scout --project mi-proyecto --title "Cómo funciona el cache" \
  --brief "Investiga y documenta"
```

Un `scout` no toca código: produce un informe y termina en `review`.

---

## 10. Workers remotos

Si el host remoto tiene el repo, el worktree, el commit y el push ocurren
allí:

```yaml
# .crew/config.yaml del proyecto
runner:
  host: builder@server
  repo_path: /srv/repos/mi-proyecto
  worktree_root: /srv/worktrees
```

```sh
crew task run tsk_... --host builder@server   # sobrescribe el host
crew doctor                                   # comprueba que el host responde
```

Sin `repo_path`, el host remoto tiene que ver la misma ruta del worktree
(sistema de archivos compartido).

---

## 11. Panel web

```sh
crew ui --port 4173
```

Solo lectura: resumen, tareas, gates, riesgo, CI. Bind a `127.0.0.1`.

---

## 12. Referencia rápida

| Quiero… | Comando |
| --- | --- |
| Ver el estado | `crew status` |
| Ver una tarea | `crew task show <id>` |
| Ver el progreso en lenguaje claro | `crew progress <id>` |
| Ejecutar una tarea | `crew task run <id> --harness auto` |
| Revisarla en el editor | `crew task review <id>` |
| Aceptarla desde la terminal | `crew task merge <id>` |
| Rechazarla | `crew task reject <id> "motivo"` |
| Responder al agente | `crew task answer <id>` |
| Procesar la cola | `crew daemon run --once` |
| Ver el log de eventos | `crew events --follow` |
| Ver las sesiones | `crew sessions list` |
| Instalar el servicio | `crew service install` |
| Comprobar el estado local | `crew doctor` |

---

## 13. Problemas frecuentes

**"verification is none" y no deja mergear.** El proyecto no tiene comandos
`verify`. Añádelos a `.crew/config.yaml`.

**"Another daemon holds the lease".** Ya hay un daemon corriendo. `crew
daemon status` para verlo; `crew service status` si es el servicio.

**El agente no arranca con `--session herdr`.** El servidor de Herdr no está
corriendo: `herdr` en otra terminal. Con `--session tmux` funciona igual.

**Una tarea se queda en `failed`.** `crew task show <id>` trae `lastError` y
`crew events --task <id>` el historial. Si es reintentable:
`crew task retry <id>`.

**"FATAL ERROR: Ineffective mark-compacts".** Memoria insuficiente en el
proceso del agente: sube `--timeout` no ayuda, pero `--max-iterations` bajo y
`--concurrency 1` sí.

**Quiero empezar de cero con un proyecto.** `crew project add`, `crew task
clean <id> --force` para los worktrees, y `crew doctor` para ver qué queda.

---

## 14. Cómo se desarrolla `crew`

```sh
pnpm test          # 260 tests
pnpm typecheck
pnpm lint
pnpm build         # reconstruye dist/crew.js (necesario tras npm link)
```

Estructura:

| Ruta | Qué hay |
| --- | --- |
| `src/app/` | El motor: pipeline, daemon, merge, review, sessions, workspace |
| `src/adapters/` | Harnesses (fake, opencode) y el backend de procesos |
| `src/store/` | SQLite, eventos, informes, memoria |
| `src/git/`, `src/forges/` | Git y forjas (GitHub, GitLab) |
| `src/cli/main.ts` | La CLI |
| `docs/adr/` | Las decisiones, con su porqué |
| `docs/roadmap.md` | El estado de las fases |

Si cambias una decisión con consecuencias, escribe un ADR: es más rápido
que leer el código dentro de seis meses.
