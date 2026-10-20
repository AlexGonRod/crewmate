# ADR 0001: Event log append-only con proyecciones SQLite

## Contexto

El orquestador necesita sobrevivir a reinicios, reconstruir el estado de una
tarea y explicar qué pasó sin depender de la memoria de un modelo. firstmate
resuelve esto con ficheros en disco; gentle-ai con un `state.json` y backups.

## Decisión

Guardar la historia en una tabla `events` append-only y mantener tablas de
proyección (`projects`, `tasks`, `runs`, `reports`, `messages`, `artifacts`).

- Cada comando abre una transacción `BEGIN IMMEDIATE`, actualiza la proyección
  y añade uno o más eventos.
- `tasks.last_seq` actúa como versión para concurrencia optimista.
- El event log es la fuente de auditoría; las proyecciones son la fuente de
  lectura.

No se implementa event sourcing completo: no hay replay automático al arrancar,
solo un registro durable y reconstruible en tests.

## Consecuencias

- Estado recuperable y auditable.
- Consultas rápidas sin replay.
- Hay que mantener consistencia entre eventos y proyecciones; los tests cubren
  el ciclo completo.
- El esquema se versiona en `schema_migrations`.
