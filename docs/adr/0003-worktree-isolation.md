# ADR 0003: Worktree aislado por tarea

## Contexto

Varios agentes pueden trabajar en paralelo sobre el mismo repositorio. Tocar el
checkout principal produce conflictos y pérdida de trabajo. firstmate usa
worktrees desechables por tarea.

## Decisión

Cada tarea se ejecuta en un `git worktree` propio:

- Rama: `crew/<task-id>-<slug>`.
- Ruta: `<data>/worktrees/<project-slug>/<task-id>`, fuera del repo.
- El brief y el reporte generados viven en `<worktree>/.crew/`, añadido a
  `.git/info/exclude` para no ensuciar el repo.
- El checkout principal nunca se modifica.

`crew task clean` es fail-closed:

- Se niega a eliminar un worktree con cambios sin `--force`.
- Nunca borra la rama automáticamente.
- `crew doctor` reporta worktrees huérfanos o ausentes.

## Consecuencias

- Aislamiento real entre tareas y con el repo principal.
- El trabajo no aterrizado permanece en la rama.
- Hay que limpiar worktrees manualmente con `clean`.
