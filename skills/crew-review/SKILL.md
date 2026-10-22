---
name: crew-review
description: Revisa una tarea que ha llegado a review, decide si se acepta o se rechaza, y registra la decisión. Usar cuando una tarea está en review, cuando la persona pide revisar o aceptar un cambio, o cuando un merge necesita la firma de una persona.
license: MIT
---

# Revisar una tarea

La revisión es el punto donde una persona (o el capitán, con `yolo`) decide si
un cambio entra. El motor pone las condiciones; esta skill pone el criterio.

## El buffer

```sh
crew --json task review <id>
```

Abre en `$EDITOR` un buffer con:

- el brief y los criterios de aceptación;
- el riesgo, con su puntuación y sus razones;
- el estado de los gates (verificación, tester, CI, PR);
- los commits y el diff completo (`base...head`).

Dos líneas deciden:

```
crew-decision: accept
crew-reason: por qué
```

- `accept` → la tarea se fusiona (o se acepta, en la ruta local), pasando las
  mismas puertas que `crew task merge`.
- `reject` → la tarea vuelve a la cola con tu motivo, y el agente lo recibe en
  el siguiente intento.
- **Cualquier otra cosa, incluido no tocar el buffer, no cambia nada.** El
  valor por defecto nunca es aceptar.

## Cómo se revisa

1. **El brief primero.** ¿El cambio hace lo que pide el brief? Un diff que
   funciona pero hace otra cosa es un rechazo, aunque los tests passen.
2. **Los criterios de aceptación, uno a uno.** Cada criterio tiene su
   evidencia. Si falta una, no hay aprobación.
3. **El diff como lo que va a producción.** Lee el cambio, no el resumen. Busca
   lo que no se pidió, lo que se queda a medias, y lo que deja sucio.
4. **El riesgo, con su porqué.** `high` significa que la decisión es de una
   persona, sin excepción.
5. **El motivo, siempre.** Un rechazo sin motivo no sirve: el agente no puede
   corregir lo que no se le explica.

## Después

La decisión queda registrada como artefacto `review` de la tarea: qué se
decidió, con qué motivo, quién autorizó y cuántas líneas de diff se viron.
No hace falta que cuentes nada más: el motor ya lo sabe.

## Cuando la tarea no está lista

Si el buffer enseña que falta verificación, que el tester no aprobó o que el
CI está rojo, el rechazo es la respuesta correcta y el motivo debe decir cuál
falta. Un rechazo con esa información es trabajo bien hecho: la siguiente
iteración tiene camino.
