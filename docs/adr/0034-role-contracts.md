# ADR 0034 — Un contrato de rol por rol, como AGENTS.md

Estado: aceptada. Complementa al ADR 0033.

## Contexto

El capitán tiene un `AGENTS.md` propio (`crew captain init`): reglas duras por
prioridad, árbol de decisión del conocimiento, comandos. Los workers no
tenían nada equivalente. Su instrucción vivía en tres párrafos dentro del
brief:

- el developer: "implementa la tarea dentro del worktree" y "no hagas push,
  merge ni pull requests";
- el tester: "eres el tester independiente… no modifiques ficheros" y cuatro
  pasos;
- el scout: "investiga con herramientas de solo lectura" y cuatro pasos.

Tres problemas:

1. **Poco específico para lo que cuesta caro.** El developer no tenía
   prohibido reescribir el pipeline ni cambiar la configuración del proyecto
   para que sus checks pasar. El tester no tenía dicho que no debe fiarse del
   informe del developer ni cómo se rechaza de forma útil. El scout no tenía
   la regla de no arreglar "de paso".
2. **Repartido y en inglés.** La política del rol estaba en prosa suelta del
   brief, en el idioma del sobre técnico, mientras que la política del
   capitán estaba en un documento propio, en el idioma de la persona.
3. **No se podía ajustar por proyecto.** El captain sí tenía su `AGENTS.md`;
   los workers no. Un proyecto que necesita otra disciplina (un tester que
   además revisa seguridad, un developer que debe tocar también la
   documentación) no tenía dónde decirlo.

## Decisión

1. **Cada rol tiene un contrato, con la forma de un `AGENTS.md`.** Tres
   contratos: `developer`, `tester` y `scout`. El scout es un developer que
   solo lee, así que es un contrato aparte, no un modo del de developer.

2. **El contrato es un documento, no un párrafo.** Misma forma que el del
   capitán: reglas duras por orden de prioridad, procedimiento, definición de
   terminado y qué se reporta. Vive en `src/app/role-agents.ts`, que es su
   único dueño.

3. **El contrato viaja en el brief.** El brief es lo que el agente lee
   siempre; un contrato aparte que hay que abrir es un contrato que se
   cumple a medias. La sección `## Role contract (<rol>)` lleva el contrato
   entero. El fichero `.crew/brief.md` del worktree lo lleva también, así que
   es legible por una persona.

4. **El proyecto puede tener su propio contrato.** Si existe
   `<proyecto>/.crew/roles/<rol>.md`, ese manda sobre el del motor. Es la
   misma idea que el `AGENTS.md` del capitán, pero por rol: el proyecto
   ajusta la disciplina de sus workers sin tocar el código de `crew`.

5. **`crew role list|show|init`.** `list` dice qué contratos hay y de dónde
   salen; `show` imprime el que aplica; `init` escribe el contrato por
   defecto en `.crew/roles/<rol>.md` del repositorio actual para que la
   persona lo edite (y `--force` para sobrescribir).

6. **El contexto del run se inyecta en el contrato.** La iteración de
   revisión (el developer tiene que atender el feedback del tester), la
   metodología (el brief sigue siendo el dueño de `tdd` y `spec`) y el
   informe del developer (el tester lo necesita) se renderizan dentro del
   contrato, no en un párrafo aparte.

7. **La metodología no se duplica.** El brief sigue siendo el dueño de la
   metodología (rojo/verde, criterios); el contrato dice cómo se trabaja y
   remite a ella.

## Consecuencias

- El developer, el tester y el scout tienen la misma estructura de autoridad
  que el capitán: reglas duras arriba, procedimiento abajo.
- La palabra "independiente" del tester significa algo concreto: no confía en
  el informe del developer y ejecuta las verificaciones él mismo.
- Un proyecto puede endurecer o relajar la disciplina de sus workers sin
  tocar `crew`.
- `crew role show tester` es la respuesta a "qué se le pide al tester".

## Alternativas descartadas

- **Un único AGENTS.md para todos los agentes**: mezcla reglas que se
  contradicen (el developer no puede tocar el código; el tester sí lo lee).
- **Dejar los contratos solo en el repo del proyecto**: entonces el motor no
  puede garantizar nada, y un proyecto nuevo arranca sin disciplina.
- **Skills por rol en vez de contratos**: un skill se carga cuando su
  disparador se cumple; el contrato del rol se carga siempre, y su
disparador es "eres este rol". La disciplina permanente es del contrato; el
  procedimiento puntual es del skill.
