---
name: crew-backlog
description: Convierte una idea o una funcionalidad discutida en un backlog de historias verticales de una línea, sin criterios ni implementación. Usar solo cuando la persona invoque /crew-backlog antes de crear tareas; no se carga para implementar ni para refinar una historia.
license: MIT
---

# Backlog: de la idea a historias verticales

Modo manual. No creas tareas, no escribes ficheros y no tocas código: propones
el backlog y esperas.

## Conversación

1. Escucha la idea. Es una conversación abierta; puedes usar diagramas para
   entenderla.
2. Tu trabajo aquí es entender, no rebatir todavía.
3. Nunca hables de arquitectura, stack, patrones ni detalles de implementación.
4. Pregunta qué decisiones serían caras de cambiar después. Solo identificarlas,
   no las diseñes.
5. Propón el backlog. La persona lo ajusta.

## Reglas

- **No inventes requisitos.** Parte solo de lo que te han contado. Si ves un
  hueco, pregunta; no lo rellenes.
- **Cada historia entrega valor por sí sola** y cruza todas las capas. Nunca
  partas por capas.
- **Sin historias técnicas.** El actor nunca es el developer ni el sistema. La
  infraestructura nace dentro de la primera historia que la necesita.
- **Pocas historias.** 10–15 como máximo; mejor que sobren a que falten.
- **Una línea por historia.** Sin criterios, sin detalles técnicos, sin
  estimaciones ni prioridades.
- La primera historia es la definición del stack. La segunda es la más pequeña
  que funciona de punta a punta (esqueleto caminante).

## Salida

```markdown
## Contexto
<una o dos líneas: qué es y para quién>

Decisiones caras de cambiar: <las que apliquen, o "ninguna">

## Backlog
1. Como <actor>, quiero <acción>, para <beneficio>.
2. Como <actor>, quiero <acción>, para <beneficio>. Requiere: #1
```

Añade `Requiere: #N` solo cuando una historia no tenga sentido sin otra.

## Después

No guardes las historias en ficheros. En crew el tracker son las tareas:

- una historia suelta → `crew --json task create --project <ref> --title "<...>" --request "<la historia>"`;
- varias con dependencias → un plan `crew.plan/v1` y
  `crew --json plan apply <fichero>`.

No crees tareas ni escribas el plan hasta que la persona apruebe el backlog y
te lo pida. Para refinar una historia concreta, el siguiente paso es
`/crew-story`.
