# ADR 0024 — Capa de forges: GitHub y GitLab tras una interfaz común

Estado: aceptada.

## Contexto

El motor tenía GitLab como "no soportado" implícito: `detectForge` ya
reconocía `gitlab.com` y `forgejo`, pero la entrega con PR/MR llamaba
directamente a `gh`. Un proyecto GitLab podía registrarse, pero no podía
entregar nada: el error era un "requires a GitHub remote" poco explicativo.

La Fase 4 pide "soporte de más forges además de GitHub". Añadir GitLab no
consiste en cambiar cuatro llamadas: lo importante es que el motor no sepa
detalles de cada forja.

## Decisión

1. **Interfaz `Forge`.** `src/forges/types.ts` define lo que el motor necesita
   de una forja: `assertReady`, `createPullRequest`, `viewPullRequest` y
   `mergePullRequest`, con un modelo común de pull request (url, estado, si
   está mergeado, si es draft, si es mergeable) y un método de merge
   (`merge`, `squash`, `rebase`).

2. **Implementaciones.** `GithubForge` (sobre `gh`, el comportamiento actual) y
   `GitlabForge` (sobre `glab`: `glab mr create/view/merge`, con `--squash` y
   `--remove-source-branch`). `getForge(id)` resuelve la forja del proyecto y
   falla con `FORGE_UNSUPPORTED` si no la conoce.

3. **El motor usa la interfaz.** El pipeline, el merge conversacional y
   `task accept` piden la forja del proyecto en lugar de llamar a `gh`. El
   código de GitHub no cambia de comportamiento: solo se mueve detrás de la
   interfaz.

4. **Los estados se normalizan.** GitLab informa `opened`/`merged` y un
   `merge_status` propio; la capa lo traduce a los estados que el motor ya
   conoce (`OPEN`, `MERGED`, `MERGEABLE`, `CONFLICTING`). Los errores de
   merge conservados (`PR_NOT_OPEN`, `PR_IS_DRAFT`, `PR_NOT_MERGEABLE`,
   `PR_MERGE_FAILED`) son los mismos para las dos forjas.

5. **El gate de CI sigue siendo de GitHub.** El gate consulta los check-runs
   de GitHub Actions, así que un proyecto con `ci` configurado y una forja que
   no es GitHub falla con `CI_PROVIDER_UNSUPPORTED` en lugar de saltarse el
   gate. Por lo mismo, el auto-merge (que exige CI) no está disponible en
   GitLab todavía.

## Consecuencias

- Un proyecto GitLab puede entregar con `delivery: pr`: push, merge request,
  aceptación tras el merge y merge conversacional.
- Añadir otra forja es implementar la interfaz y registrarla en `getForge`.
- Los mensajes de error y el modelo de estados son los mismos en todas las
  forjas, así que el capitán no necesita distinguirlas.

## Alternativas descartadas

- Duplicar el pipeline para GitLab: dos caminos que divergen.
- Usar la API HTTP directamente: obliga a gestionar tokens, paginación y
  errores por forja cuando las CLIs ya lo hacen.
- Permitir el gate de CI con una forja no compatible: dejaría pasar tareas sin
  comprobar CI, que es justo lo que el gate existe para evitar.
