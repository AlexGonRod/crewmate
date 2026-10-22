# ADR 0037 — El recibo del candidato revisado

Estado: aceptada.

## Contexto

Las puertas de `task merge` (tarea en `review`, tester aprobado, verificación y
CI verdes, PR abierto y mergeable) comprueban el estado, pero no comprueban
**qué** se aprobó. Un push posterior a la rama (`task.confirm` del humano, otro
agente, un daemon olfateando) mueve el head del PR y el merge lo fusiona igual:
el tester aprobó un commit que ya no es el candidato que llega a `main`.

En términos de la revisión como transacción: la evidencia del tester y de la
verificación enlaza con el commit que el motor entregó (`git.committed`), pero
el merge nunca verificaba que ese vínculo siguiera vivo.

## Decisión

1. **El recibo es el `commit_sha` de la tarea.** Cada intento que el motor
   commite actualiza `commit_sha` (`git.committed`); el candidato revisado es
   el último de esos commits.

2. **`task merge` exige que el head siga siendo el candidato.** Antes de
   autorizar, el motor compara el head actual de la rama con `commit_sha`:
   - Con PR, el head se lee de la forja si la trae (`gh pr view --json
     headRefOid`, `glab mr view --json sha`); si no, contra el push URL con
     `git ls-remote refs/heads/<branch>`.
   - Sin PR (`local-only`), contra `git rev-parse refs/heads/<branch>` del
     proyecto.
   Si no coincide, el gate `head matches the reviewed commit` falla y el merge
   queda bloqueado con `MERGE_BLOCKED`, indicando ambos SHAs.
   La resolución del head requiere acceso a la forja o al repositorio: si no se
   puede verificar, el gate falla (fail-closed) con el motivo.

3. **`--force` salta solo el recibo.** Un humano reúna la decisión sobre commits
   extra (los revisó él mismo) y firma con `crew task merge --force`. El resto
   de puertas no se toca, y el evento `task.authorized` registra qué puertas
   pasaron. `yolo` no salta el recibo: es bypass humano explícito o nada.

4. **El gate no aplica sin candidato.** Tareas sin `commit_sha` (no commiteadas)
   no evalúan el recibo. Intentos posteriores (`task reject` → nuevo commit)
   actualizan `commit_sha` y la re-revisión lo vuelve a firmar.

## Consecuencias

- Un push silencioso tras la revisión ya no puede fusionar un candidato no
  revisado: el error explica que la rama se movió y qué hacer.
- El coste es una llamada de lectura a la forja o al repositorio por merge.
- `--force` queda registrado como el bypass autorizado por una persona; si
  aparece en el log sin re-revisión, es una señal de revisión manual.
