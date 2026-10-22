---
name: stow
description: Barrer la sesión en curso para recoger el conocimiento durable que solo existe en el chat (preferencias de la persona, hechos del proyecto, trampas operativas, decisiones que van más allá de la sesión y trabajo que queda abierto) y filing cada uno por la instrucción explícita, la convención local existente o el fichero privado `.stow-notes.md` de reserva, curando por niveles las notas que ya existen mientras escribe. Usar cuando la persona pida guardar o anotar lo aprendido en esta sesión, antes de un reset de contexto o de una pausa larga, o antes de dar por cerrada una sesión de trabajo.
license: MIT
metadata:
  adapted-from: kunchenguid/firstmate (MIT)
---

# stow (adaptado a crew)

Barre esta sesión en busca del conocimiento durable que ahora mismo solo existe
en el chat, y archívalo en el dueño que le corresponde: la memoria del
proyecto, el trabajo abierto como tareas, o el fichero privado `.stow-notes.md`
de reserva.

El objetivo es dejarle a la próxima sesión un mapa compacto y **actual**, no un
diario que acumula: cada hallazgo durable acaba en disco, y cada fichero que
tocas sale más preciso, no más largo.

Adaptado del skill público `stow` de firstmate (MIT). Los destinos, los
niveles y el vocabulario son los de `crew`.

## Qué hace

1. **Barre la sesión.** Lee hacia atrás y busca:
   - Preferencias de la persona: forma de trabajar, herramientas, formato o
     criterio de aprobación que dijo de pasada y no está en ningún fichero.
   - Hechos del proyecto: cómo se construye, se prueba, se despliega, cómo
     está organizado el código, qué convención existe.
   - Trampas operativas: un borde afilado, un rodeo, un error que se repite, una
     causa que no era evidente.
   - Decisiones que sobreviven a la sesión: un enfoque que quedó
     fijado, una opción descartada, un "en este proyecto hacemos X".
   - Trabajo que queda abierto: cualquier cosa acordada y no escrita.

   Antes de archivar un hallazgo, comprueba si ya vive en otro sitio con
   autoridad (un README, un ADR, el propio código). Si es así, apunta a ese
   dueño con una línea en vez de copiarlo: una copia se queda vieja sola.

2. **Descubre las convenciones del proyecto antes de decidir nada.**
   - La memoria del proyecto: `crew --json memory list --project <ref>`.
   - El `AGENTS.md` del proyecto (las reglas de proceso).
   - Los skills del proyecto: `crew --json skills list`.
   - Un fichero `TODO`, `BACKLOG` o `NOTES` ya trackeado, si existe.

   Este paso es solo sobre ficheros locales. Nada de trackers externos aquí.

3. **Enruta cada hallazgo, en este orden fijo.**
   1. **Lo que la persona haya dicho explícitamente manda.** Si dijo "esto
      déjalo en el issue", va al issue. Es el único camino hacia un sistema
      externo. Que el repo tenga un remote o una carpeta `.github` no es
      grounds para archivar nada allí.
   2. **La convención que el proyecto ya tiene.** La memoria del proyecto para
      hechos, trampas y decisiones; el `TODO`/`BACKLOG` para el trabajo
      abierto; un fichero de memoria del usuario (si existe y es legible) para
      las preferencias personales.
   3. **La reserva: `.stow-notes.md` en el directorio actual.** Cuando no
         encaja ninguna convención, no inventes una ubicación ni un nombre
         de fichero. Créalo (o actualízalo) en el directorio de trabajo, nunca
         en el home, y añádelo a `.gitignore` para que no acabe en un commit.
         Si el `.gitignore` no se puede escribir, sigue escribiendo el
         fichero y avisa.

