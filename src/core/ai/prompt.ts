// Prompt construction for the AI intent layer (pure: no `vscode` import).
//
// The prompt deliberately constrains the model to the *intent* schema: it may say which
// peripherals and signals to wire, but it must not invent GPIO numbers. Every chip fact
// the model needs (legal peripheral instances and signal ids, pins to avoid) is injected
// here from the same databases the validator uses, so the model never has to guess.

import { devices, getDevice } from "../../database/loader";
import { getPeripherals } from "../resolver/peripherals";
import type { BoardHints } from "../optimizer/assign";
import type { IntentSpec } from "./intent";

export interface CatalogueEntry {
  type: string;
  instances: number[];
  required: string[];
  optional: string[];
}

/** What the model is allowed to request on a given chip. */
export function buildCatalogue(chip: string): CatalogueEntry[] {
  return getPeripherals(chip).map(peripheral => ({
    type: peripheral.type,
    instances: [...peripheral.instances],
    required: peripheral.signals.filter(signal => signal.required).map(signal => signal.id),
    optional: peripheral.signals.filter(signal => !signal.required).map(signal => signal.id)
  }));
}

export function supportedChips(): string[] {
  return devices.map(device => device.id);
}

/**
 * Best-effort chip detection from a natural-language request ("use the P4", "ESP32-C6", "on s3").
 * An explicit `esp32-<x>` spelling wins over a bare alias (`s3` / `c6` / `p4` / `c3` / `c2`).
 */
export function detectChip(text: string): string | undefined {
  if (!text) return undefined;
  const explicit = /\besp32[-\s]?(s3|c6|p4|c3|c2)\b/i.exec(text);
  if (explicit) return `esp32${explicit[1].toLowerCase()}`;
  const alias = /\b(s3|c6|p4|c3|c2)\b/i.exec(text);
  return alias ? `esp32${alias[1].toLowerCase()}` : undefined;
}

const RESTRICTIONS = {
  strapping: /Strapping pin/,
  memory: /Usually used by Flash\/PSRAM/,
  octal: /Reserved when Octal/,
  usbJtag: /USB Serial\/JTAG|Reconfiguration disables the default USB Serial/
} as const;

/** GPIOs the optimizer avoids by default, grouped by restriction kind. */
export function pinsToAvoid(chip: string): { strapping: number[]; memory: number[]; usbJtag: number[] } {
  const pins = getDevice(chip)?.pins ?? [];
  const pick = (pattern: RegExp) => pins.filter(pin => pin.restrictions.some(text => pattern.test(text))).map(pin => pin.gpio);
  return { strapping: pick(RESTRICTIONS.strapping), memory: pick(RESTRICTIONS.memory), usbJtag: pick(RESTRICTIONS.usbJtag) };
}

export interface PromptContext {
  chip: string;
  board?: BoardHints;
}

const RULES = [
  "You configure ESP32 pin planning, not firmware. You never write GPIO numbers for peripheral signals",
  "and you never write C/C++ code: a deterministic optimizer assigns the pins and a validator checks them.",
  "Answer with a single JSON object and nothing else — no prose, no code fence required.",
  "Schema:",
  "{",
  '  "chip": one of the supported chip ids,',
  '  "avoidStrapping": boolean (default true — only set false if the user explicitly accepts strapping pins),',
  '  "peripherals": [{ "type": <type>, "instance": <number>, "signals": [<signal id>, ...] }],',
  '  "pinFunctions": [{ "gpio": <number>, "function": "GPIO_INPUT" | "GPIO_OUTPUT" | "GPIO_OPEN_DRAIN" }]',
  "}",
  "Rules:",
  "- Use only peripheral types/instances listed for the chip below.",
  "- `signals` is optional; omit it to wire the peripheral's required signals. Only list signal ids from the list.",
  "- Use `pinFunctions` only for plain GPIO pins the user explicitly named. Never use it to choose peripheral pins.",
  "- If a request cannot be expressed with the listed types/instances, pick the closest supported option.",
  "- Omit fields you do not need; keep the object as small as possible."
].join("\n");

/** Compact, factual description of one chip: peripheral catalogue + pins to avoid + board. */
export function describeChip(ctx: PromptContext): string {
  const { chip, board } = ctx;
  const catalogue = buildCatalogue(chip)
    .map(entry => `- ${entry.type} instances=[${entry.instances.join(",")}] required: ${entry.required.join(",") || "—"} optional: ${entry.optional.join(",") || "—"}`)
    .join("\n");
  const avoid = pinsToAvoid(chip);
  const avoidLine = [
    avoid.strapping.length ? `strapping ${avoid.strapping.join(",")}` : "",
    avoid.memory.length ? `flash/psram ${avoid.memory.join(",")}` : "",
    avoid.usbJtag.length ? `usb-jtag ${avoid.usbJtag.join(",")}` : ""
  ].filter(Boolean).join("; ") || "none";
  const boardLine = board
    ? `Board: ${board.name ?? "unknown"} — reserved pins that must not be reused: ${(board.reservedGpios ?? []).join(",") || "none"}.`
    : "Board: none configured.";
  return [
    `Supported chips: ${supportedChips().join(", ")}.`,
    `Target chip: ${chip}.`,
    `Peripheral catalogue for ${chip}:`,
    catalogue,
    `Pins the optimizer avoids by default — ${avoidLine}.`,
    boardLine
  ].join("\n");
}

/** Prompt for generating a fresh configuration from a natural-language request. */
export function generationPrompt(request: string, ctx: PromptContext): string {
  return [RULES, "", describeChip(ctx), "", `User request: ${request.trim()}`, "", "Return the JSON object."].join("\n");
}

/** Prompt for repairing an existing configuration: same schema, plus the current state and the errors. */
export function repairPrompt(request: string, ctx: PromptContext, current: IntentSpec, problems: string[]): string {
  const list = problems.length ? problems.map(problem => `- ${problem}`).join("\n") : "- (none)";
  return [
    RULES,
    "",
    describeChip(ctx),
    "",
    "Current specification (the intent behind the existing .pinconfig.json):",
    JSON.stringify(current, null, 2),
    "",
    "The validator reported these problems with the configuration produced from it:",
    list,
    "",
    `User request: ${request.trim() || "Fix the configuration."}`,
    "",
    "Return a corrected JSON object that keeps the user's intent but resolves every problem. Keep the same",
    "chip and the same peripheral instances unless a problem is about them; the host re-assigns the pins."
  ].join("\n");
}
