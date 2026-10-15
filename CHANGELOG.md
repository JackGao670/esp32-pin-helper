# Changelog

All notable changes to **ESP Pin Planner** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **CI pipeline** (`.github/workflows/ci.yml`): on every push / PR to `main` it installs, runs the unit
  tests, builds (type-check + esbuild + vite) and packages the VSIX as a build artifact; a `v*` tag also
  attaches that VSIX to the GitHub release.
- **AI assistant** (`@espPinPlanner` chat participant, `/generate` and `/fix` commands): describe the
  peripherals you want and get a validated `.pinconfig.json`.
- **"Ask AI to fix"** — a Problems quick fix (and `espPinPlanner.fixWithAi` command) that asks the model
  to repair the configuration and re-checks it before offering to apply it.
- AI intent layer (`src/core/ai/`): the model may only say *what* to wire (chip, peripheral instances,
  signals, plain GPIO functions), never *which* GPIO. The deterministic optimizer assigns the pins and
  the validator gates the result, so a hallucinated route can never reach `.pinconfig.json`.
- Release engineering: `README.md`, `OVERVIEW.md`, `CHANGELOG.md`, `LICENSE`, extension icon and Marketplace metadata.
- **Actionable diagnostics** (§4.7): every validation problem now says how to fix it — a bad GPIO lists the
  valid pins, an input-only pin suggests an output-capable one, a mis-routed signal names the GPIOs that
  would work, an unknown signal lists the real ones, and an unsupported peripheral names the instances the
  chip does have. JSON syntax errors include the concrete reason.
- **Performance baseline** (§4.7): a regression test validates the widest legal ESP32-S3 configuration
  (40+ assignments) through `validateGpio` and the diagnostics bridge and asserts a P95 under 100 ms.
- **`esp-device-pack`** (§4.2): the chip and board database (devices/ boards/ JSON) now lives in its own
  versioned package under `packages/esp-device-pack`, consumed by the extension through a `file:` dependency
  and shipped with a `pack.json` manifest (`version`, `apiVersion`, `databaseVersion`, the device/board
  file list). The manifest's `apiVersion` is gated at load time and checked against the real data by tests,
  so chip data can be versioned and released on its own track. A dedicated `Device Pack` workflow validates
  the manifest and packs the tarball independently of the extension.
- **Accessibility** (§4.7): the webview is now screen-reader and keyboard friendly. Every pin cell is a
  `aria-pressed` toggle button whose `aria-label` carries the same description as its tooltip (reserved /
  on-board / recommended / assigned state), decorative dots and the chip mark are `aria-hidden`, the pinout
  and legend are exposed as labelled `group` / `list`, the inspector status and problem counts are live
  regions, and each panel is a labelled landmark. Plan-row pin references are real `<button>`s (previously
  a `<code role="button">`) and plan tabs, board-default Apply and Accept/Replace carry accessible names.
  Focus rings now cover inputs as well as buttons and selects, and the Activity Bar home view and the
  planner panel declare `lang="en"` and a `<main>` landmark. Covered by `test/webviewA11y.test.ts`, which
  statically renders the webview and asserts these attributes.
- **Internationalization** (§4.7): the interface is now bilingual (English / Simplified Chinese). A single
  pure-core catalog (`src/i18n/messages.ts`) is shared by the extension host, the WebView and the tests, so
  the two sides can never drift; keys are plain `{name}` templates and unknown parameters are left verbatim.
  The language follows the VS Code display language by default and can be forced with
  `espPinPlanner.language` (`auto` / `en` / `zh-cn`). Command titles, the Activity Bar view and every
  setting description are localised through `package.nls.json` / `package.nls.zh-cn.json`, and validator
  diagnostics intentionally stay English so tooling and existing tests keep a stable contract.
- **ESP32-P4 low-power peripherals** (§4.1): the P4 database now models the **LP UART** (`lpuart0`, TXD/RXD
  required plus CTSN/RTSN/DSRN/DTRN) and the **LP I2C** (`lpi2c0`, SDA/SCL open-drain) controllers, which are
  separate from UART0-4 / I2C0-1. LP signals are routed through the LP GPIO matrix and can only reach the
  low-power domain pads **GPIO0-15** (VDD_LP / VDD_BAT), so every LP signal carries an explicit pad allow-list
  and the candidate/validator layer rejects HP pads such as GPIO20. The schema gains the `lpuart` / `lpi2c`
  types, the `signals-lpuart` / `signals-lpi2c` signal maps and the P4 owner/instance constraints.
