# ADR 0013 — Resumen de riesgo y estado reutilizable

Estado: aceptada.

## Contexto

El motor de `crew` ya sabe cuándo una tarea pasa, se bloquea o se rechaza, pero
ese estado vive disperso: artefactos de CI y de merge, verificaciones, informes
del tester y el estado de la tarea. Quien decide (el capitán, un humano, la
política de merge) tenía que reconstruir la situación leyendo la base de datos o
la salida de varios comandos.

Además, el riesgo de un cambio era implícito: dependía de qué archivos tocaba
el agente, algo que nadie registraba de forma explícita.

## Decisión

1. **Métricas de cambio registradas.** Tras cada commit el pipeline calcula el
   diff contra la rama base (`git diff --numstat <base>...HEAD`) y lo persiste
   como artefacto `change` con el evento `change.recorded`: número de archivos,
   líneas añadidas y eliminadas, y rutas tocadas.

2. **Clasificación de riesgo con reglas explícitas.** `src/risk/risk.ts` es una
   función pura y determinista sobre esas métricas más las señales de la
   tarea. Puntuación:

   | Señal | Puntos |
   | --- | --- |
   | Toca autenticación/seguridad, migraciones, infraestructura o configuración de CI | +4 |
   | Toca manifiestos de dependencias | +2 |
   | Más de 5 archivos modificados | +2 |
   | Más de 20 archivos modificados | +3 |
   | Más de 100 líneas cambiadas | +1 |
   | Más de 500 líneas cambiadas | +2 |
   | 1 aviso del tester | +2 |
   | 2 o más avisos del tester | +3 |
   | Algún hallazgo bloqueante del tester | +4 |
   | Alguna verificación fallida | +2 |
   | CI en estado `failed` o `error` | +2 |

   Niveles: `high` con 4 puntos o más, `medium` con 2 o 3, `low` con menos de 2.
   El resumen incluye siempre los motivos que produjeron la puntuación.

3. **Resumen único reutilizable.** `src/app/summary.ts` expone
   `summarizeDetail(detail)` y produce un `TaskSummary` con riesgo, CI,
   verificación (del último intento del developer), hallazgos del tester y
   estado del PR. No depende de la CLI, por lo que el daemon y el capitán
   pueden consumir exactamente el mismo objeto.

4. **Superficies de consumo.** `task show` añade el resumen a la salida JSON y
   a la vista de texto (`Risk`, `Verify`, `Tester`). El nuevo comando
   `crew status` resume el estado global: lease, conteo por estado, runs
   activos y los últimos resúmenes de tarea con riesgo y CI. El daemon
   incluye el riesgo y el estado de CI en el resultado de cada tarea procesada
   (`DaemonTaskResult`), de modo que el mismo objeto sirve en modo continuo.

5. **El riesgo informa, no decide.** Ninguna regla de merge usa la
   clasificación de riesgo. El motor sigue exigiendo tester aprobado,
   verificaciones en verde y CI en verde; el nivel de riesgo solo se presenta
   para que el humano o el capitán decida con contexto.

## Consecuencias

- El estado de una tarea es legible sin consultar la base de datos.
- Las reglas de riesgo son auditables y testeables de forma unitaria.
- El capitán de la Fase 3 puede pedir el resumen con una sola llamada y
  presentar riesgo, CI, verificación y PR en el mismo mensaje.
- Sin commit todavía (por ejemplo, una tarea que falló antes de entregar) el
  resumen no tiene riesgo: se informa como desconocido en lugar de inventar una
  clasificación.

## Alternativas descartadas

- Calcular el riesgo solo en el momento del merge: no informa al humano
  durante el desarrollo.
- Usar un modelo o heurísticas no deterministas: el motor debe ser
  reproducible y auditable.
- Consultar GitHub en vivo para el estado del PR: `crew status` debe funcionar
  sin red; se usa el último dato conocido (artefacto de merge, estado de la
  tarea) y se marca como `unknown` cuando no hay dato fiable.
