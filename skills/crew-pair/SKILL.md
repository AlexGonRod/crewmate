---
name: crew-pair
description: Programación por parejas en modo manual, con el agente como driver en un worktree propio; avanza un test rojo → código mínimo → verde y para en cada paso, y la persona revisa, commitea y empuja. Usar solo cuando la persona invoque /crew-pair; no sustituye al pipeline de crew.
license: MIT
---

# Pair: driver y navigator, fuera del pipeline

Modo manual, una historia por sesión. Tú conduces (escribes el código); la
persona navega (revisa y decide). El pipeline de crew (`task run`) no se toca:
aquí no hay developer ni tester automáticos, y **el commit y el push son de la
persona**.

## 1. Revisión

- Lee la historia (idealmente el bloque de `/crew-story`: criterios, plan, fuera
  de alcance).
- Contrasta el plan con el código actual. Si algo ya no encaja, dilo antes de
  empezar.
- Si no hay plan, propón uno de 5 bullets como máximo y espera la aprobación.

## 2. Worktree

El worktree lo creas tú, junto al repo y fuera de él:

```sh
git worktree add ../<repo>-pair/<slug> -b pair/<slug>
```

- Trabaja **solo** dentro de ese worktree; el checkout principal no se toca.
- Si la persona ya te da un worktree o una rama, úsalos y no crees otro.
- Enséñale la ruta y la rama antes de escribir la primera línea.

## 3. Lista de tests

- De los criterios, propón **la lista de tests: solo nombres, sin escribirlos**.
- Di **en qué nivel** se prueba cada uno. Prefiere el nivel más alto posible.
- Marca los criterios que no se puedan probar automáticamente como
  **verificación manual**.
- Espera la aprobación. Esa lista es la especificación: la aprueba la persona,
  no tú.

## 4. Ciclo

Un paso = un test de la lista:

1. Escribe el test.
2. Ejecútalo y **enseña que falla** (rojo).
3. Escribe el **código mínimo** que lo hace pasar. Nada que el test no pida.
4. Ejecuta y enseña que pasa (verde).

Por defecto haces **1 paso** y paras. Si te dicen "haz N", haces N ciclos
completos (test → código → verde), nunca "N tests y luego el código". En un lote,
enseña primero los tests y después el código: los tests son lo que más se
revisa.

Al parar, manda un mensaje mínimo:

```
✅ Pasa "<nombre del test>". <qué hice en una línea> (<fichero:línea>)
Decidido: <juicio propio, si lo hubo>
¿Cambio algo o sigo con "<siguiente test>"?
```

### Para en seco (aunque estés en un lote) si:

- Necesitas una decisión de diseño que no está en el plan.
- Piensas añadir algo que no te han pedido, aunque parezca razonable.
- Para poner un test en verde habría que cambiar, saltar o borrar un test.
- Llevas dos intentos sin llegar a verde.
- El paso pasa de ~50 líneas o toca más de 3 ficheros: propón partirlo.

### Reglas de los tests

- El valor esperado sale del criterio de aceptación, **nunca lo calcules con la
  misma lógica que el código**.
- Prueba el comportamiento por la interfaz pública, no los detalles internos.

## 5. Comprobación

Cuando la lista esté verde:

- Verificad juntos los criterios marcados como **verificación manual**.
- Sugiere una revisión desde un contexto limpio; no revises tu propio código.
- Si algo se repite o está desordenado, **sugiere** el refactor; decide la
  persona. Refactor solo con los tests en verde y nunca mezclado con
  funcionalidad nueva.
- Si tomasteis una decisión que aplica a todo el proyecto, propón la nota para la
  memoria (`crew memory add`) o la línea para el `AGENTS.md`.

## 6. Entrega: la persona commitea

**Nunca commitees ni empujes.** Cuando haya un buen punto (tests en verde, una
unidad lógica), enseña el estado y propón el mensaje:

```sh
git -C <worktree> status --short
git -C <worktree> diff --stat
```

Sugiere mensajes separando funcionalidad y refactor en commits distintos. La
persona revisa el diff, commitea y empuja. Para gastar menos tokens, ejecuta solo
el test del ciclo en vez de la suite entera, y no repitas el diff completo en
cada parada.
