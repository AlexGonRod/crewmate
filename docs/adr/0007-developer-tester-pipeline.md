# ADR 0007: Pipeline developer → tester y revisión humana

## Contexto

La Fase 1 necesita separar la implementación de la verificación. Un único agente
que implementa y se autoevalúa no es una verificación independiente. Además, el
trabajo debe terminar en una rama o PR revisable por una persona, no
directamente en `main`.

## Decisión

- **Dos roles**: `developer` implementa en el worktree y emite un reporte
  v1/v2 según la metodología. `tester` es otro run, con otro harness y modelo
  configurables, que revisa el diff y emite `crew.report/v3`.
- **Tester de solo lectura**: no modifica el worktree, no hace commit, no hace
  push. El brief del tester incluye la ruta del reporte del developer y las
  mismas comandos de verificación del proyecto.
- **Veredicto explícito**: `approve` exige `status: done`; `reject` exige
  `status: failed` y al menos un `finding` con severidad `blocking`. Los gates de
  evidencia de `spec`/`tdd` siguen aplicándose al developer, no al tester.
- **Estado durante el pipeline**: la tarea permanece en `running` mientras
  corren developer, tester y git. Solo pasa a `review` cuando el commit (y el PR,
  si aplica) existe. `startRun({ continuePipeline: true })` permite encadenar
  runs sin salir de `running`.
- **Rechazo**: el feedback del tester se guarda como mensaje `review_feedback`
  y la tarea vuelve a `queued` con `stage=develop`. El brief del siguiente
  developer lo incluye. Tras `review.max_iterations` rechazos la tarea pasa a
  `failed`; no hay reencolado automático.
- **Entrega**: `local` deja la rama con el commit. `pr` hace push y abre un PR
  en GitHub mediante `gh`; solo se soporta GitHub. `auto_merge` y `scout` fallan
  con `DELIVERY_UNSUPPORTED`.
- **Aceptación humana**: `task accept` solo actúa sobre `review`. Con
  `delivery=pr` consulta `gh pr view` y exige `MERGED`, salvo `--force`. Nunca
  mergea por sí mismo; el merge es una decisión humana.
- **Rechazo humano**: `task reject` usa el mismo mecanismo que el tester, con el
  mismo límite de iteraciones.

## Consecuencias

- La verificación es independiente y el coste de un segundo agente es explícito.
- El estado `review` representa trabajo terminado pendiente de una persona, no
  un run activo; el daemon no lo vuelve a tomar.
- El pipeline es recuperable por partes: un fallo del developer, del tester o de
  git falla la tarea con un motivo; `task retry` reinicia desde `develop`.
- La integración con GitHub depende de `gh` y de su autenticación. El modo
  `local` permite usar el pipeline sin remoto.
- El merge automático queda fuera de alcance hasta que exista una política de
  protección de ramas y verificación de CI.
