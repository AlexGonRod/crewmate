---
name: crew-story
description: Refina una sola historia con 2–3 criterios de aceptación Given/When/Then y un plan de máximo 5 bullets, listo para crew task create. Usar solo cuando la persona invoque /crew-story con una historia concreta, justo antes de construirla.
license: MIT
---

# Story: refinar una historia antes de construirla

Modo manual. Tú propones, la persona decide. No escribes código.

## Pasos

1. **Lee la historia** que te dan y revisa el código actual, el `AGENTS.md` del
   proyecto y la memoria (`crew --json memory search "<tema>" --project <ref>`).
2. **Criterios de aceptación** en formato Given/When/Then. Describen lo que la
   persona ve u obtiene, nunca cómo se implementa.
3. **Si pide más de 3 criterios, evalúa partirla.** Entrega las historias nuevas
   en formato de backlog (`Como…, quiero…, para…`) y continúa con la primera.
4. **Mini plan** de 5 bullets como máximo, sin código ni nombres de fichero. Cómo
   cruza las capas.
5. **Espera la aprobación.** Ajustad hasta que diga que sí.

## Reglas

- **No inventes requisitos.** Si falta información, pregunta.
- **Lo más simple que cumpla los criterios.** Sin abstracciones, capas,
  configuración ni patrones "para el futuro".
- **Sugiere, no decidas.** Si un patrón ayudaría, menciónalo en "Sugerencias" con
  su porqué, y solo si hay una señal concreta en el código actual.

## Salida

Un bloque listo para pegar en la tarea.

```markdown
## Historia
Como <actor>, quiero <acción>, para <beneficio>.

## Criterios de aceptación
- [ ] Given <contexto>, when <acción>, then <resultado>.
- [ ] ...

## Plan
- ...

## Fuera de alcance
- <lo que se queda fuera, para que no se cuele>

## Sugerencias (tú decides)
- <opcional>
```

Cada criterio es un `--acceptance` y cada línea de "Fuera de alcance" un
`--non-goal`. Cuando la persona apruebe, ofrece el comando:

```sh
crew --json task create --project <ref> --title "<historia>" \
  --request "<la historia>" --brief "<el plan>" \
  --acceptance "<criterio 1>" --acceptance "<criterio 2>" \
  --non-goal "<fuera de alcance>" --methodology tdd
```

`--methodology` se sugiere, no se impone: `tdd` si el plan es test-first, `spec`
si hay criterios que verificar, `free` si el trabajo es abierto.

No crees la tarea hasta que te lo pidan. Para construirla a mano, el siguiente
paso es `/crew-pair`.
