# ADR 0040 — Revisión proporcional por riesgo

Estado: aceptada.

## Contexto

El pipeline ejecuta al tester independiente en todas las tareas
(`docs/adr/0007-developer-tester-pipeline.md`): el coste de un segundo agente
se paga igual en un cambio de 3 líneas y en una migración de datos. El riesgo
de un cambio ya es una función determinista y auditable
(`docs/adr/0013-risk-and-status-summary.md`), pero ese riesgo "informa, no
decide": la ruta del tester es siempre la misma.

El enfoque de revisión proporcional de gentle-shell lo demuestra con
benchmarks: un bug pequeño va 4× más rápido inline sin subagentes, mientras
que una migración de alto riesgo pasa la revisión a la primera cuando un
verificador independiente la revisa explícitamente. La regla de corte relevante
es que **la ausencia de una evaluación nunca es evidencia de bajo riesgo**.

## Decisión

1. **Modo por proyecto.** `.crew/config.yaml` admite:

   ```yaml
   review:
     mode: proportionate   # 'full' (por defecto) | 'proportionate'
   ```

   El modo `full` mantiene el comportamiento actual: el tester corre siempre.
   El modo `proportionate` no cambia ninguna otra garantía del
   pipeline: verificación determinista, higiene de commit, gate de CI,
   entrega y autoridad de merge (ADR 0032) siguen aplicando.

2. **Decisión de ruta determinista.** Antes del commit, y en el lugar del
   tester, el motor calcula un riesgo *pre-commit* con `assessRisk` sobre las
   métricas del worktree (diff contra la rama base con el árbol de trabajo,
   líneas de ficheros sin trackear contadas y troceadas de forma acotada) y
   decide con una función pura (`planReviewRoute` en `src/risk/review-route.ts`):

   | Señal | Ruta |
   | --- | --- |
   | `verify` vacío (no hay señal objetiva) | tester |
   | Verificación con algún fallo | tester |
   | Estimación incompleta (remoto sin medida, binarios, no legibles) | tester |
   | Riesgo pre-commit `medium` o `high` | tester |
   | Verificación en verde y riesgo pre-commit `low` | **sin tester** |

   Una tarea enrutada a "sin tester" sigue pasando por el resto de gates
   sin cambiar: verificación, higiene, CI y revisión aplican igual.

3. **Fail-closed.** Toda señal ausente o no computable se trata como *no-low*:
   `estimateWorktreeStats` devuelve `null` si git falla, y marca la estimación
   como incompleta si hay ficheros binarios, demasiado grandes o en exceso
   (los ficheros sin trackear en binario no tienen recuento de líneas
   significativo). El riesgo desconocido nunca salta el tester.

4. **Riesgo pos-commit.** Tras el commit el motor sigue registrando
   `change.recorded` y el riesgo final del resumen (ADR 0013). Si el riesgo
   final sube (por ejemplo, la estimación pre-commit resulta conservadora),
   las rutas posteriores pierden el beneficio: el gate de merge exige que el
   riesgo evaluado con los datos definitivos siga siendo `low` para aceptar la
   dispensa del tester, y `auto_merge` mantiene su veto de riesgo alto
   (ADR 0011).

5. **Decisión registrada como evidencia.** Cada tarea en modo
   `proportionate` deja un artefacto `review_route` con el evento
   `review.routed` (ruta, motivo, riesgo pre-commit, modo). Las superficies
   (`task show`, `crew status`, web) la muestran; el gate de merge la
   consume.

6. **Medición (benchmark interno).** `crew metrics` agrega cuántas rutas se
   tomaron, cuántos runs del tester se ahorraron y la duración media de los
   runs de developer y tester. La utilidad del modo se decide con esos datos,
   no con intuiciones: si las tareas "sin tester" vuelven a `review` más que
   las otras, el modo pierde.

7. **Alcance del ahorro.** El modo ahorra un run del tester (un agente LLM con
   su contexto y su modelo). La verificación determinista, la higiene y el CI
   se pagan en todas las rutas; de ahí que el modo requiera `verify` no vacío
   para saltar: sin señal objetiva no hay dispensa.

## Consecuencias

- El coste del tester se paga proporcionalmente al riesgo, con la misma
  semántica de gates: nada aterriza sin evidencia determinista y CI en verde.
- Las decisiones de enrutado son auditables (función pura + artefacto) y
  testeables por unidad.
- Un proyecto lo declara en su config; ninguna tarea aterriza con menos garantías
  sin que el proyecto lo declare.
- Las tareas enrutadas a "sin tester" van a `review` para el humano o la
  capitana, como cualquier otra; el riesgo del resumen dice por qué.

## Alternativas descartadas

- **Heurística de tamaño en el brief del developer** (que decida el agente):
  la decisión debe ser determinista y del motor, no de un modelo.
- **Cortar por token, por precio o por número de ficheros**: el enfoque de
  gentle-shell enruta "por razón y por riesgo", no por cuenta.
- **Saltarse el tester sin config**: cambia una garantía implícita
  («el tester corre siempre») sin política explícita por proyecto.
