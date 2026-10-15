import { getDevice } from "../../database/loader";
import { gpioFunctions, type PinConfigDocument } from "../model/config";
import { resolveAssignments } from "../model/peripherals";
import { candidates, definition, getPeripherals, gpioNumber } from "../resolver/peripherals";
import type { PlannerSettings, RmtChannelBank } from "../../config/userSettings";
import { DEFAULT_SETTINGS } from "../../config/userSettings";
import type { BoardProfile } from "../model/boards";
import { resolveBoardFromSettings, isBoardReserved, getBoardPinLabel, getBoardOnboardUsage, getBoardDefaultRoutes } from "../../database/boardLoader";

export interface Problem {
  gpio?: number;
  owner?: string;
  path?: (string | number)[];
  severity: "error" | "warning";
  message: string;
}

export interface ValidationContext {
  settings: PlannerSettings;
  board: BoardProfile | undefined;
}

export interface ValidationRule {
  id: string;
  check(config: PinConfigDocument, ctx: ValidationContext): Problem[];
}

/** "0-21, 26-48" — a compact rendering of a GPIO list, for diagnostics. */
function gpioRanges(gpios: number[]): string {
  const parts: string[] = [];
  for (const gpio of [...gpios].sort((a, b) => a - b)) {
    const last = parts[parts.length - 1];
    if (last === undefined) { parts.push(`${gpio}`); continue; }
    const [start, end] = last.includes("-") ? last.split("-").map(Number) : [Number(last), Number(last)];
    if (gpio === end + 1) parts[parts.length - 1] = `${start}-${gpio}`;
    else parts.push(`${gpio}`);
  }
  return parts.join(", ");
}

/** First few entries of a list, with an ellipsis when there are more. */
function shortList(values: (number | string)[], max = 8): string {
  const shown = values.slice(0, max).join(", ");
  return values.length > max ? `${shown}, …` : shown;
}

const gpioRule: ValidationRule = { id: "gpio", check(config, _ctx) {
  const device = getDevice(config.target.chip);
  if (!device) return [{ severity: "warning", path: ["target", "chip"], message: `Target ${config.target.chip} is not supported. Hardware constraints were not checked.` }];
  const problems: Problem[] = [];
  const used = new Map<number, string[]>();
  for (const [index, assignment] of resolveAssignments(config).entries()) {
    const path = assignment.owner ? ["peripherals", assignment.owner, "signals", assignment.signal!] : ["pins", index, "gpio"];
    const location = { gpio: assignment.gpio, owner: assignment.owner, path };
    const pin = device.pins.find(pin => pin.gpio === assignment.gpio);
    if (!pin) {
      problems.push({ ...location, severity: "error",
        message: `GPIO${assignment.gpio} does not exist on ${device.name}. Valid GPIOs: ${gpioRanges(device.pins.map(entry => entry.gpio))}.` });
      continue;
    }
    const label = `${assignment.owner ? `${assignment.owner}.${assignment.signal}` : `pin[${index}]`}`;
    const prior = used.get(pin.gpio) ?? [];
    if (prior.length) {
      const others = prior.join(", ");
      problems.push({ ...location, severity: "error",
        message: `Multiple assignments to GPIO${pin.gpio}: ${others} conflicts with ${label}. Give every signal its own GPIO, or let Auto-assign pick one.` });
    }
    used.set(pin.gpio, [...prior, label]);
    if (!assignment.owner && !(gpioFunctions as readonly string[]).includes(assignment.function)) {
      problems.push({ ...location, path: ["pins", index, "function"], severity: "warning",
        message: `"${assignment.function}" is not validated by this planner (it only checks ${gpioFunctions.join(" / ")}); the value is kept as-is.` });
    } else if (!assignment.owner) {
      const mismatch =
        /INPUT/.test(assignment.function) && !pin.capabilities.input ? `GPIO${pin.gpio} has no input capability, so ${assignment.function} cannot be used here.`
        : /OUTPUT/.test(assignment.function) && !pin.capabilities.output ? `GPIO${pin.gpio} is input-only, so ${assignment.function} cannot be used here; choose an output-capable GPIO.`
        : /OPEN_DRAIN/.test(assignment.function) && !pin.capabilities.openDrain ? `GPIO${pin.gpio} does not support open-drain, so ${assignment.function} cannot be used here.`
        : undefined;
      if (mismatch) problems.push({ ...location, path: ["pins", index, "function"], severity: "error", message: mismatch });
    }
    for (const message of pin.restrictions) problems.push({ ...location, severity: "warning", message });
  }
  return problems;
} };

