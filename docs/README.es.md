# clustercode

**Un clúster de agentes de larga duración para [OpenCode](https://github.com/anomalyco/opencode).**
El modelo escribe su propio DAG de tareas, el plugin devuelve el turno al terminar cada uno,
los miembros del equipo rotan por los asientos y la cola se ejecuta hasta vaciarse.

[English](../README.md) · [简体中文](README.zh-CN.md) · [Français](README.fr.md) · [日本語](README.ja.md) · [Español](README.es.md) · [Português](README.pt-BR.md)

[![check](https://github.com/dengkaile22/clustercode/actions/workflows/ci.yml/badge.svg)](https://github.com/dengkaile22/clustercode/actions/workflows/ci.yml)

---

## Por qué

OpenCode V2 (API de plugins 2.x, `Plugin.define`) reescribió la superficie de plugins: los de la
1.x ya no cargan. La V2 trae subagentes en segundo plano, compactación y precalentamiento, pero no
trae las dos piezas que necesita una ejecución sin supervisión:

1. **Continuación** — al terminar un turno, nada inicia el siguiente. Hay que pulsar Enter.
2. **Rotación de asientos** — un solo agente hace todo, en lugar de un planificador, un programador,
   un revisor y un tester que se relevan.

`clustercode` añade esas dos piezas y los guardas que hacen razonable dejar una ejecución sola
durante 24 horas.

## Funcionalidad

| Función | Qué hace |
|---|---|
| **DAG de tareas** | `dependsOn` entre tareas. Una tarea solo es ejecutable cuando todas sus dependencias están `done`. |
| **Planificación automática** | `cluster_auto({ goal })` llama al modelo una vez, fuera de la sesión, para convertir un objetivo en un DAG. |
| **Rotación de asientos** | Los miembros son archivos de agente reales (`clustercode-<id>.md`). El plugin cambia de asiento con `switchAgent` entre turnos. Una tarea puede fijar su miembro. |
| **Puerta de verificación** | Marcar `done` ejecuta de verdad el comando `verify`. Un código de salida distinto de 0 rechaza la actualización y devuelve la salida. |
| **Latido de 24 h** | Con `heartbeat: true`, una sesión inactiva se despierta tras un tiempo de espera: una ejecución interrumpida continúa sola. |
| **Guardas** | Trabajo en segundo plano, cola terminada, interbloqueo, tope de turnos y estancamiento, evaluados en un solo lugar y en un solo orden. |
| **Tres puntos de entrada** | Servidor (hooks, herramientas, RPC), TUI (estado en el pie + panel `/cluster`), Desktop (panel lateral + cápsula + menús). |
| **Añadir y reintentar** | `cluster_plan({ append: true })` amplía una cola en marcha. `cluster_retry` devuelve las tareas fallidas a la cola. |

## Principios de diseño

Siete reglas, cada una sostenida por una prueba. [design.md](design.md) traza
principio → módulo → prueba y enumera las diferencias deliberadas con el proyecto original.

1. **Un disparador, un planificador.** El hook idle y el latido llaman a `decide()`.
2. **`resume: true` cierra el bucle.** Sin él, una sesión inactiva espera un despertar que no llega.
3. **Evidencia, no autoevaluación.** `done` ejecuta el comando de aceptación.
4. **Parar ante una premisa rota.** Una dependencia fallida no está satisfecha; un grafo bloqueado
   se detiene con una razón.
5. **Ceder por defecto.** El trabajo en segundo plano manda, los permisos y los reintentos son de
   otros plugins, y la tarjeta del sistema no cambia para no romper la caché del prompt.
6. **Los archivos son la API.** Un asiento es un markdown gestionado; un archivo escrito a mano
   nunca se toca.
7. **Un solo camino de datos.** Instantánea → RPC → ambas interfaces, con los mismos textos.

## Instalación

Clona el repositorio y apunta OpenCode al **directorio** (no a un archivo) en
`~/.config/opencode/opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["C:/Users/you/Desktop/clustercode"]
}
```

El host encuentra cada mitad mediante `package.json` → `exports`:

| exports | Mitad | Contenido |
|---|---|---|
| `.` | servidor | herramientas, hooks, comandos, RPC, latido |
| `./tui` | terminal | segmento de estado, panel `/cluster` |
| `./gui-experimental` | escritorio | panel lateral, cápsula, menús (`dist/*.cjs`) |

Dos reglas operativas:

- La mitad de escritorio está **precompilada**. Ejecuta `npm run build` tras clonar, o el panel no
  tendrá punto de entrada.
- El host sondea los `exports` **solo al arrancar**. Tras cambiar `exports` o recompilar la interfaz,
  reinicia el servidor y la aplicación de escritorio. `opencode reload` solo relee la configuración.
  `npm run check:entry` verifica el sondeo antes de reiniciar.

Requiere el host de plugins de OpenCode 2.x (`@opencode/plugin >= 2.0.27 < 3`). Los scripts de
desarrollo necesitan Node 22.18+.

## Inicio rápido

1. Reinicia OpenCode para cargar el plugin.
2. Pulsa **Shift+Tab** hasta el agente `clustercode`. Ese modo existe para esto: pide al modelo que
   entregue el trabajo a la cola en lugar de hacerlo todo solo.
3. Pide algo, o usa las herramientas directamente:

```
cluster_auto({ "goal": "añadir --json al cargador de configuración, con tests y documentación" })
```

```
cluster_plan({
  "goal": "endurecer el importador",
  "tasks": [
    { "id": "t1", "title": "rechazar archivos de más de 10 MB", "verify": "node test/import.test.ts" },
    { "id": "t2", "title": "documentar el límite", "dependsOn": ["t1"] }
  ],
  "maxRounds": 5
})
```

4. Sigue la ejecución: `/cluster` abre el panel. En la TUI el pie muestra
   `cluster 2/5 · turn 3 · coder`; en escritorio, una cápsula sobre el compositor muestra lo mismo.
5. Frena con `/cluster-stop`, continúa con `/cluster-resume`.

Consejo para la primera ejecución: mantén `maxRounds: 5` hasta que el plan te inspire confianza.
`maxRounds: null` con permisos abiertos de verdad corre hasta vaciar la cola.

## Herramientas

| Herramienta | Para qué |
|---|---|
| `cluster_auto` | Un objetivo dentro, un DAG generado, la ejecución empieza. Crea el equipo por defecto si no hay. |
| `cluster_plan` | Cola explícita: `dependsOn`, `verify`, `member`, `maxRounds`, `maxStagnant`, `heartbeat`, `append`. |
| `cluster_update` | Informa `pending` / `running` / `done` / `failed`. `done` pasa por la puerta de verificación. |
| `cluster_status` | Turno, cola, siguiente asiento, tareas bloqueadas, latido, motivo de parada. |
| `cluster_team` | Crea o reemplaza el equipo. `adoptCluster: true` toma un `clustercode.md` escrito a mano. |
| `cluster_retry` | Devuelve las tareas fallidas a `pending`, limpia el motivo de parada y sigue. |

Comandos: `/cluster-stop`, `/cluster-resume`, `/cluster` (panel).

## Equipo integrado

Cámbialo con `cluster_team({ members: [...] })`. Cada miembro admite `id`, `role`, `color`, `extra`
y `model`.

| id | Trabajo | Nota |
|---|---|---|
| `architect` | Descompone, fija interfaces, escribe el plan | no escribe código de producción |
| `coder` | Implementa el plan | verifica su propio cambio |
| `reviewer` | Revisión de solo lectura | el frontmatter deniega llamadas `edit:*` |
| `tester` | Ejecuta tests, reproduce fallos, demuestra los criterios | solo cree en la salida real |

El asiento `reviewer` es una restricción de **política**, no un sandbox. Si un agente no debe tocar
el sistema de archivos, limítalo a nivel de sistema operativo.

## Cómo funciona un turno

```
experimental.idle
   ├─ ¿queda trabajo en segundo plano?  → esperar (nos despertará al terminar)
   ├─ ¿cola terminada?                  → parar (finished)
   ├─ ¿grafo en interbloqueo?           → parar (deadlock)
   ├─ ¿tope de turnos alcanzado?        → parar (max-rounds)
   ├─ ¿el siguiente turno estancaría?   → parar (stagnant)
   └─ si no
        switchAgent(siguiente asiento)  → el cursor avanza solo si tiene éxito
        round += 1, guardar, publicar la instantánea
        synthetic({ resume: true, text: "turno N, tarea tX, informa con cluster_update" })
```

`resume: true` es la pieza clave. Sin él, el texto inyectado espera un despertar futuro que una
sesión inactiva nunca recibirá: la ejecución se detiene en silencio. El latido usa la misma función
`decide()`, así que un clúster que alcanzó su tope también se detiene ahí en vez de despertar un
turno de más.

## Arquitectura

```
core (puro, testeable)
  state.ts      DAG, rotación, contadores, huella de estado
  scheduler.ts  decide() + commit(): el orden de guardas, una sola vez
  plan.ts       objetivo → DAG, reparación de JSON, detección de ciclos
  store.ts      persistencia con caché y escrituras serializadas + FileStorage
        │
servidor (src/index.ts)
  hook idle · tarjeta de sistema · comandos · herramientas · latido · RPC de instantánea
        │  clustercode.snapshot { get } → SnapshotView
        ├──────────────┬─────────────────────────┐
   TUI (src/tui.tsx)                 Desktop (dist/gui-experimental.cjs)
   estado + panel /cluster            panel lateral + cápsula + comandos
```

Las dos mitades de interfaz solo leen el RPC. No tocan la memoria ni el disco del servidor, así que
un escritorio conectado a un servidor remoto se comporta igual que uno local. Comparten los textos de
`status.ts`, de modo que el pie y el panel no pueden contradecirse.

## Guardas y coste

- **Estancamiento**: 12 turnos sin cambios de estado por defecto. `maxStagnant: 0` lo desactiva;
  entonces `maxRounds` es la única red.
- **Tope de turnos**: `null` por defecto. Ponlo en las primeras ejecuciones.
- **Interbloqueo**: un ciclo o una dependencia fallida detiene la ejecución de inmediato con una
  explicación, en lugar de girar hasta el contador de estancamiento.
- **Latido**: activo por defecto en `cluster_auto`, inactivo en `cluster_plan`. Intervalo mínimo 15 s,
  por defecto 60 s. Respeta el tope y el estancamiento.

Todo se evalúa en `decide()`; no hay una segunda copia de las reglas.

## Coexistencia

clustercode no reclama a propósito las áreas que otro plugin ya puede tener:

| Área | Dueño |
|---|---|
| Permisos, tiempos de shell largos | tu plugin de permisos (`permission.evaluate` nunca se registra) |
| Reintentos con espera | tu plugin de reintentos (`retry` nunca se registra: dos plugins escribiendo `event.decision` es una moneda al aire) |
| Prompt del sistema | el host; clustercode solo añade una tarjeta constante, una vez por turno |
| Modelo por asiento | tú, con el campo `model` del miembro |

Dos plugins que registran `retry` no pueden ganar los dos: decide el último registrado. Por eso
este se queda fuera.

## Verificado

```
npm run check
  typecheck (tsc --noEmit, TSX incluido)
  187 aserciones (node --test, sin modelo, sin red)
  build: dist/gui-experimental.cjs + comprobación de compilación de la TUI
  sondeo de entradas: servidor / tui / escritorio resueltos
  cableado de la TUI + cableado del escritorio
```

Lo que estas comprobaciones **no** demuestran: el render real (hace falta una TUI o la app de
escritorio) y una ejecución completa sin supervisión con un modelo real (hacen falta tokens).

## Desarrollo

```powershell
npm install
npm run check        # todo lo anterior, en orden
npm run test         # solo aserciones
npm run typecheck
npm run build        # bundle de escritorio + comprobación de la TUI
npm run check:entry  # reproduce el sondeo de exports del host
```

Las pruebas redirigen el directorio de agentes con `CLUSTERCODE_AGENTS_DIR`, así que nunca escriben
en tu `~/.config/opencode/agents`.

`docs/development.md` explica la copia de referencia del código de OpenCode en `opencode/` y cómo
revisar la API del host contra ella.

## Limitaciones conocidas

- **Secuencial, un carril por sesión.** El clúster ejecuta un turno a la vez; el paralelismo es de
  los subagentes en segundo plano, a los que el hook idle cede el paso.
- **`cluster_plan` reemplaza la cola** salvo con `append: true`.
- **`experimental.idle` es experimental.** Una actualización del host puede cambiar su forma; tras
  actualizar, ejecuta `npm run check`.
- **La puerta de verificación es política**, no un sandbox: ejecuta un comando de shell.
- **El esquema de salida RPC debe listar todos los campos de la instantánea.** El host decodifica
  como objeto cerrado: un campo ausente produce `rpc.invalid_output` y paneles vacíos.
  `test/rpc.test.ts` compara la carga real con el esquema.
- **La cadena vacía significa «ninguno»**: `currentMember`, `stoppedReason`, `member`, `color` y
  `verify` valen `""`, nunca `null`.
- **El render exige reiniciar**: el host solo sondea las entradas al arrancar.

## Linaje

`clustercode` es una reescritura independiente de las ideas de **无限制 agent 群**
(`unlimited-agent-cluster`), un plugin de OpenCode V2 escrito en chino. Qué cambia aquí:

- Textos, comentarios y documentación en inglés.
- Nombres `clustercode` / `clustercode-<id>`, para que ambos plugins convivan sin pisarse los agentes.
- Un solo `decide()` para el hook idle y el latido, en lugar de dos copias del orden de guardas.
- `stoppedCode` legible por máquina junto al motivo humano.
- `append` incremental y `cluster_retry`.
- Una prueba de cobertura del esquema RPC, que era justo el fallo que vaciaba ambos paneles.

## Licencia

MIT. Ver [LICENSE](../LICENSE).
