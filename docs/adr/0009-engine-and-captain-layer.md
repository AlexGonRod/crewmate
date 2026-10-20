# ADR 0009: Motor determinista y capa capitán

## Contexto

El flujo objetivo de `crew` es conversacional: el usuario describe un proyecto de
GitHub y varios cambios, y un único agente, el capitán, coordina el trabajo. Ese
agente debe poder clonar el proyecto, pedir consentimiento antes de instalar
herramientas, descomponer la petición, lanzar workers aislados, informar del
estado y ejecutar un merge cuando el usuario lo autorice.

El motor actual ya resuelve la parte determinista: estado durable, worktrees,
pipeline developer/tester, verificación, entrega y recuperación. Si el capitán
implementara git, tests o merges por su cuenta, duplicaría reglas, perdería
auditabilidad y haría depender la seguridad del criterio del modelo.

## Decisión

- **`crew` es el motor determinista.** Ejecuta operaciones con estados, contratos,
  evidencia y errores tipados.
- **El capitán es una capa conversacional fina encima del motor.** Interpreta la
  intención, planifica, pide confirmaciones y llama a operaciones del motor; no
  escribe directamente en los repositorios de trabajo.
- **La primera implementación será una sesión/skill de `opencode` con
  `AGENTS.md`.** No se añade un `crew chat` con bucle LLM propio en esta etapa.
  El capitán puede cambiar de harness sin cambiar el motor.
- **Las acciones sensibles requieren autoridad explícita.** Clonar, instalar
  toolchain, mergear o cambiar una política necesitan consentimiento del usuario
  o una política declarada por proyecto.
- **El orden es motor primero.** CI, auto-merge, concurrencia y resumen de riesgo
  se cierran antes de prometer el flujo conversacional completo. El intake y la
  capa capitán pueden prototiparse antes contra el CLI actual.

El roadmap concreto y los criterios de salida viven en `docs/roadmap.md`.

## Alternativas descartadas

- **Parser de lenguaje natural dentro del CLI**: mezcla una interfaz no
  determinista con el núcleo y dificulta tests, auditoría y recuperación.
- **Capitán que ejecuta git/tests/merges directamente**: duplica reglas y elimina
  los gates del motor.
- **Construir el capitán antes de cerrar CI y auto-merge**: la demo prometería un
  merge seguro que el motor todavía no puede garantizar.
- **Un único agente que implementa, revisa y entrega**: elimina la verificación
  independiente y el conflicto de interés.

## Consecuencias

- El motor permanece pequeño, testeable y reutilizable por CLI, daemon y capitán.
- El capitán se puede sustituir o mejorar sin tocar el pipeline.
- La seguridad de merge e instalación queda en políticas explícitas, no en el
  prompt.
- Hay que definir una interfaz estable de operaciones para el capitán; los
  comandos `--json` actuales son la base, pero pueden necesitar un contrato más
  específico.
- La experiencia conversacional depende de un harness real; el agente falso
  permite probar el flujo sin coste.
