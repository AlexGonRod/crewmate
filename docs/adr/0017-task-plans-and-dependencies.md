# ADR 0017 — Planes de tareas con dependencias y grupos de ejecución

Estado: aceptada.

## Contexto

Una petición del capitán puede ser varios cambios. Crear cada tarea a mano con
`crew task create` funciona, pero pierde dos cosas importantes: la relación
entre tareas (qué se puede hacer en paralelo y qué va después) y la visibilidad
del coste antes de lanzar workers.

El núcleo no puede interpretar lenguaje natural: eso es trabajo del capitán. Lo
que el núcleo sí puede hacer es recibir un plan explícito, validarlo y
ejecutarlo con sus propias garantías.

## Decisión

1. **Formato de plan `crew.plan/v1`.** Un fichero YAML o JSON con `schema` y
   una lista de tareas. Cada tarea tiene `key` (identificador local), `title`,
   `brief`, `methodology` (por defecto `spec` si trae criterios y `free` si
   no), `acceptance`, `non_goals`, `depends_on` y `delivery` opcional.

2. **Validación determinista.** `crew plan validate` comprueba el esquema, la
   unicidad de las claves, que cada tarea tenga título y brief, que las
   tareas `spec`/`tdd` traigan criterios, que las dependencias existan y que no
   haya ciclos. Devuelve además los **grupos de ejecución**: la primera capa son
   las tareas sin dependencias (que pueden empezar en paralelo) y cada capa
   posterior depende solo de la anterior.

3. **Aviso de coste.** Si una capa tiene más de dos tareas, la validación
   avisa de que tantos workers van a empezar a la vez, para que el capitán
   confirme antes de lanzar.

4. **Dependencias en el motor.** La tabla `task_dependencies` registra las
   relaciones. El daemon no toma una tarea cuyas dependencias no estén
   terminadas, y una dependencia fallida o cancelada bloquea (`blocked`) a la
   tarea dependiente en lugar de dejarla esperando en silencio.

5. **Semántica de dependencia.** Una dependencia se considera satisfecha
   cuando la tarea dependiente llega a `review` o `done`: el trabajo ya está
   hecho y el siguiente cambio puede empezar sobre ese estado.

6. **Aplicación.** `crew plan apply` crea las tareas (en `draft`), registra las
   dependencias y, con `--queue`, las encola. `--project` elige el proyecto y
   `--delivery` el modo de entrega por defecto.

## Consecuencias

- El capitán puede mostrar un plan concreto antes de gastar workers, con los
  grupos de ejecución y los avisos de coste.
- Las dependencias son una garantía del motor, no una convención del agente:
  el daemon y la cola las respetan siempre.
- Una dependencia rota no deja tareas colgadas: quedan `blocked` y visibles en
  el briefing del capitán.

## Alternativas descartadas

- Dependencias solo en el brief del agente: el motor no podría impedirlas.
- Un DAG de tareas dentro de una sola tarea: mezcla el trabajo de dos cambios
  y pierde el aislamiento por worktree.
- Calcular los grupos en el cliente: el núcleo debe ser quien sabe qué se puede
  ejecutar en paralelo.
