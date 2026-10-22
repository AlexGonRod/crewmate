# ADR 0033 — Los skills son la capa de procedimientos del crew

Estado: aceptada. Complementa al ADR 0032.

## Contexto

El crew sabía dónde guardaba el conocimiento del proyecto (la memoria, ADR
0021) y cómo llegaba a los agentes (el brief). Pero le faltaba la capa
intermedia: los **procedimientos** que solo aplican en una situación concreta
—cómo revisar una tarea, cuándo fusionar sin preguntar, cómo decidir si algo
es una investigación—.

Esos procedimientos estaban:

1. en la cabeza del capitán, o
2. repartidos por el `AGENTS.md` del proyecto, que lo paga **cada** sesión de
   **cada** agente.

La segunda opción es la que firstmate découverte y resolvió con dos ideas: los
skills con **disparador declarado** (una condición exacta de carga) y la
**regla de un solo dueño** (cada hecho tiene un dueño; el resto son
referencias cruzadas de una línea).

Y había un hueco más: el crew no tenía ninguna noción de skill. La palabra
"skill" no aparecía en `src/`, y sin embargo los agentes que ejecuta el crew
(opencode) cargan skills de forma nativa: los del proyecto
(`.opencode/skills`, `.claude/skills`, `.agents/skills`) y los globales
(`~/.config/opencode/skills`, `~/.claude/skills`, `~/.agents/skills`). El
crew los ignoraba y, con ellos, el brief no le decía al agente que existía
nada que cargar.

## Decisión

1. **El crew conoce los skills.** `src/app/skills.ts` descubre los skills
   siguiendo las mismas reglas que el agente: tres directorios globales y tres
   de proyecto, un `SKILL.md` por skill, frontmatter con `name` y
   `description`, el proyecto por encima de lo global. Los symlinks rotos y
   los skills sin frontmatter no son skills.

2. **`crew skills list` los enseña**, con su ámbito, su descripción y su
   ruta. `crew doctor` avisa cuando no hay ninguno: un agente sin skills no
   es un error, pero conviene saberlo.

3. **El brief lleva los skills disponibles.** Una sección corta (máximo diez,
   con la descripción truncada) para que el agente sepa qué puede cargar. El
   coste lo paga cada brief, así que la lista está acotada: los skills son un
   índice, no el contenido.

4. **Los skills del crew son públicos y se instalan.** `skills/<nombre>/SKILL.md`
   es la capa de procedimientos que un usuario instala en su proyecto, igual
   que firstmate separa los skills públicos de los internos. El crew trae:
   `crew-review`, `crew-merge-authority`, `crew-guidelines`, `crew-memory`,
   `crew-scout` y `stow`.

5. **Cada skill declara su disparador.** La descripción dice la condición
   exacta bajo la que se carga ("antes de fusionar", "cuando el CI no ha
   reportado"), nunca un puntero vaga. Un skill sin disparador es peso muerto.

6. **El `AGENTS.md` del capitán sube a hard rules con prioridad.** Lo que
   firstmate tiene y el crew no: reglas duras numeradas y en orden de
   prioridad (nunca escribir en el proyecto, nunca fusionar sin la palabra de
   la persona, nunca tirar trabajo sin aterrizar, informar con verdad), el
   árbol de decisión de dónde vive cada hecho, la regla de un solo dueño y la
   disciplina del tamaño.

7. **El `stow` se adapta, no se copia.** El skill público de firstmate barre
   la sesión y archiva el conocimiento durable. La adaptación conserva la
   estructura (barrer, descubrir convenciones, enrutar con prioridad fija,
   preguntar una vez ante ambigüedad, inspeccionar antes de escribir, curar
   todo lo que se abrió, cerrar con un veredicto honesto y un puntero de
   reanudación) y cambia los destinos: la memoria del proyecto en vez de un
   fichero de memoria, las tareas en vez de un `TODO`, y los tipos de nota
   como niveles (`convention` y `decision` fijadas, `pitfall` envejece a los
   30 días, `context` perece a los 7).

8. **La write-back sigue siendo de la persona.** El `stow` propone y archiva
   lo que la persona aprueba; no escribe en un skill ni decide por su cuenta.

## Consecuencias

- El capitán tiene un contrato con la misma forma que el de firstmate:
  reglas duras arriba, procedimiento abajo, y un puntero a los skills para lo
  que solo aplica en una situación.
- Los agentes del crew ven en el brief qué skills pueden cargar, que antes era
  invisible para ellos.
- Los skills del crew se instalan como cualquier otro skill del ecosistema
  (`npx skills add`), así que sirven para tu opencode, para tu Claude y para
  los agentes del crew.
- El `stow` adaptado no depende de firstmate: usa la memoria y las tareas del
  crew.

## Alternativas descartadas

- **Meter los procedimientos en el `AGENTS.md` del proyecto**: es lo que hace
  el crew hasta ahora, y lo que firstmate evita explícitamente. El coste lo
  pagan todas las sesiones.
- **Un único skill gigante con todo**: se carga siempre y no se puede
  descartar cuando el trabajo no lo necesita.
- **Copiar los skills de firstmate tal cual**: sus skills asumen una home de
  firstmate, sus scripts y su vocabulario. Installados fuera, son engañosos
  (su propio `firstmate-coding-guidelines` lo dice: `internal: true`).
