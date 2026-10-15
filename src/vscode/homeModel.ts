/**
 * Activity Bar home view: the data model and HTML are pure functions so they can be
 * unit-tested without a VS Code host (see test/homeModel.test.ts). The provider that
 * wires them to a WebviewView lives in homeView.ts.
 */

import { parseConfig, type PinConfigDocument } from "../core/model/config";
import { validateGpio } from "../core/validator/gpio";
import { getDevice } from "../database/loader";
import { resolveBoardFromSettings } from "../database/boardLoader";
import type { TargetChip } from "../core/model/project";
import type { PlannerSettings } from "../config/userSettings";
import { defaultTranslate, translator, type Language, type Translate } from "../i18n/messages";

export type HomeStatus = "no-folder" | "no-file" | "invalid" | "ready";

export interface HomeInput {
  /** Workspace folder name, undefined when no folder is open. */
  folderName: string | undefined;
  /** Raw .pinconfig.json text, undefined when the file does not exist. */
  raw: string | undefined;
  settings: PlannerSettings;
}

export interface HomeModel {
  status: HomeStatus;
  folderName?: string;
  chip?: string;
  chipName?: string;
  supported?: boolean;
  boardName?: string;
  errors: number;
  warnings: number;
  parseError?: string;
}

function isTargetChip(value: string): value is TargetChip {
  return value === "esp32s3" || value === "esp32c6" || value === "esp32p4" || value === "esp32c3" || value === "esp32c2";
}

export function buildHomeModel(input: HomeInput): HomeModel {
  if (input.folderName === undefined) return { status: "no-folder", errors: 0, warnings: 0 };
  if (input.raw === undefined) return { status: "no-file", folderName: input.folderName, errors: 0, warnings: 0 };
  let config: PinConfigDocument;
  try {
    config = parseConfig(input.raw);
  } catch (error) {
    return { status: "invalid", folderName: input.folderName, errors: 0, warnings: 0,
      parseError: error instanceof Error ? error.message : String(error) };
  }
  const chip = config.target.chip;
  const device = getDevice(chip);
  const problems = validateGpio(config, undefined, input.settings);
  const board = isTargetChip(chip) ? resolveBoardFromSettings(input.settings.board, chip) : undefined;
  return {
    status: "ready",
    folderName: input.folderName,
    chip,
    chipName: device?.name ?? chip,
    supported: Boolean(device),
    ...(board ? { boardName: board.name } : {}),
    errors: problems.filter(problem => problem.severity === "error").length,
    warnings: problems.filter(problem => problem.severity === "warning").length
  };
}

export interface HomeRenderOptions {
  nonce: string;
  /** Interface language; defaults to English so existing callers keep working. */
  language?: Language;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, char => char === "&" ? "&amp;" : char === "<" ? "&lt;" : char === ">" ? "&gt;" : "&quot;");
}

function action(command: string, label: string, kind: "primary" | "secondary"): string {
  return `<a class="btn ${kind}" href="command:${command}">${escapeHtml(label)}</a>`;
}

/** Static HTML with no scripts: `command:` links need enableCommandUris on the webview. */
export function renderHomeHtml(model: HomeModel, options: HomeRenderOptions): string {
  const t: Translate = options.language ? translator(options.language) : defaultTranslate;
  const actions: string[] = [];
  const rows: string[] = [];
  let subtitle = "";

  if (model.status === "no-folder") {
    subtitle = t("home.subtitleNoFolder");
    actions.push(action("espPinPlanner.open", t("command.open"), "primary"));
  } else if (model.status === "no-file") {
    subtitle = t("home.subtitleNoFile", { folder: escapeHtml(model.folderName!) });
    actions.push(action("espPinPlanner.create", t("command.create"), "primary"));
    actions.push(action("espPinPlanner.open", t("command.open"), "secondary"));
  } else if (model.status === "invalid") {
    subtitle = t("home.subtitleInvalid", { folder: escapeHtml(model.folderName!) });
    rows.push(`<dt>${t("home.rowProblem")}</dt><dd class="err">${escapeHtml(model.parseError ?? "Invalid JSON.")}</dd>`);
    actions.push(action("espPinPlanner.open", t("command.open"), "primary"));
    actions.push(action("espPinPlanner.validate", t("command.validate"), "secondary"));
  } else {
    subtitle = `${escapeHtml(model.chipName ?? model.chip ?? "")}${model.supported ? "" : t("home.subtitleUnsupported")}`;
    rows.push(`<dt>${t("home.rowChip")}</dt><dd>${escapeHtml(model.chip ?? "")}</dd>`);
    if (model.boardName) rows.push(`<dt>${t("home.rowBoard")}</dt><dd>${escapeHtml(model.boardName)}</dd>`);
    rows.push(`<dt>${t("problems.title")}</dt><dd><span class="${model.errors ? "err" : "ok"}">${t("home.errors", { count: model.errors })}</span> · `
      + `<span class="${model.warnings ? "warn" : "ok"}">${t("home.warnings", { count: model.warnings })}</span></dd>`);
    actions.push(action("espPinPlanner.open", t("command.open"), "primary"));
    actions.push(action("espPinPlanner.validate", t("command.validate"), "secondary"));
    actions.push(action("espPinPlanner.selectTarget", t("command.selectTarget"), "secondary"));
  }

  return `<!doctype html><html lang="${options.language ?? "en"}"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${options.nonce}';">
<style nonce="${options.nonce}">
body { font-family: var(--vscode-font-family); font-size: 12px; color: var(--vscode-foreground); padding: 8px 12px 12px; }
h1 { font-size: 12px; font-weight: 600; margin: 0 0 4px; }
.sub { color: var(--vscode-descriptionForeground); margin: 0 0 10px; }
.actions { display: flex; flex-direction: column; gap: 4px; }
a.btn { display: block; text-align: center; padding: 4px 8px; border-radius: 2px; text-decoration: none; }
a.btn.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
a.btn.primary:hover { background: var(--vscode-button-hoverBackground); }
a.btn.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
a.btn.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
dl { display: grid; grid-template-columns: auto 1fr; gap: 2px 8px; margin: 12px 0 0; }
dt { color: var(--vscode-descriptionForeground); }
dd { margin: 0; overflow-wrap: anywhere; }
.err { color: var(--vscode-editorError-foreground); }
.warn { color: var(--vscode-editorWarning-foreground); }
.ok { color: var(--vscode-charts-green); }
</style></head><body><main>
<h1>ESP Pin Planner</h1>
<p class="sub">${subtitle}</p>
<div class="actions">${actions.join("")}</div>
${rows.length ? `<dl>${rows.join("")}</dl>` : ""}
</main></body></html>`;
}