const peripheralRule: ValidationRule = { id: "peripherals", check(config, ctx) {
  const device = getDevice(config.target.chip);
  if (!device) return [];
  const problems: Problem[] = [];
  const used = new Set<string>();
  const strict = ctx.settings.schemaStrictInstance;
  for (const [owner, peripheral] of Object.entries(config.peripherals ?? {})) {
    const location = { owner, path: ["peripherals", owner] };
    const spec = definition(peripheral.type, peripheral.instance, config.target.chip);
    const resource = `${peripheral.type}:${peripheral.instance}`;
    if (used.has(resource)) problems.push({ ...location, severity: "error", message: `${resource} is configured more than once.` });
    used.add(resource);
    if (!spec) {
      const knownInstances = getPeripherals(config.target.chip)
        .filter(peripheralDefinition => peripheralDefinition.type === peripheral.type)
        .flatMap(peripheralDefinition => peripheralDefinition.instances)
        .sort((a, b) => a - b);
      const hint = knownInstances.length
        ? `${device.name} provides ${peripheral.type}${knownInstances.join(`, ${peripheral.type}`)}.`
        : `${device.name} has no ${peripheral.type} peripheral.`;
      problems.push({ ...location,
        severity: strict ? "error" : "warning",
        message: `Unsupported peripheral ${resource}. ${hint}${strict ? "" : " (schemaStrictInstance=false; diagnostics are downgraded to warnings)"}` });
      continue;
    }
    for (const [id, value] of Object.entries(peripheral.signals)) {
      const signal = spec.signals.find(signal => signal.id === id);
      const gpio = gpioNumber(value);
      const valid = signal && gpio !== undefined && candidates(signal, config.target.chip, peripheral.instance).includes(gpio);
      if (!valid) {
        const reason = !signal
          ? `${owner} has no "${id}" signal; use one of: ${spec.signals.map(entry => entry.id).join(", ")}.`
          : gpio === undefined
            ? `"${value}" is not a GPIO reference (expected "GPIO<number>").`
            : `GPIO${gpio} cannot be routed to ${owner}.${id.toUpperCase()}; use Auto-assign or one of: ${shortList(candidates(signal, config.target.chip, peripheral.instance))}.`;
        problems.push({ ...location, path: [...location.path, "signals", id], gpio, severity: "error",
          message: `${owner}.${id}: invalid signal or GPIO route (${value}). ${reason}` });
      }
    }
    for (const signal of spec.signals.filter(signal => signal.required)) {
      if (!peripheral.signals[signal.id]) {
        problems.push({ ...location, severity: "warning",
          message: `${owner}.${signal.id.toUpperCase()} is not assigned. Assign it, or use Auto-assign for ${owner}.` });
      }
    }
    if (peripheral.type === "spi") {
      const hasMosmiso = Boolean(peripheral.signals.mosi || peripheral.signals.miso || peripheral.signals.d || peripheral.signals.q || peripheral.signals.wp || peripheral.signals.hd);
      if (!hasMosmiso) problems.push({ ...location, severity: "warning", message: `${owner}: assign at least MOSI or MISO (or D/Q for quad mode) for a working SPI bus.` });
      if (!peripheral.signals.sclk) {
        // already a required-signal warning above; skip duplicate
      } else if (!hasMosmiso) {
        // covered
      }
      if (!peripheral.signals.cs && peripheral.softwareCs !== true) {
        problems.push({ ...location, severity: "warning", message: `${owner}: CS is unassigned; set softwareCs=true in JSON if managed externally.` });
      }
      if ((peripheral.signals.d || peripheral.signals.q) && !(peripheral.signals.mosi && peripheral.signals.miso)) {
        problems.push({ ...location, severity: "warning", message: `${owner}: quad mode (D/Q/WP/HD) also requires MOSI (IO0) and MISO (IO1); rename D->mosi and Q->miso or add both.` });
      }
    }
    if (peripheral.type === "i2s") {
      if (!peripheral.signals.dout && !peripheral.signals.din) {
        problems.push({ ...location, severity: "warning", message: `${owner}: assign at least DOUT (transmit) or DIN (receive); bclk/ws alone do not carry audio.` });
      }
      if (Boolean(peripheral.signals.dout) !== Boolean(peripheral.signals.din) && Boolean(peripheral.signals.mclk)) {
        // allowed; no warning for asymmetrical streams with mclk
      }
    }
    if (peripheral.type === "adc") {
      if (Object.keys(peripheral.signals).length === 0) {
        problems.push({ ...location, severity: "warning", message: `${owner}: no ADC channels assigned.` });
      }
    }
    if (peripheral.type === "usb") {
      const hasDp = Boolean(peripheral.signals.dp);
      const hasDn = Boolean(peripheral.signals.dn);
      if (hasDp !== hasDn) {
        const missing = hasDp ? "DN (D-)" : "DP (D+)";
        problems.push({ ...location, severity: "warning",
          message: `${owner}: USB ${missing} is not assigned — the D+ / D- pair must be routed together on the fixed USB pads.` });
      }
    }
    if (peripheral.type === "camera") {
      const syncSignals = ["xclk", "pclk", "vsync", "href"];
      const missingSync = syncSignals.filter(id => !peripheral.signals[id]);
      if (missingSync.length) {
        problems.push({ ...location, severity: "warning",
          message: `${owner}: DVP sync/clock missing: ${missingSync.join(", ")}. XCLK + PCLK + VSYNC + HREF are required for any capture.` });
      }
      const dataBits = Array.from({ length: 8 }, (_, i) => `d${i}`);
      const missingData = dataBits.filter(id => !peripheral.signals[id]);
      if (missingData.length) {
        problems.push({ ...location, severity: "warning",
          message: `${owner}: 8-bit DVP data bus incomplete; missing: ${missingData.join(", ")}.` });
      }
    }
    if (peripheral.type === "lcd") {
      const syncSignals = ["pclk", "vsync", "hsync", "de"];
      const missingSync = syncSignals.filter(id => !peripheral.signals[id]);
      if (missingSync.length) {
        problems.push({ ...location, severity: "warning",
          message: `${owner}: RGB LCD sync/clock missing: ${missingSync.join(", ")}.` });
      }
      const bits8 = Array.from({ length: 8 }, (_, i) => `d${i}`);
      const missing8 = bits8.filter(id => !peripheral.signals[id]);
      if (missing8.length) {
        problems.push({ ...location, severity: "warning",
          message: `${owner}: 8-bit RGB bus missing: ${missing8.join(", ")} (minimum for standard panels).` });
      }
      const any16 = Array.from({ length: 8 }, (_, i) => `d${8 + i}`).some(id => peripheral.signals[id]);
      const missing16 = Array.from({ length: 8 }, (_, i) => `d${8 + i}`).filter(id => !peripheral.signals[id]);
      if (any16 && missing16.length) {
        problems.push({ ...location, severity: "warning",
          message: `${owner}: partial 16-bit mode; missing D8-D15 pins: ${missing16.join(", ")}.` });
      }
      const any24 = Array.from({ length: 8 }, (_, i) => `d${16 + i}`).some(id => peripheral.signals[id]);
      const missing24 = Array.from({ length: 8 }, (_, i) => `d${16 + i}`).filter(id => !peripheral.signals[id]);
      if (any24 && missing24.length) {
        problems.push({ ...location, severity: "warning",
          message: `${owner}: partial 24-bit mode; missing D16-D23 pins: ${missing24.join(", ")}.` });
      }
    }
    if (peripheral.type === "lcd_mcu") {
      const bits8 = Array.from({ length: 8 }, (_, i) => `d${i}`);
      const missing8 = bits8.filter(id => !peripheral.signals[id]);
      if (missing8.length) {
        problems.push({ ...location, severity: "warning",
          message: `${owner}: 8-bit 8080 (i80) data bus incomplete; missing: ${missing8.join(", ")}.` });
      }
      const any16 = Array.from({ length: 8 }, (_, i) => `d${8 + i}`).some(id => peripheral.signals[id]);
      const missing16 = Array.from({ length: 8 }, (_, i) => `d${8 + i}`).filter(id => !peripheral.signals[id]);
      if (any16 && missing16.length) {
        problems.push({ ...location, severity: "warning",
          message: `${owner}: partial 16-bit 8080 (i80) bus; missing D8-D15 pins: ${missing16.join(", ")}.` });
      }
    }
    if (peripheral.type === "sdmmc") {
      // 1-bit baseline (clk/cmd/d0) is covered by the required-signal warnings above.
      // Upper data lines are optional, but once any of d1-d3 is wired the 4-bit bus must be complete.
      const upper = ["d1", "d2", "d3"];
      const anyUpper = upper.some(id => peripheral.signals[id]);
      const missingUpper = upper.filter(id => !peripheral.signals[id]);
      if (anyUpper && missingUpper.length) {
        problems.push({ ...location, severity: "warning",
          message: `${owner}: 4-bit SD bus partially wired; missing ${missingUpper.join(", ").toUpperCase()}. Assign all of D1-D3 for 4-bit mode, or use the 1-bit baseline (clk/cmd/d0).` });
      }
    }
    if (peripheral.type === "camera_mipi") {
      const pairs: [string, string][] = [["csi_clkp", "csi_clkn"], ["csi_d0p", "csi_d0n"], ["csi_d1p", "csi_d1n"]];
      for (const [p, n] of pairs) {
        const hasP = !!peripheral.signals[p];
        const hasN = !!peripheral.signals[n];
        if (hasP !== hasN) {
          problems.push({ ...location, severity: "warning",
            message: `${owner}: MIPI CSI differential pair ${p}/${n} partially assigned — both P and N pads must be connected together.` });
        }
      }
      const lane0Ok = !!peripheral.signals["csi_d0p"] && !!peripheral.signals["csi_d0n"];
      const clkOk = !!peripheral.signals["csi_clkp"] && !!peripheral.signals["csi_clkn"];
      if (!clkOk || !lane0Ok) {
        problems.push({ ...location, severity: "warning",
          message: `${owner}: MIPI CSI 1-lane baseline missing CLK + lane 0 differential pairs.` });
      }
      const lane1P = !!peripheral.signals["csi_d1p"];
      const lane1N = !!peripheral.signals["csi_d1n"];
      if ((lane1P || lane1N) && !(lane1P && lane1N)) {
        // already covered by pair check above, skip duplicate
      } else if (lane1P && lane1N && (!clkOk || !lane0Ok)) {
        problems.push({ ...location, severity: "warning",
          message: `${owner}: MIPI CSI lane 1 present but 1-lane baseline is incomplete; fill CLK + lane 0 before enabling 2-lane mode.` });
      }
    }
    if (peripheral.type === "lcd_mipi") {
      const pairs: [string, string][] = [
        ["dsi_clkp", "dsi_clkn"],
        ["dsi_d0p", "dsi_d0n"],
        ["dsi_d1p", "dsi_d1n"],
        ["dsi_d2p", "dsi_d2n"],
        ["dsi_d3p", "dsi_d3n"]
      ];
      for (const [p, n] of pairs) {
        const hasP = !!peripheral.signals[p];
        const hasN = !!peripheral.signals[n];
        if (hasP !== hasN) {
          problems.push({ ...location, severity: "warning",
            message: `${owner}: MIPI DSI differential pair ${p}/${n} partially assigned.` });
        }
      }
      const lane0Ok = !!peripheral.signals["dsi_d0p"] && !!peripheral.signals["dsi_d0n"];
      const clkOk = !!peripheral.signals["dsi_clkp"] && !!peripheral.signals["dsi_clkn"];
      if (!clkOk || !lane0Ok) {
        problems.push({ ...location, severity: "warning",
          message: `${owner}: MIPI DSI 1-lane baseline missing CLK + lane 0 differential pairs.` });
      }
      for (const lane of [1, 2, 3]) {
        const p = `dsi_d${lane}p`, n = `dsi_d${lane}n`;
        const partialOrFull = !!peripheral.signals[p] || !!peripheral.signals[n];
        if (!partialOrFull) continue;
        for (const prev of Array.from({ length: lane }, (_, i) => i)) {
          const pp = `dsi_d${prev}p`, pn = `dsi_d${prev}n`;
          if (!(!!peripheral.signals[pp] && !!peripheral.signals[pn])) {
            problems.push({ ...location, severity: "warning",
              message: `${owner}: MIPI DSI lane ${lane} present but lane ${prev} is missing — lanes must be contiguous from lane 0.` });
          }
        }
      }
    }
  }
  return problems;
} };

