---
name: crew-coding-guidelines
description: Guía interna para cambiar el material compartido y trackeado del repo de crew (AGENTS.md, README, docs, ADR, src, contratos) decidiendo dónde vive cada hecho y evitando duplicar lo que ya tiene dueño. Usar antes de tocar el AGENTS.md del capitán, el README, la guía, los ADR o los contratos, o al añadir una feature que cambie un contrato.
license: MIT
metadata:
  internal: true
---

# Guía de cambios en el repo de crew

Este repo tiene varios dueños de documentación y varios contratos que se
declaran en más de un sitio. Esta guía decide dónde va cada cosa y cómo se
mantiene coherente.

## Los dueños

| Superficie | Dueño | Cuándo se toca |
| --- | --- | --- |
| `docs/adr/00NN-*.md` | la decisión | cuando una decisión cambia el motor |
| `docs/guide.md` | el uso | cuando cambia un comando o un flujo |
| `docs/roadmap.md` | el estado | al cerrar una fase |
| `README.md` | el índice y el resumen | cuando cambia la superficie pública |
| `src/app/captain.ts` | el `AGENTS.md` del capitán | cuando cambia el contrato del capitán |
| `src/app/role-agents.ts` | los contratos de rol (developer, tester, scout) | cuando cambia la disciplina de un rol |
| `contracts/` | los esquemas | cuando cambia un formato, y solo ahí |
| `skills/` | los procedimientos | cuando cambia un procedimiento |

## El árbol de decisión

1. ¿Lo necesita el motor en cada sesión? → no: el motor no lee documentos.
2. ¿Es una decisión con porqué? → un ADR. Los ADR no se editan: se
   sustituyen y se anotan los nuevos.
3. ¿Es el uso de una comando? → la guía (`docs/guide.md`).
4. ¿Es un procedimiento para un agente? → un skill, con su disparador.
5. ¿Es el índice? → el README.
6. ¿Es una afirmación sobre el código? → el código, o un test que la fija.

## Un solo dueño

Cada contrato se dice una sola vez, en su dueño. Los ADR referencian el
README; el README referencia la guía; la guía referencia los ADR. Ninguno
repite el contenido de otro.

Cuando un ADR queda obsoleto, se marca como tal en la primera línea y se
escribe el nuevo. No se edita el viejo a medias: los ADR son un registro.

## Los contratos son ejecutables

`contracts/report.v*.schema.json` es la autoridad del formato de informe.
El código valida contra ese fichero, y los tests usan la misma fuente. Si
cambias un contrato, cambian el esquema y sus tests en el mismo commit: un
cambio de contrato sin su test es un contrato roto.

## Los ejemplos no son contratos

Un ejemplo en el README o en la guía ilustra; no es la definición. Si un
ejemplo y el código discrepan, el ejemplo está mal: corrígelo en el mismo
commit que el código que lo contradice.

## La disciplina del tamaño

El `AGENTS.md` del capitán lo paga cada sesión de cada agente. El coste de un
skill lo pagan solo las sesiones que lo cargan. Un detalle condicional que
solo importa al fusionar va a `skills/crew-merge-authority/`, no al AGENTS.md.

## La compatibilidad de los contratos

Un cambio en el motor cambia lo que el capitán ve y lo que los agentes
reciben. Antes de darlo por bueno:

- ¿El `AGENTS.md` del capitán sigue diciendo la verdad?
- ¿Los contratos de rol siguen diciendo la verdad? (`src/app/role-agents.ts`)
- ¿La guía sigue teniendo los comandos correctos?
- ¿Los skills siguen teniendo los disparadores correctos?
- ¿El esquema del informe y su test siguen de acuerdo?

Cada respuesta es un fichero que hay que tocar en el mismo commit, o una
decisión explícita de no tocarlo.
