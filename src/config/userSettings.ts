/**
 * User-visible settings declared under `contributes.configuration` in package.json.
 *
 * Read order:
 *  - In VS Code host: `vscode.workspace.getConfiguration('espPinPlanner').get(key)`.
 *  - In node unit tests or headless tools: injected explicit overrides → process.env
 *    fallbacks → static defaults.
 */

import type { TargetChip } from "../core/model/project";

export type RmtChannelBank = "tx" | "rx" | "auto";
export type BoardSetting =
  | { preset: "none" }
  | { preset: "auto" }
  | { preset: "byId"; vendor: string; board: string };

function boardEqual(a: BoardSetting | undefined, b: BoardSetting | undefined): boolean {
  if (!a || !b) return !a && !b;
  if (a.preset !== b.preset) return false;
  if (a.preset !== "byId" || b.preset !== "byId") return true;
  return a.vendor === b.vendor && a.board === b.board;
}

export interface PlannerSettings {
  defaultTarget: TargetChip;
  schemaStrictInstance: boolean;
  rmtChannelBank: RmtChannelBank;
  board: BoardSetting;
}

export const DEFAULT_SETTINGS: PlannerSettings = {
  defaultTarget: "esp32s3",
  schemaStrictInstance: true,
  rmtChannelBank: "auto",
  board: { preset: "auto" }
};

export function isTargetChip(value: unknown): value is TargetChip {
  return value === "esp32s3" || value === "esp32c6" || value === "esp32p4";
}

export function isRmtChannelBank(value: unknown): value is RmtChannelBank {
  return value === "tx" || value === "rx" || value === "auto";
}

export function isValidBoardSetting(value: unknown): value is BoardSetting {
  if (!value || typeof value !== "object") return false;
  const v = value as { preset?: unknown; vendor?: unknown; board?: unknown };
  if (v.preset === "none" || v.preset === "auto") return true;
  if (v.preset !== "byId") return false;
  return typeof v.vendor === "string" && v.vendor.length > 0
    && typeof v.board === "string" && v.board.length > 0;
}

function envOverride<K extends keyof PlannerSettings>(key: K): PlannerSettings[K] | undefined {
  const envName = key === "defaultTarget" ? "ESP_PP_DEFAULT_TARGET"
    : key === "schemaStrictInstance" ? "ESP_PP_SCHEMA_STRICT_INSTANCE"
    : key === "rmtChannelBank" ? "ESP_PP_RMT_CHANNEL_BANK"
    : "ESP_PP_BOARD";
  const raw = typeof process !== "undefined" && process.env ? process.env[envName] : undefined;
  if (raw === undefined || raw === "") return undefined;
  if (key === "schemaStrictInstance") {
    const lower = raw.trim().toLowerCase();
    if (lower === "1" || lower === "true" || lower === "on") return true as PlannerSettings[K];
    if (lower === "0" || lower === "false" || lower === "off") return false as PlannerSettings[K];
    return undefined;
  }
  if (key === "defaultTarget" && isTargetChip(raw.trim())) return raw.trim() as PlannerSettings[K];
  if (key === "rmtChannelBank" && isRmtChannelBank(raw.trim())) return raw.trim() as PlannerSettings[K];
  if (key === "board") {
    const trimmed = raw.trim();
    if (trimmed === "none" || trimmed === "auto") return { preset: trimmed } as PlannerSettings[K];
    const m = trimmed.match(/^([a-z0-9-]+)\/([a-z0-9-]+)$/i);
    if (m) return { preset: "byId", vendor: m[1].toLowerCase(), board: m[2].toLowerCase() } as PlannerSettings[K];
    return undefined;
  }
  return undefined;
}

/**
 * Read settings without VS Code (headless / node tests). Explicit overrides take precedence,
 * then environment variables, then static defaults.
 */
export function readHeadlessSettings(overrides: Partial<PlannerSettings> = {}): PlannerSettings {
  return {
    defaultTarget: overrides.defaultTarget ?? envOverride("defaultTarget") ?? DEFAULT_SETTINGS.defaultTarget,
    schemaStrictInstance: overrides.schemaStrictInstance ?? envOverride("schemaStrictInstance") ?? DEFAULT_SETTINGS.schemaStrictInstance,
    rmtChannelBank: overrides.rmtChannelBank ?? envOverride("rmtChannelBank") ?? DEFAULT_SETTINGS.rmtChannelBank,
    board: overrides.board ?? envOverride("board") ?? DEFAULT_SETTINGS.board
  };
}

/**
 * Read settings from the VS Code host, with optional overrides for tests.
 * Falls back to readHeadlessSettings when the VS Code API is not available or a
 * setting is missing.
 */
export function readSettings(overrides: Partial<PlannerSettings> = {},
                            vsCodeApi: { getConfiguration: (section: string) => { get: <T>(key: string) => T | undefined } } | undefined =
                              // eslint-disable-next-line @typescript-eslint/consistent-type-imports
                              (typeof require === "function" ? (() => {
                                try {
                                  // eslint-disable-next-line @typescript-eslint/no-var-requires
                                  const vscode = require("vscode") as typeof import("vscode");
                                  return vscode.workspace;
                                } catch {
                                  return undefined;
                                }
                              })() : undefined)): PlannerSettings {
  const headless = readHeadlessSettings(overrides);
  if (!vsCodeApi) return headless;
  const cfg = vsCodeApi.getConfiguration("espPinPlanner");
  const defaultTarget = cfg.get<TargetChip>("defaultTarget");
  const strict = cfg.get<boolean>("schemaStrictInstance");
  const bank = cfg.get<RmtChannelBank>("rmtChannelBank");
  const boardPreset = cfg.get<string>("board.preset");
  const byVendor = cfg.get<string>("board.vendor");
  const byBoard  = cfg.get<string>("board.id");
  let board: BoardSetting | undefined;
  if (boardPreset === "none" || boardPreset === "auto") board = { preset: boardPreset };
  else if (boardPreset === "byId" && typeof byVendor === "string" && typeof byBoard === "string")
    board = { preset: "byId", vendor: byVendor, board: byBoard };
  const boardVal = isValidBoardSetting(board) ? board : envOverride("board");
  return {
    defaultTarget: overrides.defaultTarget ?? (isTargetChip(defaultTarget) ? defaultTarget : envOverride("defaultTarget")) ?? headless.defaultTarget,
    schemaStrictInstance: overrides.schemaStrictInstance ?? (typeof strict === "boolean" ? strict : envOverride("schemaStrictInstance")) ?? headless.schemaStrictInstance,
    rmtChannelBank: overrides.rmtChannelBank ?? (isRmtChannelBank(bank) ? bank : envOverride("rmtChannelBank")) ?? headless.rmtChannelBank,
    board: overrides.board ?? boardVal ?? headless.board
  };
}
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _unused = boardEqual;