const analogRule: ValidationRule = { id: "analog", check(config, _ctx) {
  const device = getDevice(config.target.chip);
  if (!device) return [];
  const shared = new Set(device.adcWifiSharedUnits ?? []);
  const problems: Problem[] = [];
  for (const [owner, peripheral] of Object.entries(config.peripherals ?? {})) {
    if (peripheral.type !== "adc" || !shared.has(peripheral.instance) || !Object.keys(peripheral.signals).length) continue;
    problems.push({ owner, path: ["peripherals", owner], severity: "warning",
      message: `${owner}: this ADC unit is shared with Wi-Fi; readings may be invalid or blocked while Wi-Fi is active.` });
  }
  return problems;
} };

const specialPinRule: ValidationRule = { id: "specialPins", check(config, _ctx) {
  const device = getDevice(config.target.chip);
  if (!device) return [];
  const problems: Problem[] = [];
  const memoryReserved = new Set(device.pins.filter(pin => pin.restrictions.some(text => /Usually used by Flash\/PSRAM/.test(text))).map(pin => pin.gpio));
  const jtagReserved = new Set(device.pins.filter(pin => pin.restrictions.some(text => /USB Serial\/JTAG|Reconfiguration disables the default USB Serial/.test(text))).map(pin => pin.gpio));
  for (const assignment of resolveAssignments(config)) {
    const path = assignment.owner ? ["peripherals", assignment.owner, "signals", assignment.signal!] : ["pins"];
    if (assignment.owner && jtagReserved.has(assignment.gpio) && assignment.owner !== "uart0" && !(assignment.owner.startsWith("usb") || assignment.owner.startsWith("jtag"))) {
      problems.push({ gpio: assignment.gpio, owner: assignment.owner, path, severity: "warning",
        message: `GPIO${assignment.gpio} is the default USB Serial/JTAG pin; reassignment disables the console/JTAG function.` });
    }
    if (memoryReserved.has(assignment.gpio)) {
      problems.push({ gpio: assignment.gpio, owner: assignment.owner, path, severity: "warning",
        message: `GPIO${assignment.gpio} is usually used by Flash/PSRAM; leave it unconnected unless the board routes it to a peripheral.` });
    }
  }
  return problems;
} };

