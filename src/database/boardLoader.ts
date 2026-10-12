import s3Devkitc1 from "../../boards/espressif/esp32-s3-devkitc-1.json";
import c6Devkitc1 from "../../boards/espressif/esp32-c6-devkitc-1.json";
import c6Devkitm1 from "../../boards/espressif/esp32-c6-devkitm-1.json";
import p4FunctionEvBoard from "../../boards/espressif/esp32-p4-function-ev-board.json";

import type { BoardProfile } from "../core/model/boards";
import type { TargetChip } from "../core/model/project";
import type { BoardSetting } from "../config/userSettings";

function loadBoard(raw: unknown): BoardProfile {
  const b = raw as Partial<BoardProfile> & { pins?: unknown; reservedGpios?: unknown; peripherals?: unknown; powerDomain?: unknown; source?: unknown; onboardPins?: unknown; default?: unknown };
  if (!b.id || typeof b.id !== "string") throw new Error("Invalid board: missing string id");
  if (!b.name || typeof b.name !== "string") throw new Error(`Invalid board ${b.id}: missing name`);
  if (!b.vendor || typeof b.vendor !== "string") throw new Error(`Invalid board ${b.id}: missing vendor`);
  if (!b.targetChip || !isChipOk(b.targetChip))
    throw new Error(`Invalid board ${b.id}: targetChip not in {esp32s3,esp32c6,esp32p4}`);
  if (!b.source || typeof b.source !== "object" || !b.source)
    throw new Error(`Invalid board ${b.id}: missing source object`);
  const s = b.source as { document?: unknown; version?: unknown; url?: unknown };
  if (!s.document || !s.version || !s.url || typeof s.document !== "string" || typeof s.version !== "string" || typeof s.url !== "string")
    throw new Error(`Invalid board ${b.id}: source.document/version/url must be non-empty strings`);
  if (!Array.isArray(b.pins)) throw new Error(`Invalid board ${b.id}: pins must be array`);
  const pins = b.pins.map((p: unknown, idx: number) => {
    const ov = p as { gpio?: unknown; label?: unknown; reserved?: unknown; strapDirection?: unknown };
    if (!Number.isInteger(ov.gpio) || (ov.gpio as number) < 0)
      throw new Error(`Invalid board ${b.id}: pins[${idx}] integer gpio`);
    if (!ov.label || typeof ov.label !== "string")
      throw new Error(`Invalid board ${b.id}: pins[${idx}] string label`);
    if (ov.reserved !== undefined && typeof ov.reserved !== "boolean")
      throw new Error(`Invalid board ${b.id}: pins[${idx}] reserved must be bool`);
    if (ov.strapDirection !== undefined && !["pull-up","pull-down","floating"].includes(ov.strapDirection as string))
      throw new Error(`Invalid board ${b.id}: pins[${idx}] strapDirection enum`);
    return { gpio: ov.gpio as number, label: ov.label as string, ...(ov.reserved === undefined ? {} : { reserved: ov.reserved }), ...(ov.strapDirection ? { strapDirection: ov.strapDirection as "pull-up"|"pull-down"|"floating" } : {}) };
  });
  if (!Array.isArray(b.reservedGpios) || !b.reservedGpios.every(n => Number.isInteger(n) && n >= 0))
    throw new Error(`Invalid board ${b.id}: reservedGpios must be array of non-negative ints`);
  const extra = pins.filter(p => p.reserved).map(p => p.gpio).filter(g => !(b.reservedGpios as number[]).includes(g));
  const reservedGpios = Array.from(new Set([...(b.reservedGpios as number[]), ...extra])).sort((a, x) => a - x);
  if (!b.peripherals || typeof b.peripherals !== "object" || Array.isArray(b.peripherals))
    throw new Error(`Invalid board ${b.id}: peripherals must be object`);
  const peripherals: BoardProfile["peripherals"] = {};
  for (const owner of Object.keys(b.peripherals as Record<string, unknown>)) {
    const sm = (b.peripherals as Record<string, unknown>)[owner];
    if (!sm || typeof sm !== "object" || Array.isArray(sm))
      throw new Error(`Invalid board ${b.id}: peripherals.${owner} must be signal:gpio map object`);
    peripherals[owner] = {};
    for (const sig of Object.keys(sm as Record<string, unknown>)) {
      const gpio = (sm as Record<string, unknown>)[sig];
      if (typeof gpio !== "string" || !/^GPIO\d+$/.test(gpio))
        throw new Error(`Invalid board ${b.id}: peripherals.${owner}.${sig} must be ^GPIO\\d+$ string`);
      peripherals[owner][sig] = gpio;
    }
  }
  const out: BoardProfile = {
    id: b.id,
    name: b.name,
    vendor: b.vendor,
    targetChip: b.targetChip,
    source: { document: s.document, version: s.version, url: s.url },
    pins,
    reservedGpios,
    peripherals
  };
  if (b.package !== undefined) out.package = String(b.package);
  if (b.boardPcbVersion !== undefined) out.boardPcbVersion = String(b.boardPcbVersion);
  if (b.default !== undefined) {
    if (typeof b.default !== "boolean") throw new Error(`Invalid board ${b.id}: default must be bool`);
    out.default = b.default;
  }
  if (b.onboardPins !== undefined) {
    if (!Array.isArray(b.onboardPins)) throw new Error(`Invalid board ${b.id}: onboardPins must be array`);
    out.onboardPins = (b.onboardPins as unknown[]).map((entry, idx) => {
      const o = entry as { gpio?: unknown; usage?: unknown };
      if (!Number.isInteger(o.gpio) || (o.gpio as number) < 0)
        throw new Error(`Invalid board ${b.id}: onboardPins[${idx}] integer gpio`);
      if (!o.usage || typeof o.usage !== "string")
        throw new Error(`Invalid board ${b.id}: onboardPins[${idx}] non-empty usage string`);
      return { gpio: o.gpio as number, usage: o.usage as string };
    });
  }
  if (b.notes !== undefined) {
    if (!Array.isArray(b.notes) || !(b.notes as unknown[]).every(n => typeof n === "string"))
      throw new Error(`Invalid board ${b.id}: notes string array`);
    out.notes = b.notes as string[];
  }
  if (b.powerDomain !== undefined) {
    const pd = b.powerDomain as { default?: unknown; perGpio?: unknown };
    if (pd.default) out.powerDomain = { default: pd.default as BoardProfile["powerDomain"] extends infer T ? T extends { default: infer D } ? D : never : never };
    if (pd.perGpio !== undefined) {
      if (typeof pd.perGpio !== "object" || pd.perGpio === null || Array.isArray(pd.perGpio))
        throw new Error(`Invalid board ${b.id}: powerDomain.perGpio object`);
      out.powerDomain ??= { default: "VDD33" };
      const pg: Record<number, unknown> = {};
      for (const k of Object.keys(pd.perGpio as Record<string, unknown>)) {
        const n = Number(k);
        if (!Number.isInteger(n) || n < 0) throw new Error(`Invalid board ${b.id}: powerDomain.perGpio key integer gpio`);
        pg[n] = (pd.perGpio as Record<string, unknown>)[k];
      }
      (out.powerDomain as unknown as { perGpio: typeof pg }).perGpio = pg as any;
    }
  }
  return out;
}

