# ADR 0041 — El brief lleva la especificación por referencia

Estado: aceptada.

## Contexto

El brief que recibe cada rol (developer, tester, scout) es una reconstrucción
del motor: incluye la petición original verbatim y los criterios de
aceptación, pero nada indica cuál es la fuente de verdad cuando las piezas no
coinciden. Los handoffs que parafrasean la especificación son la causa clásica
de trabajo mal dirigido: un resumen pierde cadenas exactas, mensajes de error y
ejemplos; quien trabaja corrige lo que nadie pidió. En un entorno con varios
roles y varias iteraciones de revisión, cada pasaje de paráfrasis es una
oportunidad de desviación.

## Decisión

1. **El brief declara sus fuentes de verdad.** Toda tarea lleva una sección
   `## Source of truth` al principio del brief, antes del goal:

   - Con spec (metodologías `spec`/`tdd`): el fichero de spec
     (`CREW_SPEC_PATH`) es la autoridad para el goal, los criterios de
     aceptación, los non-goals y las constraints.
   - Sin spec (metodología `free`): la petición original
     (`task.requestText`, ya verbatim en el brief) es la autoridad.

2. **El brief es una proyección, y así se dice.** La sección explica que los
   criterios y la petición van copiados por comodidad, que en caso de
   discrepancia manda la fuente, y que ante una discrepancia real el agente
   trabaja desde la fuente y reporta `needs_input` con la diferencia, en lugar
   de resolverla por su cuenta.

3. **La regla viaja a todos los roles.** La misma sección llega al developer y
   al tester: la revisión compara contra el mismo documento que leyó quien
   implementó, no contra el resumen de nadie.

4. **Nada se elimina del brief.** La proyección verbatim se mantiene: evita un
   primer salto de lectura por fichero en los casos simples. La referencia
   radica en la jerarquía, no en quitar contenido.

## Consecuencias

- El motor nunca parafrasea los criterios; la responsabilidad de leer la
  fuente completa queda explícita y testeable en el texto del brief.
- Reportar `needs_input` con la discrepancia es la válvula: los conflictos entre
  brief y fuente escalan a la persona en vez de decidirse solos.
- El coste es una sección fija por brief, sin consultas ni I/O nuevas: el
  fichero ya está en el worktree.

## Alternativas descartadas

- **Quitar los criterios del brief y dejar solo la ruta**: hace el caso común
  más lento por proteger el raro, y rompe el brief autocontenido del e2e.
- **Sólo en `spec`/`tdd`**: el modo `free` también necesita decir qué manda
  cuando no hay spec, precisamente porque allí la petición es lo único.