const memoryModeRule: ValidationRule = { id: "memoryMode", check(config, _ctx) {
  const device = getDevice(config.target.chip);
  if (!device) return [];
  const octalPins = new Set(device.pins.filter(pin => pin.restrictions.some(text => /Reserved when Octal Flash\/PSRAM is used/.test(text))).map(pin => pin.gpio));
  if (octalPins.size === 0) return [];
  const usedGpios = new Set(resolveAssignments(config).map(assignment => assignment.gpio));
  const anyOctalUsed = [...octalPins].some(gpio => usedGpios.has(gpio));
  if (!anyOctalUsed) return [];
  const quadMemoryPins = new Set(device.pins.filter(pin => pin.restrictions.some(text => /Usually used by Flash\/PSRAM/.test(text))).map(pin => pin.gpio));
  const problems: Problem[] = [];
  for (const assignment of resolveAssignments(config)) {
    const path = assignment.owner ? ["peripherals", assignment.owner, "signals", assignment.signal!] : ["pins"];
    if (octalPins.has(assignment.gpio)) {
      problems.push({ gpio: assignment.gpio, owner: assignment.owner, path, severity: "warning",
        message: `GPIO${assignment.gpio} is an Octal SPI upper data pin (D4-D7); together with quad pins it forms the full Octal Flash/PSRAM bus.` });
    } else if (quadMemoryPins.has(assignment.gpio)) {
      problems.push({ gpio: assignment.gpio, owner: assignment.owner, path, severity: "warning",
        message: `GPIO${assignment.gpio} is the standard Flash/PSRAM data/clock pin; Octal SPI pins are also assigned, so the whole D0-D7 bus is reserved for memory.` });
    }
  }
  return problems;
} };

