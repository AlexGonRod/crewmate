# ADR 0010: Gate de CI con GitHub Actions

## Contexto

La verificación determinista ejecuta los comandos del proyecto, pero no cubre la
CI real del repositorio: entornos, servicios, matrices de versiones y checks
obligatorios de la rama. Una tarea podía llegar a `review` y aceptarse aunque su
PR tuviera CI fallido o pendiente.

## Decisión

- El gate de CI es opt-in por proyecto mediante `.crew/config.yaml`:

  ```yaml
  ci:
    provider: github_actions
    timeout_seconds: 900
    interval_seconds: 10
  ```

- Solo se ejecuta con `delivery: pr`, porque necesita un PR real.
- El orquestador consulta los check-runs del commit exacto del PR mediante
  `gh api repos/<owner>/<repo>/commits/<sha>/check-runs?per_page=100` y espera
  hasta que todos terminen o se agote el timeout. Filtrar por commit evita
  aceptar checks obsoletos tras un retry o un push nuevo.
- Se considera fallo cualquier check con bucket `fail` o `cancel`, o con un
  estado desconocido. Un timeout o la ausencia de checks también bloquean.
- Si el gate falla, la tarea pasa a `failed` antes de `review`; el PR y el
  artefacto `ci` se conservan para diagnóstico.
- El resultado se guarda como artefacto `ci` y evento `ci.completed`.
  `task accept` exige el último resultado `passed` cuando el proyecto declara
  `ci`; `--force` omite la comprobación.
- Si el proyecto no declara `ci`, los comandos `verify` siguen siendo el gate
  principal.

## Alternativas descartadas

- **Confiar en el reporte del developer o del tester**: la CI es una señal
  externa verificable, no una declaración del agente.
- **Usar `gh pr checks --watch`**: el proceso quedaría bloqueado sin un timeout
  controlado por `crew`, ni un resultado estructurado que persistir.
- **Requerir CI en todos los proyectos**: rompe proyectos sin GitHub Actions y
  duplica el gate de `verify`.
- **Gatear solo en `task accept`**: demasiado tarde para evitar que una tarea
  fallida llegue a revisión humana.

## Consecuencias

- El orquestador puede bloquear la entrega con una señal externa.
- El daemon queda ocupado esperando checks; el timeout acota el coste.
- La integración inicial depende de `gh` y de GitHub Actions. Otros proveedores
  y el auto-merge reutilizarán el resultado en fases posteriores.
- Un proyecto con `ci` configurado pero sin checks reportados falla al agotar el
  timeout; debe revisar su workflow o quitar `ci` y usar `verify`.
