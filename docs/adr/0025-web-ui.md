# ADR 0025 — UI web de solo lectura sobre el estado del crew

Estado: aceptada.

## Contexto

La Fase 4 pide una "UI web o servicio del sistema". Hoy el estado se consulta
por CLI: `crew status`, `crew progress`, `crew captain brief`, `crew events`.
Para una persona que quiere mirar el estado sin interrumpir al agente (o desde
otro dispositivo) eso obliga a estar en la terminal del daemon.

Al mismo tiempo, el motor ya tiene un modelo de estado completo y
determinista, así que la UI no necesita añadir estado: solo leerlo.

## Decisión

1. **Un servidor HTTP de solo lectura, sin dependencias.**
   `src/app/ui.ts` levanta un servidor `node:http` que sirve:
   - `GET /`: un panel HTML con el estado, lo que requiere atención y la tabla
     de tareas, que se refresca cada tres segundos.
   - `GET /api/summary`: el mismo briefing que consume el capitán.
   - `GET /api/tasks`: el resumen de todas las tareas.
   - `GET /api/tasks/<id>`: resumen, eventos, verificaciones, artefactos y
     reportes de una tarea.
   - `GET /api/events?task=<id>&limit=<n>`: el event log.

2. **Read-only por construcción.** El servidor no expone ningún método que
   mute el estado: no hay `POST`, ni `PUT`, ni `DELETE`. Es un visor, no un
   control remoto. Cualquier acción sigue pasando por la CLI, que es donde
   están los gates.

3. **Solo localhost por defecto.** `crew ui` escucha en `127.0.0.1:4173` y
   `--host`/`--port` permiten cambiarlo. Publicarlo en la red es una decisión
   explícita de quien lo despliega, no un valor por defecto.

4. **El panel muestra lo accionable.** Arriba, el resumen (tareas, runs
   activos, lease); en medio, la lista de atención con lo que requiere
   decisión humana; abajo, la tabla de tareas con estado, riesgo, CI,
   verificación, veredicto del tester y estado del PR, usando el mismo
   `TaskSummary` que el resto del sistema.

## Consecuencias

- Se puede observar el crew sin tocar la terminal del daemon y sin Ability
  para actuar sobre él.
- No hay dependencias nuevas: `node:http` y el modelo de datos del motor.
- La UI no sustituye a la CLI: no puede crear tareas ni mergear.

## Alternativas descartadas

- Un servicio del sistema (systemd/launchd): depende del sistema y añade
  despliegue; la UI web y el servicio pueden convivir más adelante.
- WebSockets para el refresco: el panel se refresca cada pocos segundos y no
  necesita un canal push.
- Una UI con framework: obligaría a una cadena de build y a servir ficheros
  estáticos para lo que es un panel de lectura.