const rmtDirectionRule: ValidationRule = { id: "rmtDirection", check(config, ctx) {
  const txOnly: Record<string, number[]> = { esp32s3: [0, 1, 2, 3], esp32c6: [0, 1], esp32c3: [0, 1], esp32c5: [0, 1], esp32h2: [0, 1] };
  const rxOnly: Record<string, number[]> = { esp32s3: [4, 5, 6, 7], esp32c6: [2, 3], esp32c3: [2, 3], esp32c5: [2, 3], esp32h2: [2, 3] };
  const chip = config.target.chip;
  const tx = new Set(txOnly[chip] ?? []);
  const rx = new Set(rxOnly[chip] ?? []);
  if (tx.size === 0 && rx.size === 0) return [];
  const bank: RmtChannelBank = ctx.settings.rmtChannelBank;
  const problems: Problem[] = [];
  for (const [owner, peripheral] of Object.entries(config.peripherals ?? {})) {
    if (peripheral.type !== "rmt") continue;
    const location = { owner, path: ["peripherals", owner] };
    if (!Object.keys(peripheral.signals).length) continue;
    const instance = peripheral.instance;
    const isTxBank = tx.has(instance);
    const isRxBank = rx.has(instance);
    if (!isTxBank && !isRxBank) continue;
    // User declared all channels as TX-only: skip TX-bank warnings (they are expected)
    // and still warn if user accidentally placed a device on RX-bank.
    if (bank === "tx" && isTxBank) continue;
    if (bank === "rx" && isRxBank) continue;
    if (isTxBank) {
      problems.push({ ...location, severity: "warning",
        message: `${owner}: RMT channel ${instance} is TX-only on ESP-IDF builds; connect it to an input-only device sink only if it actually drives the line.` });
    } else if (isRxBank) {
      problems.push({ ...location, severity: "warning",
        message: `${owner}: RMT channel ${instance} is RX-only on ESP-IDF builds; do not drive LEDs or transceivers from this channel.` });
    }
  }
  return problems;
} };

