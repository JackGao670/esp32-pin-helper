// AI intent layer (Phase 4 §6.2 tasks 4.3 / 4.4).
//
// The language model never picks GPIO numbers. It only proposes WHAT the user wants:
// the target chip, which peripheral instances to configure, which signals to wire, and
// optionally a few plain GPIO functions. The deterministic optimizer then assigns legal
// pins and the validator gates the result — hallucinated pin routes never reach
// `.pinconfig.json`.
//
// Everything here is pure (no `vscode` import) so the extension host and node tests run
// the exact same code.

import { createConfig, gpioFunctions, setPin, type GpioFunction, type PinConfigDocument } from "../model/config";
import { addPeripheral, setSignal } from "../model/peripherals";
import { definition, gpioNumber } from "../resolver/peripherals";
import { getDevice } from "../../database/loader";
import { recommendAssignment, type BoardHints, type PeripheralRequest } from "../optimizer/assign";
import { validateGpio, type Problem } from "../validator/gpio";
import type { PlannerSettings } from "../../config/userSettings";

/** One peripheral instance the model wants configured. */
export interface PeripheralIntent {
  type: string;
  instance: number;
  /** Signal ids to wire; omitted = the definition's required signals. */
  signals?: string[];
}

/** A plain GPIO function (not tied to a peripheral) the user explicitly asked for. */
export interface PinIntent {
  gpio: number;
  function: GpioFunction;
}

/** The strict, validated shape of what the model is allowed to return. */
export interface IntentSpec {
  chip?: string;
  avoidStrapping?: boolean;
  peripherals?: PeripheralIntent[];
  pinFunctions?: PinIntent[];
}

export interface PlanContext {
  board?: BoardHints;
  /** GPIOs already used by something else that must not be reused. */
  occupied?: number[];
  /** "owner.signal" → GPIO that must keep its pin (minimal-change repair). */
  pinned?: Record<string, number>;
  settings?: Partial<PlannerSettings>;
}

export interface IntentPlan {
  config: PinConfigDocument;
  score: number;
  /** Optimizer notes for the compromises it had to make (strapping, reserved, …). */
  warnings: string[];
  /** Requests that could not be honoured, each with a reason. */
  dropped: string[];
  /** Full validator output for the produced configuration. */
  problems: Problem[];
}

