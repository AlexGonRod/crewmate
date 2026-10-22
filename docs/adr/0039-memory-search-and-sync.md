# ADR 0039 — Memoria v2: búsqueda FTS y sincronía con el repositorio

Estado: aceptada, complementa el ADR 0035 (memoria del proyecto).

## Contexto

La memoria del proyecto (convention, decision, pitfall, glossary, context)
llega al brief de cada agente. Tiene dos límites prácticos:

1. **La lista crece y solo se lee linealmente.** Ni el capitán ni los workers
   pueden consultarla por texto: los hechos están o no están en el brief.
2. **La memoria vive en la base de datos, no en el repositorio.** La base de
   datos del motor vive en la máquina: al cambiar de máquina o compartir el
   repositorio, las notas convencionales del proyecto se pierden. Para que la
   memoria del proyecto viaje junto al código, tiene que existir dentro del
   repositorio.

## Decisión

1. **Búsqueda FTS5 sobre el título y el cuerpo.** Índice `memories_fts`
   (FTS5 de node:sqlite, contenido externo con la tabla `memories`), mantenido
   por triggers de insert/delete y una migración idempotente con backfill.
   El backfill es `INSERT INTO memories_fts(memories_fts) VALUES ('rebuild')`:
   un INSERT ... SELECT manual no mantiene las tablas shadow y `MATCH` no
   encuentra nada.

2. **`crew memory search "<texto>"`.** Búsqueda de texto libre con
   `--project`, `--kind` y `--limit` opcionales. La consulta se sanitiza:
   cada término entrecomillado y los caracteres sintácticos de FTS5
   (comillas, paréntesis, `^`, `:`, `AND` suelto) se descartan, de forma que
   una consulta escrita por una persona nunca rompe el parseo.

3. **`crew memory sync --project <ref>`.** Importa y exporta en un paso el
   fichero `<repo>/.crew/memory.json` (schema `crew.memory/v1`). Import:
   añade las entradas que no existan (dedupe por kind + title + body), no
   ingresa entradas sin título o con cuerpo vacío, y la kind desconocida
   cae a `context`. Export: reescribe el fichero con el estado completo de
   la memoria del proyecto. El comando es idempotente: la segunda `sync`
   importada da `imported: 0`. Resultado: `{imported, skipped, total, file}`.

4. **El contrato del capitán manda proponer, no decidir.** Cuando la persona
   o el trabajo fijan una decisión o una convención duradera, el capitán
   muestra la nota propuesta y pregunta antes de grabarla. La memoria solo
   crece con una decisión explícita.

5. **La base de datos sigue siendo la fuente de verdad.** El fichero del
   repositorio es una proyección: la memoria escribe en la base y el sync
   la proyecta al repo. Editar el fichero a mano es la forma de ingestión
   externa, y el sync la normaliza contra la base en la siguiente pasada.

## Consecuencias

- El capitán, los workers y las personas pueden preguntarse la memoria en vez
  de leerla entera.
- El `.crew/memory.json` se commitea con el proyecto: la memoria viaja con
  los desarrolladores, la CI y las personas que revisan.
- Un conflicto del fichero de memoria en un merge del repositorio se
  reconcilia con `crew memory sync`: las notas que existan solo en un
  extremo se importan sin duplicar (dedupe exacto).
