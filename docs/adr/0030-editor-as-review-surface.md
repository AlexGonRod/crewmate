# ADR 0030 — El editor es la superficie de revisión y de decisión

Estado: aceptada.

## Contexto

Una tarea llega a `review` y alguien tiene que decidir si se acepta. El
proyecto ya tenía dos caminos: `crew task merge` en el terminal y el
mergear en la web de la forja. Ninguno de los dos encaja con cómo trabaja
nadie: el código se lee en el editor, no en un buffer de review de GitHub.

Y hay una razón de fondo para no dejar que el agente decida: el agente no
lee bien el diff (su contexto es el brief y los informes, no el código), y
aceptar un cambio es irreversible. El propio proyecto ya lo tenía escrito:
*el riesgo informa, no decide* y *mergear sin política o confirmación es un
no-objetivo*.

## Decisión

1. **El editor es donde se revisa y donde se decide; el crew es quien ejecuta.**
   `crew task review <id>` abre un *review buffer* en `$EDITOR` con el brief,
   el riesgo, el estado de los gates, la PR y el diff completo. La persona
   escribe la decisión y el crew la aplica con sus propias puertas. El agente
   prepara, explica y relay, pero la autorización que se registra es de la
   persona.

2. **El buffer no es solo el diff.** Si solo enseñara el diff, decidir ahí
   sería peor que decidir en el navegador. Por eso lleva dentro el brief, el
   riesgo, los gates (verificación, tester, CI) y los commits: se decide con
   la misma información que tiene el motor.

3. **El diff sale del workspace.** Se obtiene a través de la abstracción de
   workspace, así que el mismo comando funciona con el código en local y con
   el código en el host remoto (ADR 0028).

4. **La decisión se lee de dos líneas planas.**

   ```
   crew-decision: accept
   crew-reason: it matches the brief
   ```

   Cualquier otra cosa (incluido no tocar nada) significa "sin decisión", y
   entonces **no cambia nada**. Cerrar el editor sin decidir es el camino
   seguro: el valor por defecto nunca es aceptar.

5. **El mismo editor responde a las preguntas del agente.** Una tarea en
   `waiting_input` se responde con `crew task answer <id>`, que abre un buffer
   con las preguntas pendientes y la respuesta escrita. `--text` sigue
   disponible para scripts.

6. **El editor es configurable y no interactivo.** Se resuelve `CREW_EDITOR`,
   luego `VISUAL`, luego `EDITOR`, y si no hay nada, `nvim`. Los editores con
   ventana propia reciben `--wait` para que el crew sepa cuándo has terminado.

7. **Las puertas del motor no se saltan.** Aceptar en el editor pasa por el
   mismo `mergeTask` que `crew task merge`: si falta verificación, tester o
   CI, no se acepta. Consecuencia real: un proyecto sin comandos `verify` no
   puede aceptarse, igual que ya ocurría por terminal.

8. **Cada revisión queda registrada.** El buffer se guarda como artefacto
   `review` de la tarea, con la decisión, el motivo, quien autorizó y las
   líneas de diff revisadas.

## Consecuencias

- La revisión ocurre en el editor donde la persona ya está, con sus LSP, sus
  tests y su grep.
- El buffer es un fichero de texto: se puede abrir en Neovim, guardar como
  notas, o revisar en otro sitio.
- Un fallo de red o un editor que no existe no dejan la tarea a medias: el
  buffer queda escrito y se puede volver a abrir.
- La superficie de decisión es una, y es la del humano.

## Alternativas descartadas

- **Un plugin de Neovim**: más bonito, pero exige mantener un plugin y una
  versión instalada; el buffer de texto funciona con cualquier editor.
- **Que el agente acepte la PR**: rompe el principio de que la decisión es
  humana y registrada.
- **Revisar en la web de la forja**: deja el estado del motor desligado del
  estado real de la PR.
- **Un TUI propio**: un cliente de Neovim, en lugar de usar Neovim.
