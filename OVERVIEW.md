# ESP Pin Planner — Overview

A design overview of how ESP Pin Planner is put together: the layered architecture, the data model,
the constraint/optimizer design and the host ↔ WebView protocol. For user-facing documentation see
[README.md](README.md).

## 1. Scope

ESP Pin Planner turns "which GPIO should I use for this peripheral?" into a checked, repeatable
decision for ESP32-S3 / C6 / P4 projects, and records the result in a single `.pinconfig.json` file.

**In scope:** pin/peripheral modelling, hardware-constraint checking, board awareness, automatic pin
assignment, Problems integration, target detection.

**Explicitly out of scope:** generating C/C++ code, editing `sdkconfig`, flashing, or building firmware.
The contract with the user's firmware is the JSON file, nothing more.

## 2. Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ VS Code extension host (Node)                                    │
│                                                                  │
│  src/extension.ts ── commands, webview panel, file I/O           │
│        │                                                         │
│        ├── src/vscode/       ai · diagnostics · home · detector   │
│        ├── src/core/model/   config · peripherals · boards · msg │
│        ├── src/core/resolver/peripherals.ts   signal → GPIO sets │
│        ├── src/core/validator/gpio.ts         rule engine        │
│        ├── src/core/optimizer/assign.ts       auto-assignment    │
│        ├── src/core/ai/      intent · prompt  (LLM → optimizer)  │
│        └── src/database/     loader · boardLoader                │
│                                                                  │
│  data (esp-device-pack, bundled at build time)                   │
│        devices/esp32{s3,c6,p4}/*.json     chip databases         │
│        boards/espressif/*.json            board profiles         │
│        pack.json                          manifest + file list    │
└───────────────────────────┬──────────────────────────────────────┘
                            │  postMessage: ClientMessage / HostMessage
┌───────────────────────────▼──────────────────────────────────────┐
│ WebView (React + Zustand, dist/webview/planner.js)               │
│   App.tsx pinout · PeripheralPanel.tsx · BoardView · store.ts    │
│   (bundles the same core modules — resolver + optimizer — so the │
│    WebView can pre-solve assignments locally)                    │
└──────────────────────────────────────────────────────────────────┘
```

Two invariants keep this simple:

1. **One source of truth for the file.** The WebView never writes files. It posts an intent message;
   the host applies it through `vscode.WorkspaceEdit`, saves, then broadcasts the new `PlannerState`.
2. **Pure core.** `src/core/**` and `src/database/**` have no `vscode` import. The extension host and
   the WebView both bundle the same modules, so Pin Planner, tests and the browser preview all run
   identical logic. The optimizer in particular depends only on a lightweight `BoardHints` shape that
   both `BoardProfile` (host) and `BoardInfo` (WebView) satisfy — no new host messages were needed to
   enable the auto-assign wizard.

## 3. Data model

### 3.1 Chip database (`esp-device-pack`: `devices/<chip>/<chip>.json`)

Loaded and validated by [loader.ts](file:///d:/workspace/esp-pin-planer/esp32-pin-helper/src/database/loader.ts).
Per chip: `gpioNumbers`, `strapping` / `rtc` / `analog` / `memoryPins` / `octalMemoryPins` / `usbJtag`
classifications, `inputOnlyPins`, `noOpenDrainPins`, ADC units and `source` metadata (TRM + ESP-IDF
version). `loadDevice()` rejects a database whose `databaseVersion` is not semantic, whose `gpioNumbers`
are duplicated/negative, or whose `source.url` is missing — a bad database fails loudly instead of
silently degrading the UI.

Each GPIO becomes a `PinDefinition` with `capabilities` (input/output/openDrain/gpioMatrix/analog/rtc)
and a list of human-readable `restrictions` (strapping, Flash/PSRAM, octal, USB-JTAG, input-only,
no-open-drain, variant-bonding). Those restriction strings are the shared vocabulary the validator and
the optimizer both key off.

### 3.2 Board profiles (`esp-device-pack`: `boards/<vendor>/<board>.json`)

`BoardProfile` adds a physical-board layer on top of a chip: labelled pins, `reservedGpios`,
`peripherals` (default signal→GPIO routes) and `onboardPins` (board-wired devices such as the USB-UART
bridge — reusable, but using them breaks the on-board device). Board selection is resolved from settings
([boardLoader.ts](file:///d:/workspace/esp-pin-planer/esp32-pin-helper/src/database/boardLoader.ts)):

- `preset = none` → no board features.
- `preset = byId` → `vendor` + `id`; a target-chip mismatch silently degrades to "no board".
- `preset = auto` → the only board for that chip, or the single board flagged `"default": true`;
  otherwise no board is assumed (the tool refuses to guess — no board beats a wrong board).

`boardInfoOf()` projects a `BoardProfile` down to the compact `BoardInfo` sent to the WebView.

### 3.3 Configuration (`.pinconfig.json`)

```jsonc
{
  "version": 1,
  "target": { "chip": "esp32s3" },
  "pins":        [{ "gpio": 8, "function": "GPIO_OPEN_DRAIN" }],
  "peripherals": { "i2c0": { "type": "i2c", "instance": 0,
                             "signals": { "sda": "GPIO8", "scl": "GPIO9" } } }
}
```

`parseConfig()` validates the envelope; unknown extension fields survive a round-trip so hand-written
annotations are never destroyed. A JSON schema (`schemas/pinconfig.schema.json`) is registered for the
editor, so completion/validation works even before the extension activates.

## 4. Resolver — signal → legal GPIOs

[core/resolver/peripherals.ts](file:///d:/workspace/esp-pin-planer/esp32-pin-helper/src/core/resolver/peripherals.ts)
answers the only two questions everything else needs:

- `definition(type, instance, chip)` → the peripheral's signal list (id, direction, required, width…).
- `candidates(signal, chip, instance)` → the set of GPIOs that can legally carry that signal, derived
  from the chip's capability/restriction data plus peripheral-specific rules (IO-MUX-fixed vs
  GPIO-matrix pins, per-instance dedicated pins, RMT channel banks, LCD bus width, …).

Hard legality lives here; everything downstream is soft preference.

## 5. Validator — the rule engine

[core/validator/gpio.ts](file:///d:/workspace/esp-pin-planer/esp32-pin-helper/src/core/validator/gpio.ts)
turns a config into `Problem[]` (severity, message, GPIO-coded range) that feed the Problems panel and
the "View in Pin Planner" quick fix. Rules cover: duplicate/occupied pins, capability and direction
mismatches, strapping/reserved/input-only reuse, board-reserved and on-board reuse, and
peripheral-level integrity — Camera signal completeness, LCD MCU/RGB bus-width constraints, and USB
D+/D− pairing. Only implemented constraints are checked, and the UI says so.

## 6. Optimizer — automatic pin assignment

[core/optimizer/assign.ts](file:///d:/workspace/esp-pin-planer/esp32-pin-helper/src/core/optimizer/assign.ts).

**Model.** Decision variables are the GPIO chosen for every requested signal. Value domain for a signal
is `candidates()` minus occupied and explicitly rejected pins. Constraints: no two signals share a GPIO,
and every signal sits on a legal pin.

**Search.** Most-constrained-first greedy DFS with backtracking: slots are ordered by candidate count,
candidates are pre-sorted by score, and complete leaves are collected until `maxPlans × 6` plans (or a
200 000-node budget) are reached. The candidate cap per slot is `max(16, slots × 2)` — widened for
slot-heavy builds because every slot prefers the same low GPIOs and a fixed cap would starve 20-signal
combinations such as Camera + 8080 LCD.

**Objective.** Per-choice score, summed over the plan:

| Signal condition | Weight |
|---|---|
| board default route for this owner.signal | **+50** |
| strapping pin | **−100** |
| usually Flash/PSRAM | **−100** |
| reserved in Octal mode | **−80** |
| wired to an on-board device (non-default) | **−60** |
| USB Serial/JTAG pin | **−30** |
| low GPIO number | **−0.5 × gpio** |

Preferences toggle these groups: `avoidStrapping`, `avoidReserved`, `avoidBoardReserved`,
`preferBoardDefaults`, `preferLowGpio`, `maxPlans`. Board-reserved pins are hard-excluded from the
candidate pool when a board is active, with a fallback to the full set only when nothing else remains.

**Interactive refinement.** `RecommendContext` adds two per-signal fields keyed by `"owner.signal"`:

- `pinned` — an accepted signal is collapsed to its single GPIO, and the other signals re-route around it.
- `blocked` — a rejected pin is dropped for that signal only, leaving the rest of the plan intact.

Both simply feed the same `recommendAssignment` call, which is why "Accept"/"Replace" need no new API —
they are re-solves with a tighter context.

## 7. AI intent layer — the model never picks a GPIO

[core/ai/intent.ts](file:///d:/workspace/esp-pin-planer/esp32-pin-helper/src/core/ai/intent.ts) ·
[core/ai/prompt.ts](file:///d:/workspace/esp-pin-planer/esp32-pin-helper/src/core/ai/prompt.ts).

The contract with the language model is deliberately narrow. It may only answer with an **intent** — the
target chip, which peripheral instances to configure, which signals to wire, and (only for pins the user
named explicitly) plain GPIO functions:

```jsonc
{ "chip": "esp32p4",
  "avoidStrapping": true,
  "peripherals": [{ "type": "camera", "instance": 0 }, { "type": "i2c", "instance": 0 }],
  "pinFunctions": [] }
```

It is never asked **which GPIO** a signal lands on and never writes C/C++. Any pin number the model
volunteers for a peripheral is discarded by `parseIntent()` (unknown keys are ignored), so a hallucinated
route cannot leak through. The pipeline is:

```
LLM → intent JSON ──parseIntent()──► IntentSpec ──planFromIntent()──► config ──validateGpio()──► plan
                                             (recommendAssignment)
```

`planFromIntent()` re-uses the same `recommendAssignment` the auto-assign wizard calls, so AI plans are
eligible for the same board defaults, strapping/reserved avoidance and occupied-pin exclusion. Requests
that cannot be honoured (a peripheral absent on the chip, a signal id that does not exist, a bus that
cannot fit) are reported in `dropped[]` rather than silently invented, and the validator's `problems[]`
decides whether the result is offered at all. The prompt itself is built from the same databases
(`buildCatalogue`, `pinsToAvoid`), so the model is told the chip's real instances and signal ids instead
of guessing.

**Repair mode.** `intentFromConfig()` recovers the intent behind an existing file; `deriveRepairContext()`
pins every signal the validator did **not** flag and marks the plain pins as occupied, so the first repair
iteration is a minimal change. The loop in `vscode/aiAssistant.ts` then re-asks, re-solves and re-checks up
to three times, and only a configuration that validates clean is offered for **Apply** — otherwise the
user gets the remaining errors and an explanation.

Everything in `core/ai/**` is pure (no `vscode` import) and unit-tested; the host module only owns the
chat participant, the proposal store and the `WorkspaceEdit` that writes the file.

## 8. Host ↔ WebView protocol

[core/model/messages.ts](file:///d:/workspace/esp-pin-planer/esp32-pin-helper/src/core/model/messages.ts).

- **WebView → host (`ClientMessage`)**: `ready`, `openJson`, `setPin`, `addPeripheral`,
  `removePeripheral`, `setSignal`, `selectTarget`. Every mutating message carries the `revision` it was
  based on.
- **host → WebView (`HostMessage`)**: `state` (the whole `PlannerState`) and `focus` (jump to a GPIO,
  used by the diagnostic quick fix).

The host serialises all messages through a promise queue, re-reads the file before every write, and
rejects a mutation if the on-disk text no longer matches the revision the WebView saw — so an external
edit can never be clobbered. File watchers on `.pinconfig.json` and `sdkconfig` keep the panel live.

## 9. Build & test

- **Bundling**: `esbuild` bundles the extension into `dist/extension.js`, inlining the chip/board JSON
  from the `esp-device-pack` package (`packages/esp-device-pack`, a `file:` dependency carrying its own
  `version` / `apiVersion` / `databaseVersion` in `pack.json`) — so the raw `devices/**` and `boards/**`
  trees are *not* shipped; `vite` bundles the WebView into `dist/webview/planner.{js,css}`. The manifest's
  `apiVersion` is gated in `src/database/pack.ts` and checked against the loaded data by tests, so chip
  data can be versioned and released on its own track (`.github/workflows/device-pack.yml`).
- **Packaging**: `.vscodeignore` keeps only `dist/**`, `schemas/**`, `resources/**` and `package.json`.
- **Tests**: `tsx --test test/*.test.ts` — data integrity, resolver legality, validator rules, config
  round-trips, the optimizer (board defaults, strapping avoidance, occupied pins, Top-N, per-signal
  pin/block), the AI intent layer (strict parsing, JSON extraction, planning, repair context, prompts)
  and a 13-scenario combination matrix that asserts success, legality and a P95 latency
  budget under 500 ms.
- **Browser preview**: `npm run dev:webview` serves the WebView standalone at `127.0.0.1:5173` for UI
  work without launching VS Code.
- **CI**: [.github/workflows/ci.yml](file:///d:/workspace/esp-pin-planer/esp32-pin-helper/.github/workflows/ci.yml)
  runs the same `npm test` + `npm run build` on every push / PR to `main` and uploads the packaged VSIX
  as an artifact; pushing a `v*` tag additionally attaches it to the GitHub release. The database pack
  will get its own workflow once it is split out (§6.2 task 4.2).
