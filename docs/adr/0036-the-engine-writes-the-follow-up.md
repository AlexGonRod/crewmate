# ADR 0036 — El motor escribe el seguimiento

Estado: aceptada. Se apoya en el ADR 0035.

## Contexto

Con el ADR 0035 la persona pide y el capitán crea y encola. Pero el turno
termina ahí: la tarea queda en cola, el daemon la ejecuta después y nadie se lo
cuenta al capitán. La conversación se rompe justo cuando hay algo que decir
(«ya está en review», «el worker pregunta X»). Además, cuando un worker se
queda en `waiting_input`, la pregunta solo se resolvía desde el editor o con
`crew task answer` a mano, así que el capitán no podía desatascar el trabajo.

## Decisión

1. **`crew ask --follow` ejecuta lo que el turno creó y lo cuenta.**
   Tras el turno del capitán, el motor drena la cola (si el lease está libre) y
   lanza un turno de seguimiento. El seguimiento no lo escribe la persona: lleva
   la marca `role: 'engine'` en el historial y en el prompt aparece como
   `## Seguimiento del motor`, nunca como una petición.

2. **El seguimiento enumera hechos, no decisiones.**
   El motor lista cada tarea con su estado, su riesgo y la pregunta pendiente.
   El capitán decide qué decir y qué responder; el motor no redacta su
   respuesta.

3. **El capitán responde las preguntas de los workers.**
   Una tarea en `waiting_input` o `blocked` lleva su pregunta sin consumir en
   el contexto del capitán (briefing y prompt). La respuesta sale con
   `crew task answer <id> --text "<respuesta>"`, viaja literal al agente y
   reencola un intento. Si la pregunta es una decisión de producto, el capitán
   no la inventa: se la traslada a la persona.

4. **El bucle está acotado y no repite lo que ya se dijo.**
   `--rounds` (por defecto 2) limita los turnos de seguimiento; si el capitán
   responde y el worker vuelve a preguntar, el motor puede drenar otra vez, pero
   no indefinidamente. Si el primer turno ya dejó todo en `review`, `done` o
   `failed` y nada pregunta, no hay seguimiento: el capitán ya contó el
   resultado. Con el lease del daemon ocupado por otro proceso, `--follow` no
   ejecuta nada y lo dice: el daemon en marcha ya se encarga.

5. **La firma no se mueve.** El seguimiento puede terminar en `review` y el
   capitán pedirá la firma; no fusiona.

## Consecuencias

- `crew ask` puede ser una sola orden de principio a fin («pide, ejecuta y
  cuéntame»), y también puede quedarse en el turno puro sin `--follow`.
- El historial de la conversación distingue tres voces: persona, capitán y
  motor. Un lector futuro sabe quién dijo qué.
- El coste es un turno extra del agente por defecto con `--follow`; sin la
  bandera no cambia nada.
- El motor sigue siendo determinista: solo drena la cola y describe estados.
  Las decisiones (responder, reintentar, escalar) siguen en el capitán.