4. **Cuando de verdad sea ambiguo entre dos convenciones, pregunta una vez y
   acuérdate.** Si dos destinos encajan de forma plausible, pregunta a la
   persona una sola vez cuál usa para ese tipo de nota. Cuando conteste,
   ofrece recordarlo: con su permiso, deja una nota corta de esa elección en
   su memoria de usuario, para no volver a preguntar.
   Nunca estableces una convención en silencio.

5. **Escribe solo donde ya existe una convención real, en la reserva del
   punto 3, o donde la persona acaba de aprobar.** No inventes ficheros
   compartidos, carpetas ni categorías nuevas. En particular: **nunca
   archives un hallazgo en un skill**. Si un hallazgo merece ser un skill,
   propónlo y que lo cree el proceso de cambios de la persona.

6. **Lee el destino antes de escribir: inspecciona y actualiza, nunca
   añadas a ciegas.** Lee la memoria del proyecto entera (`crew --json memory
   list --project <ref>`) y clasifica cada hallazgo: nuevo, duplicado,
   sustituye a uno existente, o vuelve obsoleto uno existente.
   - Duplicado → se pliega en la nota que ya lo dice.
   - Sustituye → reescribes la nota que sustituye (con `crew --json memory rm
     <id>` y su sustituta), no añades una segunda.
   - Obsoleto → se refresca o se propone borrar.
   Prefiere reescribir una línea a añadir una segunda nota casi igual. Y lo
   que anules debe quedar en el informe de la tarea, no perderse en silencio.

7. **Cura todos los ficheros de memoria que esta pasada abrió, no solo el
   destino de un hallazgo.** El tipo de la nota es su nivel:
   - `convention` y `decision`: **fijadas**. No caducan; cambian cuando la
     persona o la realidad lo cambien.
   - `pitfall`: **envejece**. Con 30 días o más sin reforzarse, se revalida o
     se propone borrar.
   - `context`: **perecedero**. Con 7 días o más, se propone borrar. Si no
     puedes nombrar una condición de caducidad comprobable, no es
     `context`: es `pitfall`.

   Un hallazgo que vive en `.stow-notes.md` tiene cinco salidas: subirlo a un
   fichero compartido que la persona apruebe, plegarlo en su memoria de
   usuario, archivarlo en el fichero de archivo local, moverlo a un skill
   aprobado por la persona, o borrarlo por duplicado. No inventes una sexta.

8. **Termina con un veredicto honesto y un puntero de reanudación.** Informa
   una línea por fichero tocado: `sin cambios`, `añadido`, `reescrito`,
   `podado`, `archivado` o `enrutado`. Di qué se capturó y dónde, qué no se
   pudo capturar y por qué, y si la sesión ya se puede dejar o resetear: eso
   es, si cada hallazgo durable ya está en disco o en el sistema que la persona
   pidió explícitamente, y no solo en este chat.
   Si algo no se pudo capturar, dilo en vez de reportar la sesión como
   segura. Si algo acabó en `.stow-notes.md`, dilo: es privado y no se
   comparte.
   Cierra con un puntero de reanudación corto y copiable, con los ficheros
   que una sesión nueva debe cargar para seguir en frío, por ejemplo:
   `Para retomar en una sesión nueva, carga: AGENTS.md (convenciones), la
   memoria del proyecto (crew memory list --project <ref>)`.

## Dónde vive el trabajo abierto

En `crew`, el trabajo abierto no es un `TODO` de texto: son tareas.

```sh
crew --json task create --project <ref> --title "T" --brief "qué queda y por qué"
crew --json task queue <id>
```

Cada tarea abierta dice **qué** queda, **por qué** está bloqueada y **qué**
la desbloquearía. Una tarea sin esa información es ruido para la próxima
sesión.

## Atribución

Adaptado del skill público `stow` de `kunchenguid/firstmate` (MIT). El
original tiene un gemelo interno en `.agents/skills/stow/` que asume una
home de firstmate; este fichero es la versión para `crew` y se mantiene
independiente, sin dependencias de paths ni de vocabulario de firstmate.
