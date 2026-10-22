---
name: crew-scout
description: Decide y ejecuta una investigación que produce conocimiento en vez de un cambio en el código, y usa su informe para decidir si el trabajo debe promoverse a una implementación. Usar cuando la petición pide entender, averiguar, diagnosticar o auditar algo, cuando la implementación no está clara, o antes de construir algo cuya incertidumbre podría cambiar qué se construye.
license: MIT
---

# Scout: cuando el entregable es conocimiento

Un scout investiga y deja un informe. No toca el código, no abre un PR y no
modifica el proyecto.

## Cuándo

- La persona pide entender, averiguar, diagnosticar o auditar.
- La incertidumbre que queda abierta **podría cambiar qué se construye** o
  cómo. Esa es la prueba: si la respuesta no va a cambiar el trabajo, es
  trabajo, no investigación.
- La evidencia que ya existe responde a la pregunta: entonces relays la
  respuesta. No lances un scout en paralelo que no va a cambiar nada.

Una petición de diagnóstico, un informe o una recomendación **no son
autorización para cambiar código**.

## Cómo

```sh
crew --json scout --project <ref> --title "T" --brief "qué hay que averiguar"
```

El scout trabaja en su propio worktree, deja un informe con hallazgos y
preguntas abiertas, y termina en `review` sin commit ni PR.

## El informe

Es el entregable. Vale por lo que responde y por lo que deja abierto:

- **La conclusión**, en una frase, arriba.
- **La evidencia**: archivos, líneas, comandos, salidas.
- **Los hallazgos**, con su gravedad.
- **Lo que sigue**: las preguntas que quedan y qué harían falta para
  responderlas.

## Promover a implementación

Cuando el informe justifique un cambio, se crea una tarea normal a partir de
él, con la conclusión del scout como brief y los criterios de aceptación
derivados de los hallazgos. El informe del scout no se reescribe: se cita.

## Lo que no hace

Un scout no arregla nada "de paso". Si durante la investigación aparece un
bug evidente, se documenta como hallazgo y se decide después. Tachar código
durante un scout destruye la ventaja de poder descartar el trabajo sin
consecuencias.
