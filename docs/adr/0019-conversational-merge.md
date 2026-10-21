# ADR 0019 — Merge conversacional: el motor decide si se puede

Estado: aceptada.

## Contexto

La Fase 3.5 pide que el usuario diga "mergea" y que el resultado sea fiable en
los dos sentidos: si todo está en orden, que se mergee; si falta algo, que el
capitán explique qué falta y no fuerce nada.

El motor ya tiene los datos (verificación, veredicto del tester, resultado de
CI, estado del PR) pero esa comprobación vivía repartida entre el pipeline, el
auto-merge y el `task accept`. El captain no tenía una operación única que
invocar y que le dijera "esto no se puede, y por qué".

## Decisión

1. **`crew task merge <id>`.** Es la operación que el capitán invoca cuando el
   usuario autoriza un merge. Antes de tocar nada, evalúa unas **puertas**:

   | Puerta | Requisito |
   | --- | --- |
   | task in review | la tarea está en `review` |
   | tester approved | el veredicto del tester es `approve` |
   | verification passed | la verificación de la tarea está en `passed` |
   | CI passed | si hay resultado de CI registrado, está en `passed` |
   | pull request open | el PR existe, está abierto y no está mergeado |
   | pull request not a draft | el PR no es un borrador |
   | pull request mergeable | el PR es mergeable |

2. **Si falta algo, no se fuerza.** Con alguna puerta incumplida el comando
   falla con `MERGE_BLOCKED` y el mensaje enumera qué falta y por qué. La tarea
   se queda en `review`.

3. **Si todo está en orden, se ejecuta.** El PR se mergea con el método de la
   política del proyecto (`auto_merge.method`) o el indicado con `--method`, y
   la tarea se acepta. El resultado del merge se guarda como artefacto `merge`
   y el evento `merge.completed`, igual que en el auto-merge.

4. **La autorización queda registrada.** Antes de actuar se escribe el evento
   `task.authorized` con el actor (`--by`, por defecto `user`), la acción y el
   resultado de cada puerta. El event log es la memoria de quién autorizó qué.

5. **Sin red es posible.** `--accept-only` acepta la tarea sin tocar el PR, y
   las puertas de CI solo aplican si hay un resultado de CI registrado, de modo
   que el mismo comando sirve para proyectos sin CI.

## Consecuencias

- El capitán tiene una sola operación para "mergea" y una respuesta clara en
  los dos casos.
- La política de merge sigue siendo del motor: la autorización humana es
  necesaria, pero no suficiente si falta un gate.
- El riesgo del cambio se muestra junto al resultado del merge, para que la
  decisión quede documentada con su contexto.

## Alternativas descartadas

- Que el capitán llame a `gh pr merge` directamente: se saltaría la
  verificación, el tester y el CI.
- Mergear y luego comprobar: el orden inverso es irreversible.
- Permitir merges forzados con un flag: la política de merge del proyecto
  deja de significar nada.