const boardRule: ValidationRule = { id: "board", check(config, ctx) {
  const board = ctx.board;
  if (!board) return [];
  const problems: Problem[] = [];
  for (const assignment of resolveAssignments(config)) {
    if (!isBoardReserved(board, assignment.gpio)) continue;
    const path = assignment.owner ? ["peripherals", assignment.owner, "signals", assignment.signal!] : ["pins", 0, "gpio"];
    const label = getBoardPinLabel(board, assignment.gpio);
    const where = assignment.owner ? `${assignment.owner}.${assignment.signal}` : `pin row`;
    problems.push({
      gpio: assignment.gpio,
      owner: assignment.owner,
      path,
      severity: "warning",
      message: `GPIO${assignment.gpio} (${label}) is marked reserved on ${board.name}. Reassigning ${where} may conflict with onboard hardware.`
    });
  }
  return problems;
} };

// 板载占用提示：该 GPIO 在 PCB 上焊到板载器件（USB-UART 桥、SD 卡座、以太网 PHY、共享 I2C 总线等）。
// 与 boardRule（reservedGpios）互补：reserved 是"不要复用"，此处是"复用了会牺牲板载功能"，因此只提示不阻断。
const boardUsageRule: ValidationRule = { id: "boardUsage", check(config, ctx) {
  const board = ctx.board;
  if (!board?.onboardPins?.length) return [];
  const problems: Problem[] = [];
  for (const [index, assignment] of resolveAssignments(config).entries()) {
    if (isBoardReserved(board, assignment.gpio)) continue; // 已由 boardRule 报出，避免重复
    const usage = getBoardOnboardUsage(board, assignment.gpio);
    if (!usage) continue;
    // 用户分配的就是该板的默认接线（如 C6 uart0 的 16/17）→ 不算冲突。
    if (assignment.owner &&
        getBoardDefaultRoutes(board, assignment.gpio).includes(`${assignment.owner}.${assignment.signal}`)) continue;
    const path = assignment.owner ? ["peripherals", assignment.owner, "signals", assignment.signal!] : ["pins", index, "gpio"];
    problems.push({
      gpio: assignment.gpio,
      owner: assignment.owner,
      path,
      severity: "warning",
      message: `GPIO${assignment.gpio} is wired to the ${usage} on ${board.name}; using it for a different function disables that on-board device.`
    });
  }
  return problems;
} };

