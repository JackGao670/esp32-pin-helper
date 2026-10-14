# Changelog

All notable changes to **ESP Pin Planner** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Release engineering: `README.md`, `OVERVIEW.md`, `CHANGELOG.md`, `LICENSE`, extension icon and Marketplace metadata.

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