- **ESP32-P4 low-power SPI / I2S** (§4.1): the P4 database now also models the **LP SPI** (`lpspi0`,
  LP_SPI_CK/CS/D/Q) and the **LP I2S** (`lpi2s0`) controllers on the same low-power domain as above, so they
  are likewise restricted to GPIO0-15. ESP-IDF documents that LP I2S on ESP32-P4 works as an **I2S slave only**
  and exposes an RX channel only (no TX, no DMA), so its `bclk` / `ws` / `din` lines are modelled as inputs fed
  by an external master. No LP SPI driver is documented in ESP-IDF v5.4, and the LP GPIO matrix exposes both an
  input and an output path for each LP SPI line, so the four lines are modelled role-agnostically rather than
  asserting a master/slave role. The schema gains the `lpspi` / `lpi2s` types, the `signals-lpspi` /
  `signals-lpi2s` signal maps and the P4 owner/instance constraints. LP_CAM remains unmodelled.
- **ESP32-C3 / ESP32-C2 chip data** (§4.1): two more RISC-V targets join the database. The **ESP32-C3**
  contributes 22 GPIOs (no input-only pins, strapping GPIO2/8/9, RTC GPIO0-5), UART 0-1, I2C 0, SPI 2,
  LEDC 0-5, ADC1 (GPIO0-4) + ADC2 (GPIO5), RMT 0-3 (TX 0-1 / RX 2-3), I2S 0, the fixed **USB Serial/JTAG**
  pads (GPIO18/19) and a single **TWAI** controller; it has no SDMMC host and no LCD_CAM. The **ESP32-C2**
  contributes 21 GPIOs (of which GPIO11-17 are only bonded on non-SiP parts, so 14 pins remain on SiP-flash
  modules), strapping GPIO8/9, RTC GPIO0-5, UART 0-1, I2C 0, SPI 2, LEDC 0-5 and **ADC1 only** — it has no
  RMT, I2S, TWAI, USB, LCD_CAM or SD host controller, and GPIO19/20 carry the default U0RXD/U0TXD function.
  The `TargetChip` union, the settings guard, the schema (`chip` enum plus per-chip owner/instance rules),
  the RMT TX/RX bank rule and the AI chip detector were extended accordingly. No reference boards are
  added yet for these two chips.
- **ESP32 / ESP32-S2 chip data** (§4.1): the two original Xtensa targets join the database. The **classic
  ESP32** contributes its 34 bonded GPIOs (0-19, 21-23, 25-27, 32-39; GPIO20 and GPIO24/28-31 are not bonded
  out), the six **input-only ADC1 pads GPIO34-39** (no output / open-drain driver), strapping GPIO0/2/5/12/15,
  RTC on 18 pads, the 8-channel ADC1 (GPIO36/37/38/39/32/33/34/35) and 10-channel ADC2 (GPIO4/0/2/15/13/12/14/27/25/26,
  shared with Wi-Fi), flash GPIO6-11 plus the WROVER PSRAM pads GPIO16/17, UART 0-2, I2C 0-1, HSPI/VSPI
  (SPI2/SPI3), I2S 0-1, 16 LEDC channels, 8 RMT channels and a single **TWAI** controller — it has **no USB**
  peripheral. The **ESP32-S2** contributes its 43 GPIOs (0-21, 26-46; 22-25 do not exist), the single
  **input-only pad GPIO46**, strapping GPIO0/45/46, RTC on GPIO0-21, ADC1 GPIO1-10 and ADC2 GPIO11-20
  (both Wi-Fi-shared), quad flash/PSRAM on GPIO26-32 with the octal variant adding GPIO33-37, UART 0-1,
  I2C 0-1, SPI2/SPI3 (SPI3 single-line), I2S 0, 8 low-speed LEDC channels, 4 RMT channels, a single **TWAI**
  controller and the fixed **USB OTG** pads (D- = GPIO19, D+ = GPIO20). A new `usbOtgPins` device field
  models the OTG pads separately from the USB Serial/JTAG pads (which the S2 does not have), and the
  input-only restriction text was generalised (it no longer mentions the ESP32-S3-specific MTDO strapping).
  The `TargetChip` union, the settings guard, the schema (`chip` enum plus per-chip owner/instance rules)
  and the AI chip detector were extended accordingly; RMT direction is intentionally not enforced on these
  two chips because every RMT channel can be configured as either TX or RX. No reference boards are added.