export const defaultRules: ValidationRule[] = [gpioRule, peripheralRule, analogRule, specialPinRule, memoryModeRule, rmtDirectionRule, boardRule, boardUsageRule];

export function validateGpio(config: PinConfigDocument,
                             rules: ValidationRule[] = defaultRules,
                             settingsOverride: Partial<PlannerSettings> = {}): Problem[] {
  const settings: PlannerSettings = {
    defaultTarget: settingsOverride.defaultTarget ?? DEFAULT_SETTINGS.defaultTarget,
    schemaStrictInstance: settingsOverride.schemaStrictInstance ?? DEFAULT_SETTINGS.schemaStrictInstance,
    rmtChannelBank: settingsOverride.rmtChannelBank ?? DEFAULT_SETTINGS.rmtChannelBank,
    board: settingsOverride.board ?? DEFAULT_SETTINGS.board,
    language: settingsOverride.language ?? DEFAULT_SETTINGS.language
  };
  const chip = config.target.chip as Parameters<typeof resolveBoardFromSettings>[1];
  const board = resolveBoardFromSettings(settings.board,
    // resolveBoardFromSettings expects TargetChip; keep string union guard to not break odd imported docs
    (chip === "esp32s3" || chip === "esp32c6" || chip === "esp32p4" || chip === "esp32c3" || chip === "esp32c2" || chip === "esp32" || chip === "esp32s2" || chip === "esp32c5" || chip === "esp32h2" ? chip : DEFAULT_SETTINGS.defaultTarget));
  const ctx: ValidationContext = { settings, board };
  return rules.flatMap(rule => rule.check(config, ctx));
}
