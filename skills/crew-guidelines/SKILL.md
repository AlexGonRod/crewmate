---
name: crew-guidelines
description: Decide dónde vive un hecho nuevo —el AGENTS.md del proyecto, la memoria del proyecto, un skill, un informe de tarea o la documentación— y evita duplicar lo que ya tiene dueño. Usar antes de escribir una regla, una convención o una nota de proyecto, cuando algo nuevo hay que documentarlo, o cuando dos sitios empiezan a decir lo mismo.
license: MIT
---

# Dónde vive cada cosa

Antes de escribir un hecho en algún sitio, decide quién es su dueño. Para en
cuadrado es el que manda.

## El árbol de decisión

1. **¿Lo necesita toda sesión de este proyecto, siempre?** → el `AGENTS.md`
   del proyecto, en línea. Son las reglas de proceso.
2. **¿Lo necesita solo en una situación con nombre** (un merge, un fallo de
   verificación, un arranque, una revisión)? → un skill, cuya descripción
   declara la condición exacta de carga. En el `AGENTS.md` solo queda la línea
   que nombra el skill cuando una regla siempre activa tiene que nombrarlo.
3. **¿Es una convención, una decisión o una trampa de este proyecto?** → la
   memoria del proyecto. Es lo que llega al brief de cada agente.
4. **¿Es el trabajo de esta tarea?** → el informe de la tarea y su log de
   eventos.
5. **¿Es el resultado de una investigación?** → el informe del scout.
6. **¿Es referencia general de `crew`?** → los ADR y la guía.

Para en el primer nivel que responde sí. No lo pongas en un nivel más
cómodo que el que da el árbol.

## Un solo dueño

Cada contrato (un formato, un flujo, un procedimiento) se dice **una sola
vez**, en su dueño. Cualquier otro sitio es una referencia cruzada de una
línea, nunca una repetición. Dos copias se separan en cuanto se edita solo
una.

Cuando toques un contrato, parchea el texto de su dueño en vez de añadir una
cláusula nueva en otro sitio, y actualiza las referencias cruzadas.

## La disciplina del tamaño

El `AGENTS.md` lo paga **cada sesión de cada agente**, cada vez. El coste de
un skill lo pagan solo las sesiones que lo cargan.

- Si un añadido necesita varias líneas de detalle condicional (lo que solo
  importa en una situación) o de detalle de referencia (un formato, un esquema,
  el porqué histórico), casi seguro va a otro sitio.
- Ante la duda: escríbelo primero en el skill o en la memoria, y deja en el
  `AGENTS.md` solo el disparador de una línea.

## La higiene del disparador

Un skill sin disparador es peso muerto. Cada skill declara en su descripción
la condición exacta bajo la que se carga ("carga antes de fusionar", "carga
cuando el CI no ha reportado"), nunca unapointer vaga ("consulta el skill
relevante").

## La memoria es del proyecto, no tuya

La memoria del proyecto la extiende una persona, o una decisión explícita de
la persona. Cada nota cuesta contexto en cada brief de cada agente: una nota
que casi todos necesitan va a la memoria; una nota que solo aplica a una
situación va a un skill; una nota de una sola tarea va a su informe.

Cuando una decisión cambie, actualiza la nota que la dice. No añadas la
versión nueva al lado de la vieja: corrige la que existe.
