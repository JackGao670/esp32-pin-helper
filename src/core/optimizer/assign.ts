// Phase 3 pin auto-assignment optimizer (§3.1 / §3.2).
//
// Model: the decision variables are the GPIO choice for every requested signal.
// Constraints: no two signals may share a GPIO (conflict), each signal must be
// routed to a direction/capability-legal GPIO (reuses the resolver's candidates()),
// and — per user preference — strapping / memory / board-reserved pins are avoided.
// Objective: minimise residual warnings (prefer non-strapping, non-reserved,
// board-default and low GPIO numbers) and return the Top N plans by score.
//
// The search is a most-constrained-first greedy DFS with backtracking: it walks
// slots in ascending candidate-count order and backtracks when a GPIO is taken,
// collecting several complete plans so the caller can present alternatives.
//
// The core stays free of board-loader dependencies: callers pass light `BoardHints`
// built from either a BoardProfile (host) or BoardInfo (WebView).

import { candidates, definition, type SignalDefinition } from "../resolver/peripherals";
import { getDevice, type PinDefinition } from "../../database/loader";
import type { BoardProfile } from "../model/boards";

export interface PeripheralRequest {
  type: string;
  instance: number;
  /** Signal ids to assign. Defaults to the definition's required signals. */
  signals?: string[];
}

/** Board-level hints used to bias the search. Shape-compatible with BoardInfo. */
export interface BoardHints {
  name?: string;
  /** GPIOs that must not be reused (pure board features like an RGB LED). */
  reservedGpios?: number[];
  /** owner → signal → "GPIO<n>" default routes recommended by the board. */
  defaultRoutes?: Record<string, Record<string, string>>;
  /** Board-wired pins (USB-UART bridge, SD slot, Ethernet PHY…) — reusable but at a cost. */
  onboardPins?: { gpio: number; usage: string }[];
}

export function boardHintsFromProfile(board: BoardProfile): BoardHints {
  return {
    name: board.name,
    reservedGpios: board.reservedGpios,
    defaultRoutes: board.peripherals,
    onboardPins: board.onboardPins
  };
}

export interface OptimizerPreferences {
  /** Penalise strapping (boot-mode) pins so they are only used as a last resort. Default true. */
  avoidStrapping?: boolean;
  /** Penalise pins usually reserved for Flash/PSRAM or the USB Serial/JTAG console. Default true. */
  avoidReserved?: boolean;
  /** Hard-exclude GPIOs reserved by the board profile (unless nothing else is left). Default true. */
  avoidBoardReserved?: boolean;
  /** Bonus for a GPIO that is the board's default route for this owner.signal. Default true. */
  preferBoardDefaults?: boolean;
  /** Break ties towards lower GPIO numbers for readable, stable output. Default true. */
  preferLowGpio?: boolean;
  /** Maximum number of ranked plans to return. Default 3. */
  maxPlans?: number;
}

export interface PlanPeripheral {
  type: string;
  instance: number;
  /** signal id → "GPIO<n>" */
  signals: Record<string, string>;
}

export interface AssignmentPlan {
  /** owner (type+instance) → assignment */
  peripherals: Record<string, PlanPeripheral>;
  /** Higher is better. */
  score: number;
  /** Human-readable notes for the non-ideal choices this plan had to make. */
  warnings: string[];
}

export interface RecommendContext {
  /** GPIOs already used elsewhere (existing pins/peripherals) that must not be reused. */
  occupied?: number[];
  /** Active board hints; enables board-default preference and reserved-pin exclusion. */
  board?: BoardHints;
}

interface Slot {
  owner: string;
  type: string;
  instance: number;
  signal: SignalDefinition;
}

interface Choice {
  owner: string;
  type: string;
  instance: number;
  id: string;
  gpio: number;
  warnings: string[];
}

const PIN_SCORE = {
  boardDefault: 50,
  strapping: -100,
  memory: -100,
  octal: -80,
  usbJtag: -30,
  boardOnboard: -60
} as const;
const LOW_GPIO_WEIGHT = 0.5;
const MAX_CANDIDATES_PER_SLOT = 16;
const LEAF_FACTOR = 6;
const MAX_NODES = 200_000;

