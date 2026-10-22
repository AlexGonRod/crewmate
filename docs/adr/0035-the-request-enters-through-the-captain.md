# ADR 0035 — La petición entra por el capitán

Estado: aceptada. Complementa a los ADR 0032, 0033 y 0034.

## Contexto

El motor sabía crear trabajo, ejecutarlo y entregarlo, pero la petición de la
persona se perdía por el camino:

1. **La puerta era la CLI.** `crew task create` era el único modo de abrir
   trabajo. El capitán existía como documento (`AGENTS.md`) y briefing, pero la
   persona tenía que abrir su agente a mano, en otro terminal, y el motor no
   sabía si había hablado con él.
2. **Las palabras de la persona no se guardaban.** El `title` y el `brief` los
   escribía quien creaba la tarea, casi siempre resumiendo. El worker nunca veía
   la petición original, así que el criterio con el que se juzgaba el trabajo era
   el resumen de otro, no lo que se pidió.
3. **No había conversación.** Un intento era un proceso: la persona escribía una
   petición, el agente hacía lo que podía y el proceso moría. Las preguntas
   llegaban como eventos, no como diálogo, y el contexto de un turno no viajaba
   al siguiente.

La conversación real que el producto quiere es la del `roadmap`:

```text
> arregla el test de login flaky y añade dark mode
  creada tsk_..., en cola (riesgo bajo)
> ¿y el dark mode?
  esa va en tsk_..., esperando a la anterior
```

## Decisión

1. **La persona habla con el capitán, y `crew` lanza al capitán.**
   `crew ask "<petición>"` compone el prompt (contrato del capitán, contexto,
   atención, memoria, skills, historial y la petición literal) y lo entrega al
   agente principal. `crew chat` hace lo mismo en multi-turn: con `opencode`
   continúa la sesión con `--session`; con el harness `fake` el motor recompone
   el historial en cada turno. Un harness sin conversación falla con
   `HARNESS_NO_CHAT`.

2. **La petición de la persona es un dato.**
   `tasks.request_text` guarda sus palabras exactas y `tasks.origin` dice quién
   la pidió (`person`, `cli` o `plan`). El brief del worker la lleva en
   `## Request (as the person asked it)`, antes del objetivo editado. Así el
   worker juzga contra lo que se pidió, no contra un resumen.

3. **La CLI directa se cierra, salvo para herramientas.**
   `crew task create` exige `--request` (o `--request-file`); sin él falla con
   `REQUEST_REQUIRED` y explica la alternativa. `--no-request` existe para el
   tooling, deja `origin=cli` y no inventa una petición. Los planes crean tareas
   con `origin=plan`.

4. **La respuesta del capitán es su último mensaje.** El parser de la salida
   toma el último texto del turno como respuesta y conserva el resto como
   transcript. El turno registra `captain.requested` y `captain.answered` con el
   id de sesión, para que la conversación sea auditable aunque el agente cambie.

5. **El capitán crea y encola; no espera ni mergea.** El prompt le pide no
   estudiar el código de la CLI (el `--help` es la documentación), no esperar a
   que el trabajo termine y no fusionar sin la firma de la persona.

## Consecuencias

- La creación de tareas deja de ser la puerta: es un efecto del diálogo. El
  capitán sigue siendo solo un cliente de la CLI determinista, no una autoridad:
  las puertas de merge y la verificación no se mueven.
- Los tests existentes que crean tareas por CLI declaran `--no-request`: así se
  ve en el propio test que están saltándose al capitán.
- La conversación con `opencode` depende de `--session`; con cualquier otro
  harness conversacional, el historial se recompone en el prompt. El coste es
  que el harness debe soportar `buildChatLaunch`.
- Si la persona dicta una petición ambigua, el capitán pregunta antes de crear
  nada; la petición original queda igualmente registrada cuando se cree la
  tarea.
