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
  --request "añade un endpoint de salud que devuelva 200 y el estado" \
  --brief "Devuelve 200 y un JSON con el estado" \
  --methodology spec

crew task run tsk_... --harness auto
```

`--request` son las palabras de la persona, sin retocar: el brief del worker las
lleva literales, antes del objetivo. Sin `--request` la CLI rechaza la tarea
(`REQUEST_REQUIRED`); `--no-request` solo es para herramientas que no hablan con
nadie. Lo normal es que la tarea la cree el capitán (`crew ask`).

Con el harness `opencode`, el brief (que empieza por `---` de YAML) llega al
agente por la entrada estándar, no como argumento: el agente lo lee y deja el
informe en el worktree.

O encola y deja que el daemon la coja:

```sh
crew task queue tsk_...
crew daemon run --once      # procesa lo que haya en la cola
```

### 3.3 La autoridad del merge

Un gate no es "los checks pasan": es **quién tiene la autoridad para
firmar**. Son tres cosas y se resuelven en orden:

1. **La ruta** (en `.crew/config.yaml` del proyecto) dice cuánto rigor
   técnico exige el trabajo:

   ```yaml
   delivery:
     mode: no-mistakes      # no-mistakes | direct-PR | local-only
     yolo: false
   ```

   - `no-mistakes`: verificación + tester independiente + CI + PR.
   - `direct-PR`: PR sin reviewer independiente (la vía rápida).
   - `local-only`: todo el rigor, pero la rama aterriza en local.

2. **La autoridad** decide quién firma. Sin `yolo`, solo una persona fusiona.
   Con `yolo`, el capitán fusiona lo verde y en alcance por su cuenta.

3. **El veto** es absoluto: `yolo` no autoriza un PR rojo, ni un check
   requerido sin reportar, ni un cambio de riesgo `high`. Esos tres escalan
   siempre.

Tu firma es el artefacto que deja la revisión en el editor, no una palabra.

### 3.4 Revisar y decidir

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

### 3.5 Preguntas del agente

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

El capitán es el agente principal. `crew` lo lanza con un prompt que ya trae su
contrato, el contexto del proyecto y la petición tal cual la escribiste:

```sh
crew ask "añade un endpoint de salud, con tests"   # un turno
crew chat                                          # conversación multi-turno
```

`crew ask` te devuelve la respuesta del capitán (suele crear y encolar la
tarea). `crew chat` mantiene el hilo: con `opencode` continúa la sesión; con
cualquier otro harness el historial se recompone en cada turno. `/exit` para
salir.

El capitán usa la CLI determinista, no edita código y no mergea sin tu firma.
Si quieres que la conversación viva dentro de tu editor, también puedes
instalar sus instrucciones en el repo:

```sh
crew captain init          # escribe AGENTS.md en el repo
crew captain brief         # contexto compacto para decidir
```

Su contrato se puede ajustar por proyecto editando ese `AGENTS.md`
(`crew role show captain` te dice de dónde sale).

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

## 8. Skills y conocimiento del proyecto

Los skills son los procedimientos que solo aplican en una situación
concreta: revisar, mergear, decidir si algo es una investigación.

```sh
crew --json skills list      # los que ven tus agentes
```

El brief de cada agente lleva los skills disponibles, así que puede cargarlos
cuando la situación lo pide. Los del crew se instalan como cualquier otro
skill del ecosistema:

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
| `stow` | barrer la sesión y archivar lo aprendido |

### El `stow`

Al cerrar una sesión con trabajo hecho, el skill `stow` barre lo que se
aprendió y lo archiva donde toca: la memoria del proyecto (convenciones,
decisiones, trampas), las tareas (lo que queda abierto) o `.stow-notes.md`
(la reserva privada). Pregunta una vez si el destino es ambiguo y cierra con
un veredicto honesto de qué se capturó y qué no.

## 9. Los contratos de rol

Cada rol de `crew` tiene un contrato con la forma de un `AGENTS.md`: reglas
duras por prioridad, procedimiento, definición de terminado y qué se
reporta. Viaja en el brief del agente, así que siempre se lee.

```sh
crew --json role list                  # contratos y de dónde salen
crew --json role show tester           # el contrato del tester
crew --json role init tester           # lo escribe en el proyecto, para editarlo
```

| Rol | Sus reglas duras |
| --- | --- |
| `developer` | no escribe fuera de su worktree, no toca el pipeline, nada hecho sin evidencia, no se sale del brief |
| `tester` | no modifica el código, no confía en el informe del developer, verifica él mismo, rechaza con un hallazgo bloqueante |
| `scout` | solo lee, el informe es el entregable, no arregla "de paso" |

Si un proyecto quiere otra disciplina, `crew role init <rol>` escribe el
contrato en `.crew/roles/<rol>.md` y ese manda sobre el del motor.

## 10. Memoria del proyecto

Notas durables que llegan al brief de cada agente (convenciones, decisiones,
trampas):

```sh
crew memory add --project mi-proyecto --kind convention \
  --title "Commits en inglés" --body "Usamos imperative mood."
crew memory list --project mi-proyecto
```

---

## 11. Investigación sin cambios

```sh
crew scout --project mi-proyecto --title "Cómo funciona el cache" \
  --brief "Investiga y documenta"
```

Un `scout` no toca código: produce un informe y termina en `review`.

---

## 12. Workers remotos

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

## 13. Panel web

```sh
crew ui --port 4173
```

Solo lectura: resumen, tareas, gates, riesgo, CI. Bind a `127.0.0.1`.

---

## 14. Referencia rápida

| Quiero… | Comando |
| --- | --- |
| Hablar con el capitán | `crew ask "<petición>"` / `crew chat` |
| Ver el estado | `crew status` |
| Ver una tarea (y su petición) | `crew task show <id>` |
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

## 15. Problemas frecuentes

**"verification is none" y no deja mergear.** El proyecto no tiene comandos
`verify`. Añádelos a `.crew/config.yaml`.

**"merge authority: the captain must authorize".** Sin `yolo`, el merge lo
firma una persona: `crew task review <id>` (abre el diff en el editor) o
`crew task merge <id>` después de una revisión previa. Con `yolo: true` en la
config del proyecto, el capitán puede fusionar lo verde sin preguntar.

**"CI is configured but no check has reported".** El CI todavía no ha
reportado. Espera a que reporte: ese veto no se salta con `yolo`.

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

## 16. Cómo se desarrolla `crew`

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