function isChipOk(v: unknown): v is TargetChip {
  return v === "esp32s3" || v === "esp32c6" || v === "esp32p4";
}

export const boards: BoardProfile[] = [loadBoard(s3Devkitc1), loadBoard(c6Devkitc1), loadBoard(c6Devkitm1), loadBoard(p4FunctionEvBoard)];

export function listBoardProfiles(chip?: TargetChip): BoardProfile[] {
  return chip ? boards.filter(b => b.targetChip === chip) : boards;
}

export function getBoardProfile(vendor: string, id: string): BoardProfile | undefined {
  return boards.find(b => b.vendor === vendor && b.id === id);
}

export function getBoardPinLabel(board: BoardProfile, gpio: number): string {
  const p = board.pins.find(x => x.gpio === gpio);
  return p?.label ?? `GPIO${gpio}`;
}

export function isBoardReserved(board: BoardProfile, gpio: number): boolean {
  return board.reservedGpios.includes(gpio);
}

export function getBoardOnboardUsage(board: BoardProfile, gpio: number): string | undefined {
  return board.onboardPins?.find(pin => pin.gpio === gpio)?.usage;
}

// 该 GPIO 在此板的推荐默认接线（"owner.signal" 列表）。用于把"就是板载默认接线"与"被别的外设占用"区分开。
export function getBoardDefaultRoutes(board: BoardProfile, gpio: number): string[] {
  const routes: string[] = [];
  for (const [owner, signals] of Object.entries(board.peripherals)) {
    for (const [signal, value] of Object.entries(signals)) {
      if (value === `GPIO${gpio}`) routes.push(`${owner}.${signal}`);
    }
  }
  return routes;
}

// auto 解析的候选挑选规则：唯一候选直接用；多候选时只认数据里显式声明的唯一参考板（default=true），
// 否则返回 undefined —— 宁可退化为"不使用 board 特性"，也不替用户猜板子。
export function pickAutoBoard(candidates: BoardProfile[]): BoardProfile | undefined {
  if (candidates.length === 1) return candidates[0];
  const preferred = candidates.filter(b => b.default === true);
  return preferred.length === 1 ? preferred[0] : undefined;
}

export function resolveBoardFromSettings(setting: BoardSetting, targetChip: TargetChip): BoardProfile | undefined {
  if (setting.preset === "none") return undefined;
  if (setting.preset === "byId") {
    const b = getBoardProfile(setting.vendor.toLowerCase(), setting.board.toLowerCase());
    if (b && b.targetChip === targetChip) return b;
    return undefined; // mismatch target chip or not found → silent fallback to no-board
  }
  // auto
  return pickAutoBoard(listBoardProfiles(targetChip));
}

import type { BoardInfo } from "../core/model/messages";

export function boardInfoOf(board: BoardProfile): BoardInfo {
  const labelMap: Record<string, string> = {};
  for (const p of board.pins) labelMap[String(p.gpio)] = p.label;
  const defaultSignalMap: Record<string, Record<string, string>> = {};
  for (const [owner, signals] of Object.entries(board.peripherals)) defaultSignalMap[owner] = { ...signals };
  return {
    vendor: board.vendor,
    id: board.id,
    name: board.name,
    labelMap,
    reservedGpios: [...board.reservedGpios],
    defaultSignalMap,
    ...(board.onboardPins ? { onboardPins: board.onboardPins.map(pin => ({ ...pin })) } : {})
  };
}
