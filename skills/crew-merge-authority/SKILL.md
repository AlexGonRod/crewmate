---
name: crew-merge-authority
description: Decide si una tarea puede fusionarse sin preguntar a la persona, y cómo se combinan la ruta de entrega, la postura yolo y el veto del riesgo. Usar antes de ejecutar cualquier merge, cuando la tarea llega a review, cuando el proyecto declara yolo, o cuando un merge falla con MERGE_BLOCKED o MERGE_REQUIRES_HUMAN.
license: MIT
---

# La autoridad de merge del captain

El gate de `crew` no es "los checks pasan": es **quién tiene la autoridad para
firmar**. Son tres cosas distintas, y se resuelven en este orden.

## 1. La ruta decide la exigencia técnica

La ruta la declara el proyecto (`.crew/config.yaml`) y la tarea la hereda:

| Ruta | Qué exige del trabajo | Dónde aterriza |
| --- | --- | --- |
| `no-mistakes` | verificación + tester independiente + CI | un pull request |
| `direct-PR` | push y PR, sin reviewer independiente | un pull request |
| `local-only` | verificación + tester + CI | una rama limpia, en local |

Un proyecto sin configurar resuelve a `no-mistakes` en las rutas con PR y a
`local-only` en las locales.

La ruta no se negocia por gusto: si una tarea necesita más rigor
del que da su ruta, la respuesta es cambiar la ruta del proyecto, no
inventar un gate nuevo para esa tarea.

## 2. La autoridad decide quién firma

- **Sin `yolo`**: solo una persona fusiona. Su firma es el artefacto que deja
  `crew task review` (la decisión escrita en el buffer del editor).
- **Con `yolo`**: el capitán puede fusionar trabajo verde y en alcance sin
  preguntar. Es una postura permanente del proyecto, escrita en su
  configuración, y no una excepción de una tarea.

```yaml
delivery:
  mode: no-mistakes
  yolo: true
```

`yolo` **nunca** autoriza:

- un PR rojo, ni uno con un check requerido que no ha reportado;
- un cambio de riesgo `high`;
- un merge destructivo, irreversible o sensible (borrado de una rama, un
  cambio de seguridad, una migración).

Esos tres escalan siempre, con `yolo` encendido o apagado.

## 3. El riesgo alto veta la autonomía

El riesgo se calcula con los cambios, el tester, la verificación y el CI. Un
cambio de riesgo `high` exige autorización humana aunque el proyecto tenga
`yolo`. El riesgo alto es la razón por la que existe el veto: no es un adorno
del informe.

## La puerta única

Todo merge pasa por `crew task merge` o por `crew task review`. Nunca por
una llamada a la forja a pelo: la puerta es la que se niega, la que registra
y la que deja el rastro. Si el gate falla, el motor no lo salta: se arregla
la causa.

## Qué hacer cuando el merge se niega

`MERGE_BLOCKED` nombra las puertas que faltan:

- *merge authority* → falta la firma de la persona: `crew task review <id>`.
- *CI passed* con "no check has reported" → el CI aún no ha reportado; espera
  a que reporte, no a que "salga verde" por defecto.
- *risk authorization* → el cambio es de riesgo alto: que la persona lo mire.
- *tester approved* / *verification passed* → el trabajo no está listo; no es
  un problema de merge.

## Qué se reporta

Después de un merge, informa del resultado con la evidencia: la tarea, el
estado, el método y quién autorizó. Si el merge falló, dilo con el motivo del
artefacto, sin adornos.
