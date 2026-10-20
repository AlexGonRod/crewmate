# ADR 0011: Auto-merge con guardrails

## Contexto

El modo `pr` deja el PR en `review` y exige que una persona lo mergee antes de
`task accept`. Con el gate de CI ya implementado, el motor puede decidir con
señales verificables si un PR cumple la política del proyecto. Un auto-merge
implícito sería peligroso: un cambio podría mergearse solo porque el developer y
el tester se declararon satisfechos.

## Decisión

- `auto_merge` es un modo opt-in por proyecto. Requiere una política explícita:

  ```yaml
  delivery: auto_merge
  ci:
    provider: github_actions
  auto_merge:
    method: squash
    delete_branch: false
  ```

- `auto_merge.method` es obligatorio y acepta `merge`, `squash` o `rebase`.
  `delete_branch` es opcional y por defecto `false`. Sin `auto_merge.method` el
  pipeline falla con `MERGE_POLICY_REQUIRED` antes de lanzar agentes.
- `auto_merge` exige `ci`. Sin configuración de CI falla con
  `CI_REQUIRED_FOR_AUTO_MERGE`; `verify` por sí solo no autoriza un merge.
- El merge solo se intenta después de que la verificación determinista pase, el
  tester apruebe y el gate de CI devuelva `passed`.
- Antes de mergear se comprueba que el PR esté abierto, no sea draft y sea
  mergeable. GitHub sigue aplicando sus reglas de protección de rama al ejecutar
  `gh pr merge`; un rechazo se registra como merge fallido.
- El merge lo ejecuta el motor con actor `crew`, nunca el agente developer o
  tester. El resultado se guarda como artefacto `merge` y evento
  `merge.completed` con estado, método, actor, motivo y URL.
- Si el merge termina bien, la tarea pasa a `done` con `task.accepted`. Si falla,
  la tarea queda en `review`, conserva el PR y el registro del fallo, y una
  persona puede mergear manualmente y ejecutar `task accept`.
- `pr` sigue siendo el modo manual por defecto.

## Alternativas descartadas

- **Mergear con solo `delivery: auto_merge`**: la intención no equivale a una
  política; faltaría método y requisitos explícitos.
- **Permitir `auto_merge` sin CI**: `verify` no cubre entornos, matrices ni
  checks obligatorios de la rama.
- **Mergear desde el developer o el tester**: rompe la separación de roles y
  convierte una declaración del agente en autorización.
- **Fallar la tarea si el merge no se puede completar**: impide la salida manual
  razonable (resolver conflictos, revisar protección de rama) y pierde el PR.
- **Usar `gh pr merge --auto`**: deja el merge en manos de GitHub sin un estado
  final inmediato ni un motivo claro para el registro local.

## Consecuencias

- El auto-merge es auditable y reproducible desde la configuración del proyecto.
- Un PR puede quedar en `review` porque GitHub rechazó el merge; el artefacto
  `merge` explica el motivo.
- La política no evalúa riesgo todavía; el resumen de riesgo de la Fase 2.6
  podrá informar al capitán sin sustituir estas guardas.
- El daemon permanece ocupado durante el merge, igual que durante el gate de CI.
