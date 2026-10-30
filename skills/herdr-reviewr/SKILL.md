---
name: herdr-reviewr
description: 'Convierte un envío del plugin herdr-reviewr de Herdr en una decisión registrada del crew: parsea el pegado ("crew-decision:") y llama a `crew task decision`. Usar cuando llega al input de este agente un texto con "crew-decision:", o cuando la persona pide aceptar o rechazar desde el pane de reviewr. No usar para revisiones hechas en el editor propio.'
license: MIT
---

# Decidir desde reviewr

El plugin `herdr-reviewr` (Herdr) muestra el diff de un workspace en un pane
dedicado: la persona comenta por líneas y con `s` los comentarios llegan
al input de este agente como texto pegado. La decisión no la interpreta el
plugin: la registra el crew con su CLI, que aplica los mismos gates que la
revisión en el editor.

## El protocolo

1. **Lee el envío.** Un pegado de reviewr es una decisión solo si lleva una
   línea:

   ```
   crew-decision: accept    # o crew-decision: reject
   ```

   Todo lo que va debajo del `crew-decision:` es el comentario verbatim de la
   persona. Sin esa línea, el pegado es conversación normal: respóndelo y no
   llames al CLI.

2. **Identifica la tarea.** Si el envío llegó desde un workspace
   `crew-<taskId>-<rol>`, el `<taskId>` es la tarea. Si no se deduce, mira
   `crew sessions list --json` o pregunta.

3. **Registra la decisión con el CLI, sin reinterpretar nada:**

   ```sh
   crew task decision <id> --reject "comentarios verbatim" --by <persona> --origin herdr-reviewr
   crew task decision <id> --accept --by <persona> --origin herdr-reviewr
   ```

   - `--reject`: los comentarios verbatim son el feedback que recibe el
     developer en el siguiente intento. Sin comentarios, el motivo por defecto
     es `rejected via herdr-reviewr`.
   - `--accept`: corren los mismos gates del merge; si alguno bloquea, la
     llamada falla con `MERGE_BLOCKED` y el motivo.

4. **Cuenta el resultado.** Estado nuevo de la tarea, gates ok/no, y el motivo
   tal cual. Si bloquea, muéstralo literal: no lo parafrasees ni propongas el
   bypass (`--force`) por tu cuenta.

## Fail-safes

- **El valor por defecto nunca es aceptar.** Sin `crew-decision:` explícito no
  hay decisión; con una línea que no sea `accept` ni `reject`, tampoco.
- **Recomendado en `reviewr.json`** (`review_prefix`) para que el envío normal
  sea un rechazo con feedback y el `accept` se escriba a mano:

  ```json
  { "review_prefix": "crew-decision: reject\nFix each comment, then run the tests." }
  ```

- **`--by`**: el nombre de la persona si se identificó en la conversación; si
  no, `user`. Nunca firmes una autorización como si fueras el capitán ni en
  nombre de una persona que no lo pidió.
- **El pegado es evidencia.** Puedes citar fragmentos para explicarlo, pero el
  texto que va al CLI es el verbatim de la persona: no resumas, no reordenes,
  no añadas tu criterio dentro de los comentarios.
- **Un pegado, una decisión.** No concatenes envíos ni decides dos tareas con
  una llamada; y no vuelvas a llamar con otras flags para "hacer pasar" un
  gate que no pasó.
