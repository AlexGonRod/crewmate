# ADR 0042 — Tamaño de entrega: consejo, no tope

Estado: aceptada.

## Contexto

Una entrega grande difícil de revisar es un defecto de calidad, no de estilo:
la revisión humana y el tester leen mejor un diff de cientos de líneas que uno
de miles, y un cambio enorme dentro de una sola tarea mezcla unidades de
comportamiento que merecerían ir separadas. Pero un tope duro exige decidir el
número correcto, penaliza casos legítimos (tablas, fixtures, migraciones
generadas) y puede empujar a fragmentar el trabajo artificialmente.

## Decisión

1. **Consejo en el brief del developer.** Toda tarea de implementación lleva
   una sección `## Delivery sizing (advisory)` cuyo consejo es: mantener el
   diff de la tarea en el orden de **400 líneas autoriales** (añadidos más
   borrados) como objetivo; si el cambio es naturalmente mayor, organizarlo en
   work units coherentes dentro de la tarea o pedir un alcance menor, y
   **nunca trocear, encoger, minificar o eliminar trabajo real** (comentarios,
   whitespace, tests) para parecer más pequeño.

2. **El motor mide después, no impone antes.** Tras el commit, el registro
   `change.recorded` (ADR 0013) sigue siendo la medida real. El resumen de la
   tarea añade un aviso no bloqueante (`advisories` en `TaskSummary`) cuando
   el churn supera 400 líneas autoriales, citando el ADR. El aviso llega a
   `task show`, `crew status` y al review buffer; nunca bloquea el merge ni
   la revisión.

3. **El umbral es orientativo.** 400 es el tamaño de slice de trabajo que
   gentle-shell documenta como referencial para mantener una revisión legible;
   el código del
   motor no la usa como límite de aceptación: solo genera el aviso. Un cambio
   mayor con justificación (fixtures, generados) pasa igual y quedará
   documentado en la propia revisión.

## Consecuencias

- El desarrollador decide el tamaño con la intención explícita de que el
  cambio sea revisable; el humano ve el aviso exacto donde decide.
- Los criterios no automatizables (¿es el tamaño "natural"?) quedan donde los
  criterios del review humano ya viven: su juicio, no un gate del motor.
- El coste es irrisorio: una comparación en el resumen + una sección fija en
  el brief.

## Alternativas descartadas

- **Bloquear el commit con diffs demasiado grandes**: convertiría un consejo
  de calidad en un mecanismo que castiga casos legítimos a mitad del pipeline.
- **Obligar a trocear la tarea en subtareas con dependencias**: cambia el
  modelo de ciclo de vida del plan (ADR 0017) para un beneficio que el aviso
  ya da, y complica el plan del motor para casos que casi siempre son simples.
