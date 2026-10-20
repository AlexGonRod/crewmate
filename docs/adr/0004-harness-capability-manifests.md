# ADR 0004: Manifiestos de capacidades por harness

## Contexto

Cada harness (opencode, Claude Code, Codex, etc.) tiene flags, formatos de
configuración y capacidades distintas. Codificar condicionales por harness en el
núcleo hace el sistema frágil y difícil de extender.

## Decisión

Describir cada harness con un manifiesto versionado `crew.harness/v1`:

- `detect.binaries`: cómo detectarlo.
- `execution.command`, `prompt.mode` y timeout.
- `provisioning`: si soporta instalación/sincronización (fase posterior).
- `capabilities`: `resume`, `interactive`, `hooks`, `subagents`, `mcp`.

El núcleo consume el manifiesto y un adaptador mínimo. En Fase 0 se implementó
`fake`; en Fase 1 se añadió `opencode`, detección del binario en `PATH`,
preflight `HARNESS_UNAVAILABLE` y resolución de `--harness auto`.

El protocolo para adaptadores externos (JSON-RPC 2.0 sobre stdio) se reserva y
versiona, pero no se implementa todavía.

## Consecuencias

- Añadir un harness no toca el núcleo.
- Las capacidades se pueden comprobar antes de lanzar.
- Es necesaria una suite de conformidad por adaptador en fases posteriores.
- `auto` solo considera harnesses reales; `fake` requiere selección explícita.