// Score a single (slot → gpio) choice. Capability legality is guaranteed upstream by
// candidates(); this only layers the soft preferences on top.
function scoreChoice(slot: Slot, gpio: number, board: BoardHints | undefined,
                     prefs: Required<OptimizerPreferences>, pin: PinDefinition | undefined): { score: number; warnings: string[] } {
  if (!pin) return { score: Number.NEGATIVE_INFINITY, warnings: [] };
  const warnings: string[] = [];
  const route = board?.defaultRoutes?.[slot.owner]?.[slot.signal.id];
  const isDefault = route === `GPIO${gpio}`;
  let score = 0;
  if (prefs.preferBoardDefaults && isDefault) score += PIN_SCORE.boardDefault;
  if (prefs.avoidStrapping && pin.restrictions.some(text => /Strapping pin/.test(text))) {
    score += PIN_SCORE.strapping;
    warnings.push(`GPIO${gpio} is a strapping pin; boot mode may depend on its level.`);
  }
  if (prefs.avoidReserved) {
    if (pin.restrictions.some(text => /Usually used by Flash\/PSRAM/.test(text))) {
      score += PIN_SCORE.memory;
      warnings.push(`GPIO${gpio} is usually used by Flash/PSRAM.`);
    } else if (pin.restrictions.some(text => /Reserved when Octal/.test(text))) {
      score += PIN_SCORE.octal;
      warnings.push(`GPIO${gpio} is reserved when Octal Flash/PSRAM is used.`);
    }
    if (pin.restrictions.some(text => /USB Serial\/JTAG/.test(text))) score += PIN_SCORE.usbJtag;
  }
  if (board && prefs.preferBoardDefaults) {
    const usage = board.onboardPins?.find(entry => entry.gpio === gpio)?.usage;
    if (usage && !isDefault) {
      score += PIN_SCORE.boardOnboard;
      warnings.push(`GPIO${gpio} is wired to the ${usage} on ${board.name}.`);
    }
  }
  if (prefs.preferLowGpio) score -= gpio * LOW_GPIO_WEIGHT;
  return { score, warnings };
}

// Candidate GPIOs for a slot, best-scored first. Board-reserved pins are excluded
// when a board is active, falling back to the full set only if nothing else remains.
// `cap` bounds the branching factor; it is widened for slot-heavy builds because every
// slot prefers the same low GPIOs, so a fixed cap would starve the search (see caller).
function orderedCandidates(slot: Slot, chip: string, board: BoardHints | undefined,
                           occupied: Set<number>, prefs: Required<OptimizerPreferences>,
                           pins: Map<number, PinDefinition>, cap: number): number[] {
  const all = candidates(slot.signal, chip, slot.instance).filter(gpio => !occupied.has(gpio));
  const reserved = new Set(board?.reservedGpios ?? []);
  const preferred = prefs.avoidBoardReserved && board ? all.filter(gpio => !reserved.has(gpio)) : all;
  const pool = preferred.length ? preferred : all;
  return pool
    .map(gpio => ({ gpio, score: scoreChoice(slot, gpio, board, prefs, pins.get(gpio)).score }))
    .sort((a, b) => b.score - a.score || a.gpio - b.gpio)
    .slice(0, cap)
    .map(entry => entry.gpio);
}

function signature(plan: AssignmentPlan): string {
  return Object.entries(plan.peripherals)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([owner, peripheral]) => {
      const signals = Object.entries(peripheral.signals).sort(([a], [b]) => a.localeCompare(b))
        .map(([id, gpio]) => `${id}=${gpio}`).join(",");
      return `${owner}:${signals}`;
    })
    .join("|");
}

function gpioSum(plan: AssignmentPlan): number {
  return Object.values(plan.peripherals).reduce((total, peripheral) =>
    total + Object.values(peripheral.signals).reduce((sum, ref) => sum + Number(ref.slice(4)), 0), 0);
}