export interface RepairContext {
  pinned: Record<string, number>;
  occupied: number[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Validate the model's JSON strictly. Unknown keys are ignored (models often add helpful
 * extras), but a wrong type or a missing required field throws with a precise message.
 */
export function parseIntent(raw: unknown): IntentSpec {
  if (!isRecord(raw)) throw new Error("The proposal must be a JSON object.");
  const spec: IntentSpec = {};
  if (raw.chip !== undefined) {
    if (typeof raw.chip !== "string" || !raw.chip) throw new Error("`chip` must be a non-empty string.");
    spec.chip = raw.chip;
  }
  if (raw.avoidStrapping !== undefined) {
    if (typeof raw.avoidStrapping !== "boolean") throw new Error("`avoidStrapping` must be a boolean.");
    spec.avoidStrapping = raw.avoidStrapping;
  }
  if (raw.peripherals !== undefined) {
    if (!Array.isArray(raw.peripherals)) throw new Error("`peripherals` must be an array.");
    spec.peripherals = raw.peripherals.map((entry, index) => {
      if (!isRecord(entry)) throw new Error(`peripherals[${index}] must be an object.`);
      if (typeof entry.type !== "string" || !entry.type) throw new Error(`peripherals[${index}].type must be a non-empty string.`);
      if (!Number.isInteger(entry.instance) || (entry.instance as number) < 0) {
        throw new Error(`peripherals[${index}].instance must be a non-negative integer.`);
      }
      const signals = entry.signals;
      if (signals !== undefined && (!Array.isArray(signals) || !signals.every(id => typeof id === "string"))) {
        throw new Error(`peripherals[${index}].signals must be an array of strings.`);
      }
      return {
        type: entry.type,
        instance: entry.instance as number,
        ...(signals ? { signals: signals as string[] } : {})
      };
    });
  }
  if (raw.pinFunctions !== undefined) {
    if (!Array.isArray(raw.pinFunctions)) throw new Error("`pinFunctions` must be an array.");
    spec.pinFunctions = raw.pinFunctions.map((entry, index) => {
      if (!isRecord(entry)) throw new Error(`pinFunctions[${index}] must be an object.`);
      if (!Number.isInteger(entry.gpio) || (entry.gpio as number) < 0) {
        throw new Error(`pinFunctions[${index}].gpio must be a non-negative integer.`);
      }
      if (typeof entry.function !== "string" || !(gpioFunctions as readonly string[]).includes(entry.function)) {
        throw new Error(`pinFunctions[${index}].function must be one of ${gpioFunctions.join(", ")}.`);
      }
      return { gpio: entry.gpio as number, function: entry.function as GpioFunction };
    });
  }
  return spec;
}

/** Pull the first JSON object out of a model response (fenced block or bare text) and validate it. */
export function extractIntentJson(text: string): IntentSpec {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("The model did not return a JSON object.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch (error) {
    throw new Error(`The model's JSON could not be parsed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseIntent(parsed);
}

/**
 * Turn a validated intent into a real configuration: the optimizer assigns every signal,
 * plain GPIO functions are added as-is, then the validator reports any residual problem.
 */
export function planFromIntent(intent: IntentSpec, chip: string, context: PlanContext = {}): IntentPlan {
  const device = getDevice(chip);
  const dropped: string[] = [];
  const requests: PeripheralRequest[] = [];
  const seen = new Set<string>();

  for (const entry of intent.peripherals ?? []) {
    const owner = `${entry.type}${entry.instance}`;
    const spec = definition(entry.type, entry.instance, chip);
    if (!spec) { dropped.push(`${owner}: not available on ${chip}.`); continue; }
    if (seen.has(`${entry.type}:${entry.instance}`)) { dropped.push(`${owner}: requested more than once.`); continue; }
    seen.add(`${entry.type}:${entry.instance}`);
    let signals = entry.signals;
    if (signals) {
      const filtered: string[] = [];
      for (const id of signals) {
        if (spec.signals.some(signal => signal.id === id)) filtered.push(id);
        else dropped.push(`${owner}.${id}: no such signal on ${chip}.`);
      }
      signals = filtered;
    }
    requests.push({ type: entry.type, instance: entry.instance, ...(signals ? { signals } : {}) });
  }

  const pins: PinIntent[] = [];
  const pinGpios: number[] = [];
  for (const entry of intent.pinFunctions ?? []) {
    if (!device?.pins.some(pin => pin.gpio === entry.gpio)) { dropped.push(`GPIO${entry.gpio}: does not exist on ${chip}.`); continue; }
    if (pinGpios.includes(entry.gpio)) { dropped.push(`GPIO${entry.gpio}: assigned more than once.`); continue; }
    pinGpios.push(entry.gpio);
    pins.push(entry);
  }

  let config = createConfig(chip);
  let score = 0;
  const warnings: string[] = [];
  const occupied = [...(context.occupied ?? []), ...pinGpios];

  if (requests.length) {
    const [plan] = recommendAssignment(requests, {
      avoidStrapping: intent.avoidStrapping ?? true,
      avoidReserved: true,
      preferBoardDefaults: true,
      maxPlans: 1
    }, chip, { board: context.board, occupied, pinned: context.pinned });
    if (plan) {
      score = plan.score;
      warnings.push(...plan.warnings);
      for (const [owner, peripheral] of Object.entries(plan.peripherals)) {
        config = addPeripheral(config, peripheral.type, peripheral.instance);
        for (const [id, reference] of Object.entries(peripheral.signals)) {
          config = setSignal(config, owner, id, Number(reference.slice(4)));
        }
      }
    } else {
      dropped.push("No complete pin set could be found; the requested signals were left unassigned.");
      for (const request of requests) {
        if (definition(request.type, request.instance, chip)) config = addPeripheral(config, request.type, request.instance);
      }
    }
  }
  for (const pin of pins) config = setPin(config, pin.gpio, pin.function);

  const problems = validateGpio(config, undefined, context.settings ?? {});
  return { config, score, warnings, dropped, problems };
}

/** Compact human-readable list of what a configuration wires. */
export function summarizeConfig(config: PinConfigDocument): string[] {
  const lines: string[] = [];
  for (const [owner, peripheral] of Object.entries(config.peripherals ?? {})) {
    const routes = Object.entries(peripheral.signals).map(([id, gpio]) => `${id}=${gpio}`).join(" ");
    lines.push(`${owner} (${peripheral.type}:${peripheral.instance}) ${routes || "— no signal assigned"}`);
  }
  if (config.pins.length) {
    lines.push(`plain GPIO: ${config.pins.map(pin => `GPIO${pin.gpio}=${pin.function}`).join(", ")}`);
  }
  return lines;
}

/** Recover the intent of an existing configuration — the base the model is asked to edit. */
export function intentFromConfig(config: PinConfigDocument): IntentSpec {
  const peripherals: PeripheralIntent[] = [];
  for (const peripheral of Object.values(config.peripherals ?? {})) {
    const signals = Object.keys(peripheral.signals);
    peripherals.push({ type: peripheral.type, instance: peripheral.instance, ...(signals.length ? { signals } : {}) });
  }
  const pinFunctions: PinIntent[] = [];
  for (const pin of config.pins) {
    if ((gpioFunctions as readonly string[]).includes(pin.function)) pinFunctions.push({ gpio: pin.gpio, function: pin.function as GpioFunction });
  }
  return {
    chip: config.target.chip,
    ...(peripherals.length ? { peripherals } : {}),
    ...(pinFunctions.length ? { pinFunctions } : {})
  };
}

/**
 * Minimal-change repair: keep every assignment the validator did not flag as an error
 * pinned to its current GPIO, and treat the unproblematic plain pins as occupied, so the
 * re-solve only re-routes what actually broke.
 */
export function deriveRepairContext(config: PinConfigDocument, problems: Problem[]): RepairContext {
  const brokenSignals = new Set<string>();
  const brokenOwners = new Set<string>();
  const occupied = config.pins.map(pin => pin.gpio);
  for (const problem of problems) {
    if (problem.severity !== "error" || !problem.owner) continue;
    const path = problem.path ?? [];
    if (path[0] === "peripherals" && path[2] === "signals" && typeof path[3] === "string") {
      brokenSignals.add(`${problem.owner}.${path[3]}`);
    } else {
      brokenOwners.add(problem.owner);
    }
  }
  const pinned: Record<string, number> = {};
  for (const [owner, peripheral] of Object.entries(config.peripherals ?? {})) {
    if (brokenOwners.has(owner)) continue;
    for (const [id, value] of Object.entries(peripheral.signals)) {
      const gpio = gpioNumber(value);
      if (gpio !== undefined && !brokenSignals.has(`${owner}.${id}`)) pinned[`${owner}.${id}`] = gpio;
    }
  }
  return { pinned, occupied };
}
