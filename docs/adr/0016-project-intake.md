# ADR 0016 — Intake de proyecto: clonar, detectar y pedir consentimiento

Estado: aceptada.

## Contexto

El capitán recibe peticiones sobre repositorios que no tiene delante: una URL
de GitHub y un cambio pedido. Hasta ahora `crew project add` solo registraba
un repositorio que ya estaba en disco, así que el primer paso (clonar, saber
qué toolchain usa el proyecto y qué comandos verifican el cambio) quedaba en
manos del usuario o del agente, fuera del control del motor.

Instalar dependencias o toolchains sin permiso es justo lo que un agente no
debe hacer por su cuenta: es lento, puede modificar el sistema y es una
decisión que pertenece a la persona.

## Decisión

1. **`crew project clone <url>`.** Acepta URL HTTPS, URL SSH y forma corta
   `owner/repo` de GitHub. Comprueba el acceso con `git ls-remote` antes de
   tocar el disco y clona bajo `<dataDir>/projects/<owner>-<repo>` (o `--dir`).
   La URL de clone es siempre HTTPS para no depender de claves SSH.

2. **Registro automático.** Tras clonar, el proyecto se registra en el store
   con su rama por defecto, su remote y el forge detectado (`github`).

3. **Detección de verificación.** Se inspecciona el repositorio clonado:
   `package.json` (scripts `test` y `typecheck`, con el gestor de paquetes
   detectado por el lockfile), `Cargo.toml`, `go.mod`, `pyproject.toml` y
   objetivos `test` de un `Makefile`. Los comandos detectados se escriben en
   `.crew/config.yaml` con la metodología `spec`.

4. **Consentimiento explícito.** La CLI nunca instala nada. Devuelve una lista
   `consent` con lo que haría falta (toolchain ausente, `node_modules`
   inexistente) y el comando sugerido. El capitán pregunta a la persona y solo
   con un "sí" explícito ejecuta esa orden por su cuenta.

5. **Inyección de clone y comprobación de acceso.** `intakeProject` acepta
   funciones de clone y de comprobación de acceso, lo que permite probar todo
   el flujo sin red.

## Consecuencias

- El intake es reproducible y auditable: el resultado dice qué se clonó, qué
  se detectó y qué falta, sin ejecutar nada en el sistema del usuario.
- El proyecto queda registrado y con `.crew/config.yaml` listo para crear
  tareas spec.
- La detección de comandos de verificación es heurística pero conservadora:
  solo escribe lo que existe en el repositorio.

## Alternativas descartadas

- Instalar dependencias automáticamente: es lento, muta el entorno del usuario
  y no tiene reversión.
- Usar `gh repo clone`: añade una dependencia de la CLI de GitHub para algo
  que `git` ya hace.
- Escribir una configuración completa del proyecto sin intervención: la
  metodología y la política de entrega las decide la persona, no el intake.