export function recommendAssignment(peripherals: PeripheralRequest[],
                                    preferences: OptimizerPreferences = {},
                                    chip = "esp32s3",
                                    context: RecommendContext = {}): AssignmentPlan[] {
  const prefs: Required<OptimizerPreferences> = {
    avoidStrapping: true, avoidReserved: true, avoidBoardReserved: true,
    preferBoardDefaults: true, preferLowGpio: true, maxPlans: 3, ...preferences
  };
  const device = getDevice(chip);
  if (!device) return [];
  const board = context.board;
  const pins = new Map<number, PinDefinition>(device.pins.map(pin => [pin.gpio, pin]));
  const occupied = new Set(context.occupied ?? []);
  const notes: string[] = [];

  const slots: Slot[] = [];
  const seen = new Set<string>();
  for (const request of peripherals) {
    const owner = `${request.type}${request.instance}`;
    const spec = definition(request.type, request.instance, chip);
    if (!spec) {
      notes.push(`${owner}: unsupported peripheral instance on ${chip}; skipped.`);
      continue;
    }
    if (seen.has(`${request.type}:${request.instance}`)) {
      notes.push(`${owner}: requested more than once; duplicate skipped.`);
      continue;
    }
    seen.add(`${request.type}:${request.instance}`);
    const wanted = request.signals ?? spec.signals.filter(signal => signal.required).map(signal => signal.id);
    for (const id of wanted) {
      const signal = spec.signals.find(item => item.id === id);
      if (!signal) {
        notes.push(`${owner}.${id}: no such signal on ${chip}; skipped.`);
        continue;
      }
      slots.push({ owner, type: request.type, instance: request.instance, signal });
    }
  }
  if (slots.length === 0) return [];

  const candidatesBySlot = new Map<Slot, number[]>();
  // Keep at least as many candidates per slot as there are slots: without room to spread
  // out, slot-heavy builds (e.g. a 22-signal Camera + 8080 LCD) cannot fit on one chip.
  const candidateCap = Math.max(MAX_CANDIDATES_PER_SLOT, slots.length * 2);
  for (const slot of slots) candidatesBySlot.set(slot, orderedCandidates(slot, chip, board, occupied, prefs, pins, candidateCap));
  const ordered = [...slots].sort((a, b) => candidatesBySlot.get(a)!.length - candidatesBySlot.get(b)!.length);

  const leafCap = Math.max(prefs.maxPlans, 1) * LEAF_FACTOR;
  const plans: AssignmentPlan[] = [];
  const used = new Set<number>(occupied);
  const chosen: Choice[] = [];
  let nodes = 0;

  const finalize = (score: number): AssignmentPlan => {
    const mapped: Record<string, PlanPeripheral> = {};
    const warnings = [...notes];
    for (const choice of chosen) {
      const entry = mapped[choice.owner] ?? (mapped[choice.owner] = { type: choice.type, instance: choice.instance, signals: {} });
      entry.signals[choice.id] = `GPIO${choice.gpio}`;
      warnings.push(...choice.warnings);
    }
    return { peripherals: mapped, score, warnings };
  };

  const dfs = (index: number, score: number): void => {
    if (nodes++ > MAX_NODES || plans.length >= leafCap) return;
    if (index === ordered.length) {
      plans.push(finalize(score));
      return;
    }
    const slot = ordered[index];
    for (const gpio of candidatesBySlot.get(slot)!) {
      if (used.has(gpio)) continue;
      const { score: pinScore, warnings } = scoreChoice(slot, gpio, board, prefs, pins.get(gpio));
      used.add(gpio);
      chosen.push({ owner: slot.owner, type: slot.type, instance: slot.instance, id: slot.signal.id, gpio, warnings });
      dfs(index + 1, score + pinScore);
      chosen.pop();
      used.delete(gpio);
      if (nodes > MAX_NODES || plans.length >= leafCap) return;
    }
  };
  dfs(0, 0);

  const unique: AssignmentPlan[] = [];
  for (const plan of plans) {
    if (!unique.some(existing => signature(existing) === signature(plan))) unique.push(plan);
  }
  unique.sort((a, b) => b.score - a.score || gpioSum(a) - gpioSum(b));
  return unique.slice(0, Math.max(prefs.maxPlans, 1));
}
