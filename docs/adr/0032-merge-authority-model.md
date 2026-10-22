# ADR 0032 — Los gates son una cuestión de autoridad, no una lista de checks

Estado: aceptada. Sustituye el modelo de gates del ADR 0011 y del ADR 0019.

## Contexto

El crew heredó de tmux/herdr la idea de que un gate es "una condición técnica
que se cumple": verificación pasada, tester conforme, CI verde, PR abierta y
mergeable. `evaluateMerge` devolvía una lista de gates y el merge se.executeaba
si todos estaban OK.

Eso tiene un problema: el check técnico no dice **quién ha decidido**. El
resultado es que la decisión se tomaba en el sitio equivocado:

- `auto_merge` era un interruptor binario en la configuración del proyecto: o
  el motor mergeaba solo, o no mergeaba nunca. No había término medio, ni
  "mira, esto es de riesgo alto y esto sí lo decides tú".
- `crew task merge` podía ejecutarlo cualquiera, incluido el agente captains,
  sin que quedara registro de que una persona había autorizado. El `--by` era
  texto libre: el mismo string que podía poner un humano o un agente.
- El riesgo (`assessRisk`) informaba pero no influía en la decisión: un cambio
  de riesgo alto pasaba por los mismos gates que uno trivial.

El modelo de firstmate (ADR de firstmate, sección 7 y hard rule 2) es el
contraste: el gate es **la autoridad**, y la autoridad tiene tres niveles.

## Decisión

1. **Tres modos de entrega, resueltos al inicio de la tarea.** El modo
   decide la exigences técnica:

   | Modo | Qué exige |
   | --- | --- |
   | `no-mistakes` (por defecto) | verificación + tester independiente + CI + PR |
   | `direct-PR` | push y PR, sin reviewer independiente (la vía rápida) |
   | `local-only` | una rama limpia, sin PR; el aterrizaje local lo autoriza la persona |

   El modo vive en la configuración del proyecto (`.crew/config.yaml`) y la
   tarea lo hereda. Un proyecto sin configurar resuelve a `no-mistakes`.

2. **`yolo` es la postura de autoridad, ortogonal al modo.** Con `yolo` apagado,
   **toda** fusión la autoriza una persona. Con `yolo` encendido, el capitán
   puede fusionar trabajo verde y en alcance por su cuenta.

   `yolo` no autoriza: un PR rojo, un PR con un check requerido que no ha
   reportado, ni una fusión destructiva, irreversible o sensible. Esos escalan
   siempre.

3. **La autorización humana es un artefacto, no una palabra.** La palabra
   explícita del capitán es la revisión en el editor (ADR 0030): el buffer con
   `crew-decision: accept` deja un artefacto `review` con quién autorizó, el
   motivo y las líneas de diff vistas. `crew task merge` sin esa autorización
   previa **se niega** cuando `yolo` está apagado, y solo acepta con `yolo`
   encendido y riesgo no alto.

4. **El riesgo alto veta la autonomía, siempre.** `assessRisk` deja de ser
   informativo: un cambio de riesgo `high` exige autorización humana aunque
   `yolo` esté encendido. El riesgo alto es la razón por la que existe el
   veto, no un adorno del informe.

5. **El veto del rojo es absoluto.** Con o sin `yolo`, un PR con CI fallido o
   con un check requerido sin reportar no se fusiona. La única excepción es
   una instrucción humana explícita y nominal ("fusiona este PR aunque el
   check X no haya reportado"), que queda registrada.

6. **Una sola puerta de fusión.** Todo merge pasa por `crew task merge` o por
   `crew task review`. Nunca por una llamada de forge a pelo: la puerta es la
   que registra, la que se niega y la que deja el rastro. El `AGENTS.md` del
   capitán lo prohíbe explícitamente, como la hard rule 2 de firstmate.

7. **Las gates se nombran y se niegan con motivo.** Cada gate dice qué le
   falta y por qué, en el orden de la decisión (ruta, autoridad, estado). Una
   gate que no se puede comprobar no es una gate verde: es un veto.

## Consecuencias

- El motor sigue siendo determinista: la autoridad es un dato de la
  configuración y un artefacto, no una intención del agente.
- `auto_merge` desaparece como concepto: el modo dice el camino, `yolo` dice
  la autoridad, y el riesgo alto dice quién tiene que decidir. Los proyectos
  que usaban `delivery: auto_merge` se migran a `delivery: {mode, yolo}`.
- La auditoría mejora: cada fusión sabe si la autorizó una persona (y con qué
  motivo escrito) o la postura `yolo` del proyecto.
- Un cambio de riesgo alto nunca se fusiona solo. Es la diferencia entre
  "autonomía" y "autonomía con criterio".

## Alternativas descartadas

- **Dejar el checklist de checks y añadir solo un flag de autorización**: no
  distingue el riesgo alto del trivial, que es justo donde la autonomía
  debe ceder.
- **Que el agente sea el que pide la autorización** (un prompt al humano): el
  motor no puede depender de un agente que puede estar equivocado. La
  autorización es un artefacto que el humano firma.
- **Permitir `yolo` con checks sin reportar**: es la vía por la que un gate
  verde falso pasa. firstmate lo prohíbe también.
