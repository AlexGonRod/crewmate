---
name: crew-memory
description: Escribe, corrige y poda la memoria durable de un proyecto (convenciones, decisiones, trampas, glosario y contexto) para que llegue a los agentes sin volverse un diario. Usar cuando se aprende una convención o una trampa del proyecto, cuando una decisión cambia, cuando la memoria de un proyecto está obsoleta o repetida, o antes de cerrar una sesión con trabajo hecho.
license: MIT
---

# La memoria del proyecto

La memoria es el canal de las convenciones del proyecto: lo que llega al
brief de cada agente, en cada tarea, de cada rol.

```sh
crew --json memory list --project <ref>
crew --json memory add --project <ref> --kind convention --title "T" --body "..."
crew --json memory rm <id>
```

## Los tipos son los niveles

| Tipo | Qué es | Cómo envejece |
| --- | --- | --- |
| `convention` | cómo se hace aquí | no caduca: cambia por decisión |
| `decision` | qué se decidió y por qué | no caduca: cambia por decisión |
| `pitfall` | una trampa que se repite | con 30 días sin reforzarse |
| `glossary` | qué significa un término aquí | no caduca |
| `context` | un dato de la situación | con 7 días: se propone borrar |

Un `context` que no puede nombrar una condición de caducidad comprobable no
es `context`: es `pitfall`.

## Escribir

1. **Comprueba si ya existe.** `crew --json memory list --project <ref>` antes
   de escribir. Si ya está, corrige esa nota; no añadas la segunda.
2. **Una nota, un hecho.** El título es el hecho; el cuerpo dice el porqué y
   el cómo, en un párrafo. Una nota con tres hechos son tres notas.
3. **El porqué, si lo hay.** Una convención sin motivo se vuelve a discutir en
   la siguiente tarea.
4. **Nada de secretos.** Ni tokens, ni rutas con credenciales, ni datos de
   producción.

## Corregir y podar

- Una nota que un hecho nuevo sustituye: `memory rm` de la vieja y `memory
  add` de la nueva, en la misma pasada. Lo que se anula queda en el informe de
  la tarea, no se pierde en silencio.
- Una nota duplicada: se pliega en la que ya lo dice.
- Una nota `context` o `pitfall` vieja: se propone a la persona, no se borra
  por tu cuenta.

## Lo que no va aquí

- El flujo de un cambio concreto → el informe de esa tarea.
- Un hallazgo de investigación → el informe del scout.
- Una regla de proceso → el `AGENTS.md` del proyecto.
- Un procedimiento que solo aplica en una situación → un skill.