- **ESP32-C5 / ESP32-H2 chip data** (§4.1): the database now covers **nine** chips. The **ESP32-C5**
  contributes 29 GPIOs (0-28, no input-only pads), strapping GPIO2/7/27/28, RTC GPIO0-7, a single 6-channel
  **ADC1** (GPIO1-6, no ADC2), flash/PSRAM on GPIO16-22, UART 0-1, I2C 0, SPI2, LEDC 0-5, RMT 0-3
  (TX 0-1 / RX 2-3), I2S 0 and the fixed **USB Serial/JTAG** pads (D- = GPIO13, D+ = GPIO14); it has no USB
  OTG, no SDMMC host and no enableable TWAI (ESP-IDF v5.4 leaves `SOC_TWAI_SUPPORTED` behind an open TODO),
  and the LP-domain UART/I2C controllers are not modelled. The **ESP32-H2** contributes 28 GPIOs (0-27, no
  input-only pads), strapping GPIO2/3/8/9/25, RTC GPIO7-14, a single 5-channel **ADC1** (GPIO1-5, no ADC2),
  flash GPIO15-21 (GPIO6-7 and GPIO15-21 are only bonded out on non-SiP parts), UART 0-1, I2C 0-1, SPI2,
  LEDC 0-5, RMT 0-3 (TX 0-1 / RX 2-3), I2S 0, a single **TWAI** controller and the fixed **USB Serial/JTAG**
  pads (D- = GPIO26, D+ = GPIO27); it has no Wi-Fi, USB OTG or SDMMC host. The `TargetChip` union, the
  settings guards, the schema (`chip` enum plus per-chip owner/instance rules), the RMT TX/RX bank rule and
  the AI chip detector were extended accordingly. No reference boards are added.

### Fixed
- **ESP32-P4 ADC units** (§4.1): the P4 database now models **two** ADC units — ADC1 on GPIO16-23 and
  ADC2 on GPIO49-54 — matching `soc/esp32p4/adc_channel.h` and the datasheet Analog Functions table.
  Previously all 14 analog pins were folded into ADC1, so an `adc2` channel could not be declared and a
  GPIO49-54 assignment on `adc1` was accepted even though the ESP-IDF driver rejects it. (The ESP-IDF GPIO
  summary page labels GPIO49-54 as `ADC1_CH8-13`, contradicting the driver header; the header/datasheet
  mapping is used here.)
- **ESP32-P4 package** (§4.1): the P4 Function-EV board profile declared `QFN-88`, which does not exist
  for this chip. ESP32-P4 ships in a single **QFN104 (10x10 mm)** package (`ESP32-P4NRW16` / `NRW32`, same
  pinout) that bonds out all 55 GPIOs, so no un-bonded pin has to be modelled; flash/PSRAM use dedicated
  `FLASH_*` pads and reserve no GPIO. The board metadata was corrected and the chip scope now states this
  instead of the previous "package not fully checked" caveat.

## [0.0.3] - 2026-10-14

### Added
- **Pin auto-assignment optimizer** (`recommendAssignment`): constrains every peripheral signal to legal GPIOs
  (capability, direction, reserved, strapping, board usage) and returns ranked Top-N plans scored by
  "fewest warnings + preferred pins".
- **Auto-assign wizard** in the Peripheral panel: choose peripheral type / instance, toggle "auto-assign"
  and "avoid strapping", preview up to 3 plans and apply one in a click.
- **Candidate highlighting** on the pinout: auto-recommended GPIOs are drawn with a dashed accent border,
  with a legend entry.
- **Per-signal Accept / Replace**: lock an accepted signal (`pinned`) or dismiss a rejected pin for a single
  signal (`blocked`) and let the solver re-route the rest.
- Peripheral rule engine checks: Camera signal completeness, LCD RGB / MCU bus width, USB D+/D- pairing,
  TWAI/CAN and SDMMC host modelling.
- Board profiles for the Espressif reference boards (ESP32-S3-DevKitC-1, ESP32-C6-DevKitC-1,
  ESP32-C6-DevKitM-1, ESP32-P4-Function-EV-Board) with reserved pins and default signal maps.
- Combination test matrix (13 scenarios across S3 / C6 / P4) validating success rate, legality and
  P95 latency budget (< 500 ms).

### Changed
- Optimizer candidate cap now scales with the number of slots (`max(16, slots × 2)`) so large
  combinations such as Camera + LCD (22 signals) resolve instead of starving.

## [0.0.2] - 2026-10-13

### Added
- **Board Profile layer**: `boards/<vendor>/<name>.json` describing on-board peripherals, reserved GPIOs
  and default signal maps; board-aware warnings for on-board pin reuse.
- Camera / LCD preset panels in the peripheral WebView.
- Multi-chip target selection for all shipped databases (ESP32-S3 / C6 / P4).
- Plan Planner activity-bar view (chip / board / problem summary).

## [0.0.1] - 2026-10-12

### Added
- Initial proof of concept: target detection (`.pinconfig.json` / `sdkconfig`), GPIO function assignment,
  peripheral model, GPIO validator and Problems diagnostics.
- Device databases for ESP32-S3, ESP32-C6 and ESP32-P4 with strapping / RTC / analog / memory / USB-JTAG
  classification and per-pin restrictions.
- `.pinconfig.json` model + JSON schema + `Validate Pin Config` / `Create New Pin Config` /
  `Select Target Chip` / `Open Pin Planner` commands.
- First installable VSIX package.

[Unreleased]: #unreleased
[0.0.3]: #003---2026-10-14
[0.0.2]: #002---2026-10-13
[0.0.1]: #001---2026-10-12
