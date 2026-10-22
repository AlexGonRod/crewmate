# ADR 0038 — Gate de higiene de commit

Estado: aceptada.

## Contexto

El commit del pipeline es `git add -A` sobre el worktree: se lo que el agente
(instrucciones incluidas) y lo que los comandos de verificación fueron dejando
por el camino. Eso puede meter en el commit dos cosas que no le pertenecen al
cambio:

- **Secretos**: ficheros de credenciales (`.env`, claves) y secretos pegados en
  el diff que el developer ya no recuerda haber tocado.
- **Artefactos generados**: `__pycache__`, ficheros `.pyc` y similares creados
  al ejecutar los comandos de verificación dentro del worktree. El tester puede
  rechazarlos una vez, pero llega al siguiente intento y los e2e con worktrees
  recién creados (sin `.gitignore`) los commitean.

El gate de riesgo puntúa rutas sensibles, pero es informativo. Falta una
regla **determinista y fail-closed** que impida que el commit salga.

## Decisión

1. **Un gate propio, ejecutado por el motor antes del commit.** Tras la
   aprobación del tester y antes de `git add -A`/`commit`, el pipeline escanea
   lo que el commit incluiría, con el mismo staging que usará el commit.

2. **Dos listas deterministas, sin interpretación:**
   - **Rutas prohibidas** (por nombre de fichero): `.env`, `.env.*`, `*.pem`,
     `*.key`, `*.p12`, `*.pfx`, `id_rsa*`, `id_ecdsa*`, `id_ed25519*`,
     `secrets/` y los artefactos generados típicos: `__pycache__/`, `*.pyc`,
     `node_modules/`, `.venv/`, `venv/`. Semántica de gitignore: un basename
     casa en cualquier directorio y un patrón con `/` ancla en la raíz.
   - **Formas de secreto** sobre las líneas añadidas del diff: claves de AWS
     (`AKIA…`), tokens de GitHub (`ghp_`, `github_pat_`), bloques
     `PRIVATE KEY`, tokens de Slack (`xox…`), claves de Google (`AIza…`) y de
     Stripe (`sk_live_…`).

3. **El informe nunca contiene el secreto.** Los hallazgos citan el fichero y
   la forma (`AWS access key id in an added line`); el contenido casado no se
   imprime, ni va a logs, briefs, reportes ni eventos.

4. **Fallo = rechazo del developer, no `done`.** Con hallazgos, la tarea se
   rechaza con feedback (`hygiene gate blocked the delivery` + lista) y se
   reencola como cualquier rechazo del tester: el developer limpia y reintenta.
   El índice se devuelve a su estado (el rechazo no deja el staging a medio) y
   no se invoca al merge; no hay commit con hallazgos.

5. **Config por proyecto, fail-closed por defecto:**

   ```yaml
   # .crew/config.yaml
   hygiene:
     enabled: true                # desactivarlo es explícito
     extra_blocked_paths: [...]   # globs adicionales del proyecto
     disable_default_patterns: false
   ```

   El gate activo sin configurar nada es la decisión deliberada: el caso común
   (secretos y artefactos por accidente) se bloquea blanco, y quien quiera
   saltárselo lo declara. No hay flag `--no-hygiene`.

## Consecuencias

- Los artefactos de verificación (`__pycache__`, `.pyc`) ya no llegan al commit
  ni al PR; el e2e con worktrees limpios deja de filtrarlos.
- Un secret falso positivo es visible y explícito: o se saca del cambio o se
  ajusta con `disable_default_patterns`/`extra_blocked_paths` en el proyecto.
- Repos que deliberadamente commitean artefactos (por ejemplo `dist/` para una
  web estática) no se rompen: `dist/` y `build/` NO están en la lista por
  defecto (coste: quién quiera ese bloqueo lo añade a `extra_blocked_paths`).
