# ADR 0022 — Tareas scout: investigación con informe independiente

Estado: aceptada.

## Contexto

El modo de entrega `scout` estaba declarado en el tipo `DeliveryMode` pero
rechazado por el motor con `DELIVERY_UNSUPPORTED`. Es el modo que necesita el
capitán cuando una petición no es "cambia este código" sino "averigua cómo
funciona esto" o "antes de tocar el motor, mira las opciones".

Investigar y cambiar son trabajos distintos: el primero produce conocimiento y
el segundo un diff. Mezclarlos en una sola tarea hace que el agente toque
código antes de tener la respuesta, y que el resultado sea un diff imposible de
leer como informe.

## Decisión

1. **`scout` es un modo de entrega real.** `delivery: scout` deja de fallar y
   tiene su propio recorrido en el pipeline.

2. **El entregable es un informe, no un cambio.** Una tarea scout:
   - no ejecuta los comandos de verificación del proyecto (no hay código que
     verificar),
   - no entra en la etapa de tester (no hay implementación que revisar),
   - no hace commit, no abre PR y no consulta CI,
   - termina en `review` con el informe del agente como resultado.

3. **El agente trabaja en modo investigación.** El brief incluye una sección
   "Role: Scout (research)": no modificar, crear ni borrar ficheros, no
   commitear ni abrir PRs, y reportar qué encontró, con qué evidencia y qué
   queda sin saber. El informe usa `crew.report/v3` con `role: developer` y
   `findings` con severidad `warning` o `info`.

4. **El informe se guarda como artefacto propio.** `scout.completed` en el
   event log y un artefacto `scout` con el resumen, los detalles, los
   `findings` y las preguntas abiertas. `task show` y el briefing del capitán
   lo muestran sin depender del reporte genérico.

5. **Creación directa para el capitán.** `crew scout --project <ref> --title
   <t> --question <pregunta> [--queue]` crea (y opcionalmente encola) una
   tarea de investigación en una línea.

## Consecuencias

- El capitán puede pedir una investigación antes de decidir, y el resultado es
  legible como informe.
- Las tareas scout no pueden colar cambios en el repositorio: el motor no
  commitea nada en este modo.
- La verificación y el tester siguen siendo rutas obligatorias para el código;
  el modo scout es un camino aparte, no una excepción.

## Alternativas descartadas

- Reutilizar el modo `local` con un brief de investigación: el agente podría
  commitear y la tarea acabaría como un cambio más.
- Un rol nuevo en el protocolo (`role: scout`): el rol `developer` con
  `crew.report/v3` ya permite findings y no obliga a tocar el contrato.
- Dejar el scout solo en el prompt del sistema: el brief es el contrato con el
  agente y debe decir explícitamente que no se toca nada.
