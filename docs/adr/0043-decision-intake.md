# ADR 0043 — Intake de decisiones fuera del editor

Estado: aceptada.

## Contexto

La revisión de una tarea vive en el buffer del editor
(`crew task review`, ADR 0032): la persona abre el diff, escribe
`crew-decision: accept|reject` y el motor aplica los gates. Pero fuera del
buffer existe otro flujo de revisión real: el plugin `herdr-reviewr` de Herdr,
que muestra el diff del worktree en un pane y envía los comentarios por línea
**como texto pegado al input del agente** (`s`). Ese texto de una persona es
también una firma; hoy no tiene ninguna vía determinista para llegar al motor:
solo un agente de chat puede leerlo y "actuar en consecuencia", sin formato ni
trazabilidad.

## Decisión

1. **Un comando de intake no editorial.** `crew task decision <id> [comments...]`
   registra una decisión sin abrir editor:

   ```sh
   crew task decision <id> --reject "comentarios verbatim" --by <quien> --origin herdr-reviewr
   crew task decision <id> --accept --by <quien> --origin herdr-reviewr
   ```

   - `--reject`: escribe los comentarios como mensaje `review_feedback`
     (verbatim) y devuelve la tarea a la cola, como el reject del buffer.
   - `--accept`: llama a `mergeTask` exactamente como la ruta del editor, con la
     misma autorización explícita y los mismos gates.

2. **Exige una decisión explícita, siempre.** Sin `--accept` ni `--reject` el
   comando falla (`DECISION_MISSING`); con ambas, `DECISION_AMBIGUOUS`. El
   silencio nunca es un accept: es la regla del buffer y también la del intake.

3. **Los mismos artefactos y eventos.** `recordReview` extiende su metadato con
   `origin` (de dónde vino la decisión: `cli`, `herdr-reviewr`…) y admite
   `bufferPath: null` (no hubo buffer). El evento sigue siendo `task.reviewed`,
   de modo que `lastHumanAuthorization` y todo el modelo de autoridad de merge
   (ADR 0032) leen el mismo registro sin distinguir el canal. El `ref` del
   artefacto se corta a la primera línea para no insertar diffs multilínea en
   listados de una línea.

4. **El pegado, parseado del lado del receptor, es un protocolo de texto.**
   `parseDecisionPaste` (módulo puro) reconoce una línea
   `crew-decision: accept|reject` y toma todo lo que va debajo como comentario
   verbatim. No hay decisión sin esa línea: quien recibe un pegado sin ella lo
   trata como conversación. La skill `skills/herdr-reviewr/SKILL.md` documenta
   el protocolo para el agente que recibe el envío.

5. **La atribución sigue siendo humana.** `--by` lo firma la persona (o `user`
   por defecto); el agente intermedio no firma nunca en su nombre salvo que la
   persona se haya identificado en esa misma conversación. Los gates no bajan
   porque la decisión viniera de un pane: el `accept` del intake pasa exactamente
   por las mismas puertas que el del editor.

## Consecuencias

- La revisión desde reviewr (comentar líneas y enviar) termina en la misma base
  de datos que la revisión en el editor: feedback verbatim para el developer y
  autorización trazable para el merge.
- `parseDecisionPaste` es puro y testeable; el comando es fino y delega en
  `rejectReview`/`mergeTask`, así que el camino del intake no tiene lógica propia
  que pueda divergir del buffer.
- El coste es un comando CLI, un campo de metadato y una skill de 3 pasos; no
  hay esquema nuevo ni daemon nuevo.

## Alternativas descartadas

- **Entrar la decisión como un chat libre sin formato**: un pegado sería una
  sugerencia de conversación, no una firma; el motor no podría auditar ni
  atribuir.
- **Guardar el pegado con interpretación del agente** (resúmenes en lugar del
  verbatim): rompe la evidencia; el feedback del developer debe ser las palabras
  de la persona.
- **Un webhook o API integrada en reviewr**: acopla crew a la superficie de
  eventos del plugin y duplica una ruta que el propio plugin ya tiene (enviar
  texto al input del agente).
