import type { BoardInfo } from "../../src/core/model/messages";
import { definition } from "../../src/core/resolver/peripherals";

/** Board default-signal-map owner keys use the `<type><instance>` convention (e.g. "spi2", "lcd_mipi0").
 *  The type may itself contain digits, so allow them after the leading letter ("i2c0", "i2s0"). */
export function parseOwner(owner: string): { type: string; instance: number } | undefined {
  const match = owner.match(/^([a-z][a-z0-9_]*?)(\d+)$/);
  if (!match) return undefined;
  return { type: match[1], instance: Number(match[2]) };
}

/** Why a recommended route is not "free": the pin is board-reserved, or wired to an on-board device. */
export interface BoardPinNote {
  gpio: number;
  kind: "reserved" | "onboard";
  note: string;
}

export interface BoardShortcut {
  owner: string;
  type: string;
  instance: number;
  signals: Record<string, string>;
  /** Board-level pins this route occupies, so the panel can flag the trade-off before applying. */
  boardPins: BoardPinNote[];
}

/** Board pins carrying board-level meaning. Reserved wins over onboard: it is the stricter "do not reuse" pin. */
export function boardPinNotes(board: BoardInfo | undefined, gpios: number[]): BoardPinNote[] {
  if (!board) return [];
  const reserved = new Set(board.reservedGpios);
  const onboard = new Map((board.onboardPins ?? []).map(pin => [pin.gpio, pin.usage]));
  const notes: BoardPinNote[] = [];
  for (const gpio of gpios) {
    if (reserved.has(gpio)) notes.push({ gpio, kind: "reserved", note: board.labelMap[String(gpio)] ?? `GPIO${gpio}` });
    else if (onboard.has(gpio)) notes.push({ gpio, kind: "onboard", note: onboard.get(gpio)! });
  }
  return notes;
}

/** Board default signal map: only expose owners whose every required signal is present,
 *  so a one-click apply never leaves a half-configured peripheral behind. */
export function boardShortcutsFor(board: BoardInfo | undefined, chip: string): BoardShortcut[] {
  const map = board?.defaultSignalMap;
  if (!map) return [];
  const out: BoardShortcut[] = [];
  for (const [owner, signals] of Object.entries(map)) {
    const parsed = parseOwner(owner);
    if (!parsed) continue;
    const def = definition(parsed.type, parsed.instance, chip);
    if (!def) continue;
    const required = def.signals.filter(signal => signal.required).map(signal => signal.id);
    if (!required.every(id => signals[id] !== undefined)) continue;
    const gpios = Object.values(signals).map(ref => Number(ref.slice(4))).filter(gpio => Number.isFinite(gpio));
    out.push({ owner, type: parsed.type, instance: parsed.instance, signals, boardPins: boardPinNotes(board, gpios) });
  }
  return out;
}
