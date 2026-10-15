// AI assistant wiring (Phase 4 §6.2 tasks 4.3 / 4.4).
//
// Two features, one pipeline:
//   - Chat participant `@espPinPlanner <request>` (commands: /generate, /fix)
//   - "Ask AI to fix" — Problems quick fix and `espPinPlanner.fixWithAi` command.
//
// The model is only asked for *intent* (see core/ai): which peripherals, instances and
// signals to wire. The GPIO numbers always come from the deterministic optimizer and are
// re-checked by the validator before anything is written, so a hallucinated pin route can
// never reach `.pinconfig.json`.

import * as vscode from "vscode";
import { parseConfig, type PinConfigDocument } from "../core/model/config";
import {
  deriveRepairContext,
  extractIntentJson,
  intentFromConfig,
  planFromIntent,
  summarizeConfig,
  type IntentPlan,
  type IntentSpec
} from "../core/ai/intent";
import { detectChip, generationPrompt, repairPrompt } from "../core/ai/prompt";
import { boardHintsFromProfile, type BoardHints } from "../core/optimizer/assign";
import { resolveBoardFromSettings } from "../database/boardLoader";
import { getDevice } from "../database/loader";
import type { PlannerSettings } from "../config/userSettings";
import type { Problem } from "../core/validator/gpio";
import { diagnosticProblems } from "./diagnosticModel";

const PARTICIPANT_ID = "espPinPlanner";
const APPLY_COMMAND = "espPinPlanner.applyProposal";
const FIX_COMMAND = "espPinPlanner.fixWithAi";
const MAX_REPAIR_ATTEMPTS = 3;
const MAX_PROPOSALS = 20;

const NO_MODEL = [
  "No language model is available in this window.",
  "",
  "Install **GitHub Copilot Chat** (or another extension that provides the Language Model API), sign in,",
  "and ask again."
].join("\n");

const NO_MODEL_PLAIN = "ESP Pin Planner: no language model is available. Install GitHub Copilot Chat (or another language model provider) and try again.";

interface ChatApi {
  createChatParticipant(id: string, handler: vscode.ChatRequestHandler): vscode.ChatParticipant;
}
interface LmApi {
  selectChatModels(): Thenable<vscode.LanguageModelChat[]>;
}

function chatApi(): ChatApi | undefined {
  return (vscode as unknown as { chat?: ChatApi }).chat;
}
function lmApi(): LmApi | undefined {
  return (vscode as unknown as { lm?: LmApi }).lm;
}
function modelErrorType(): typeof vscode.LanguageModelError | undefined {
  return (vscode as unknown as { LanguageModelError?: typeof vscode.LanguageModelError }).LanguageModelError;
}

/** Human-readable reason for a failed model call (consent, quota, availability, …). */
function describeFailure(error: unknown): string {
  const type = modelErrorType();
  if (type && error instanceof type) {
    if (error.code === type.NoPermissions.name) return "access to the language model was not granted";
    if (error.code === type.Blocked.name) return "the language model is currently blocked (quota or policy)";
    if (error.code === type.NotFound.name) return "the selected language model is no longer available";
  }
  return error instanceof Error ? error.message : String(error);
}

function describeProblem(problem: Problem): string {
  const signal = problem.path?.[0] === "peripherals" && typeof problem.path[3] === "string" ? problem.path[3] : undefined;
  const where = problem.owner ? (signal ? `${problem.owner}.${signal}` : problem.owner)
    : problem.gpio !== undefined ? `GPIO${problem.gpio}` : "configuration";
  return `${where}: ${problem.message}`;
}

export interface AiAssistantDeps {
  readSettings: () => PlannerSettings;
  refreshDiagnostics?: (uri: vscode.Uri) => Promise<unknown>;
}

interface Proposal {
  id: string;
  uri: vscode.Uri;
  text: string;
  chip: string;
}

interface RepairSuccess {
  plan: IntentPlan;
  chip: string;
}
interface RepairFailure {
  failure: string[];
}

/**
 * Owns the chat participant, the AI commands and the pending proposals that the chat
 * "Apply" button / the fix command commit to `.pinconfig.json`.
 */
export class AiAssistant implements vscode.Disposable {
  private readonly proposals = new Map<string, Proposal>();
  private readonly disposables: vscode.Disposable[] = [];
  private counter = 0;

  constructor(private readonly deps: AiAssistantDeps) {}

  register(context: vscode.ExtensionContext): void {
    const chat = chatApi();
    if (!chat) return;
    try {
      const participant = chat.createChatParticipant(PARTICIPANT_ID, (request, _context, response, token) =>
        this.handleChat(request, response, token));
      participant.iconPath = vscode.Uri.joinPath(context.extensionUri, "resources", "icon.png");
      this.disposables.push(participant);
    } catch (error) {
      console.error("ESP Pin Planner: could not register the chat participant:", error);
    }
  }

  /** Commands and the "Ask AI to fix" quick fix. Registered even without a language model. */
  registerCommands(): vscode.Disposable[] {
    const disposables = [
      vscode.commands.registerCommand(APPLY_COMMAND, async (id: string) => { await this.applyProposal(id); }),
      vscode.commands.registerCommand(FIX_COMMAND, async (uri?: vscode.Uri) => { await this.fixWithAi(uri); }),
      vscode.languages.registerCodeActionsProvider({ language: "json", pattern: "**/.pinconfig.json" }, {
        provideCodeActions: (document, _range, actionContext) => this.provideFixActions(document, actionContext)
      })
    ];
    this.disposables.push(...disposables);
    return disposables;
  }

  private provideFixActions(document: vscode.TextDocument, actionContext: vscode.CodeActionContext): vscode.CodeAction[] {
    const errors = actionContext.diagnostics.filter(diagnostic =>
      diagnostic.source === "ESP Pin Planner" && diagnostic.severity === vscode.DiagnosticSeverity.Error);
    if (!errors.length) return [];
    const action = new vscode.CodeAction("Ask AI to fix", vscode.CodeActionKind.QuickFix);
    action.command = { title: action.title, command: FIX_COMMAND, arguments: [document.uri] };
    action.diagnostics = errors;
    return [action];
  }

  // ── chat participant ──────────────────────────────────────────────────────

  private async handleChat(request: vscode.ChatRequest, response: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<void> {
    const prompt = request.prompt.trim();
    if (!prompt && request.command !== "fix") {
      response.markdown("Tell me what to configure, e.g. `configure a DVP camera, an SPI LCD, I²C and a UART on the ESP32-P4`.");
      return;
    }
    const model = await this.selectModel();
    if (!model) { response.markdown(NO_MODEL); return; }
    const settings = this.deps.readSettings();
    const uri = this.resolveConfigUri();
    if (request.command === "fix") { await this.chatFix(model, uri, prompt, settings, response, token); return; }
    await this.chatGenerate(model, uri, prompt, settings, response, token);
  }

  private async chatGenerate(model: vscode.LanguageModelChat, uri: vscode.Uri | undefined, prompt: string,
                             settings: PlannerSettings, response: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<void> {
    const existing = uri ? await this.tryReadChip(uri) : undefined;
    const fallback = existing && getDevice(existing) ? existing : settings.defaultTarget;
    const chip = detectChip(prompt) ?? fallback;
    response.progress?.("Asking the language model for a plan…");
    let spec: IntentSpec;
    try {
      spec = await this.requestIntent(model, generationPrompt(prompt, { chip, board: this.boardHints(chip, settings) }), token);
    } catch (error) {
      response.markdown(`The model's answer could not be used: ${describeFailure(error)}.\n\nTry rephrasing the request.`);
      return;
    }
    const planChip = spec.chip && getDevice(spec.chip) ? spec.chip : chip;
    const plan = planFromIntent(spec, planChip, { board: this.boardHints(planChip, settings), settings });
    this.reportPlan(response, plan, planChip, uri);
  }

  private async chatFix(model: vscode.LanguageModelChat, uri: vscode.Uri | undefined, prompt: string,
                        settings: PlannerSettings, response: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<void> {
    if (!uri) { response.markdown("Open a workspace folder containing `.pinconfig.json` first."); return; }
    const text = await this.readText(uri);
    if (text === undefined) { response.markdown("No `.pinconfig.json` in this workspace — ask me to generate one first."); return; }
    const problems = diagnosticProblems(text, settings);
    if (!problems.some(problem => problem.severity === "error")) { response.markdown("No errors to fix in this configuration."); return; }
    response.progress?.("Asking the language model to repair the configuration…");
    const result = await this.runRepair(model, text, problems, prompt, settings, token);
    if ("failure" in result) {
      response.markdown(`I could not fully repair the configuration.\n\n${result.failure.map(item => `- ${item}`).join("\n")}`);
      return;
    }
    const summary = summarizeConfig(result.plan.config);
    response.markdown([
      `### Repaired configuration for **${result.chip}**`,
      "",
      ...(summary.length ? summary.map(line => `- ${line}`) : ["- (nothing left to configure)"])
    ].join("\n"));
    if (result.plan.warnings.length) response.markdown(`\n_Optimizer notes:_ ${result.plan.warnings.join(" ")}`);
    response.markdown("\n```json\n" + JSON.stringify(result.plan.config, null, 2) + "\n```");
    const proposal = this.store(uri, result.plan.config, result.chip);
    response.button({ command: APPLY_COMMAND, title: "Apply repaired configuration", arguments: [proposal.id] });
  }

  private reportPlan(response: vscode.ChatResponseStream, plan: IntentPlan, chip: string, uri: vscode.Uri | undefined): void {
    const errors = plan.problems.filter(problem => problem.severity === "error");
    const warnings = plan.problems.filter(problem => problem.severity === "warning");
    if (plan.dropped.length) response.markdown(`_Ignored:_ ${plan.dropped.join(" ")}\n`);
    if (errors.length) {
      response.markdown([
        `I did **not** produce a valid configuration for **${chip}** — nothing was written.`,
        "",
        "Errors:",
        ...errors.map(problem => `- ${describeProblem(problem)}`)
      ].join("\n"));
      response.markdown("```json\n" + JSON.stringify(plan.config, null, 2) + "\n```");
      return;
    }
    const summary = summarizeConfig(plan.config);
    response.markdown([
      `### Proposed configuration for **${chip}**`,
      "",
      ...(summary.length ? summary.map(line => `- ${line}`) : ["- (nothing to configure)"])
    ].join("\n"));
    if (plan.warnings.length) response.markdown(`\n_Optimizer notes:_ ${plan.warnings.join(" ")}`);
    if (warnings.length) response.markdown(`\n_Warnings:_\n${warnings.map(problem => `- ${describeProblem(problem)}`).join("\n")}`);
    response.markdown("\n```json\n" + JSON.stringify(plan.config, null, 2) + "\n```");
    if (!uri) { response.markdown("\nOpen a workspace folder to apply this to `.pinconfig.json`."); return; }
    const proposal = this.store(uri, plan.config, chip);
    response.button({ command: APPLY_COMMAND, title: "Apply to .pinconfig.json", arguments: [proposal.id] });
  }

  // ── AI fix (Problems quick fix / command palette) ─────────────────────────

  private async fixWithAi(requestedUri?: vscode.Uri): Promise<void> {
    const uri = this.isConfigUri(requestedUri) ? requestedUri : this.resolveConfigUri();
    if (!uri) { void vscode.window.showInformationMessage("Open a workspace containing .pinconfig.json first."); return; }
    const model = await this.selectModel();
    if (!model) { void vscode.window.showWarningMessage(NO_MODEL_PLAIN); return; }
    const text = await this.readText(uri);
    if (text === undefined) { void vscode.window.showInformationMessage("No .pinconfig.json in this workspace. Create one first."); return; }
    const settings = this.deps.readSettings();
    const problems = diagnosticProblems(text, settings);
    if (!problems.some(problem => problem.severity === "error")) {
      void vscode.window.showInformationMessage("ESP Pin Planner: no errors to fix.");
      return;
    }
    const result = await this.runRepair(model, text, problems, "", settings);
    if ("failure" in result) {
      void vscode.window.showErrorMessage([
        "ESP Pin Planner: AI could not fully repair the configuration.",
        ...result.failure.slice(0, 5).map(item => `• ${item}`)
      ].join(" "));
      return;
    }
    const proposal = this.store(uri, result.plan.config, result.chip);
    const choice = await vscode.window.showInformationMessage(
      `ESP Pin Planner: AI produced a valid configuration for ${result.chip}.`, "Apply");
    if (choice === "Apply") await this.applyProposal(proposal.id);
  }

  /** Shared repair loop: model proposes intent, the optimizer re-solves, the validator gates. */
  private async runRepair(model: vscode.LanguageModelChat, text: string, problems: Problem[], request: string,
                          settings: PlannerSettings, token?: vscode.CancellationToken): Promise<RepairSuccess | RepairFailure> {
    let config: PinConfigDocument | undefined;
    try { config = parseConfig(text); } catch { config = undefined; }
    const baseChip = config && getDevice(config.target.chip) ? config.target.chip : settings.defaultTarget;
    const base: IntentSpec = config ? intentFromConfig(config) : { chip: baseChip };
    const repair = config ? deriveRepairContext(config, problems) : { pinned: {}, occupied: [] as number[] };

    let spec = base;
    let current = problems;
    for (let attempt = 0; attempt < MAX_REPAIR_ATTEMPTS; attempt++) {
      const promptChip = spec.chip && getDevice(spec.chip) ? spec.chip : baseChip;
      const prompt = repairPrompt(request, { chip: promptChip, board: this.boardHints(promptChip, settings) },
        spec, current.filter(problem => problem.severity === "error").map(describeProblem));
      let next: IntentSpec;
      try { next = await this.requestIntent(model, prompt, token); }
      catch (error) { return { failure: [`the model's answer could not be used (${describeFailure(error)})`] }; }
      spec = next;
      const chip = spec.chip && getDevice(spec.chip) ? spec.chip : promptChip;
      // The first pass keeps the assignments that were already valid pinned; later passes let the
      // optimizer move everything so a stubborn conflict can still be resolved.
      const context = attempt === 0 ? repair : { occupied: repair.occupied };
      const plan = planFromIntent(spec, chip, { board: this.boardHints(chip, settings), settings, ...context });
      const remaining = plan.problems.filter(problem => problem.severity === "error");
      if (!remaining.length) return { plan, chip };
      current = plan.problems;
    }
    return { failure: current.filter(problem => problem.severity === "error").map(describeProblem) };
  }

  // ── applying proposals ────────────────────────────────────────────────────

  private async applyProposal(id: string): Promise<void> {
    const proposal = this.proposals.get(id);
    if (!proposal) { void vscode.window.showWarningMessage("ESP Pin Planner: this proposal is no longer available. Ask again."); return; }
    try {
      const open = vscode.workspace.textDocuments.find(document => document.uri.toString() === proposal.uri.toString());
      if (open?.isDirty) throw new Error("save or discard your JSON editor changes before applying");
      const existing = await this.readText(proposal.uri);
      const edit = new vscode.WorkspaceEdit();
      if (existing === undefined) {
        edit.createFile(proposal.uri, { overwrite: false });
        edit.insert(proposal.uri, new vscode.Position(0, 0), proposal.text);
      } else {
        const document = await vscode.workspace.openTextDocument(proposal.uri);
        if (document.getText() !== existing) throw new Error("the file changed since the proposal was generated; ask again");
        edit.replace(proposal.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), proposal.text);
      }
      if (!await vscode.workspace.applyEdit(edit)) throw new Error("the edit could not be applied");
      const saved = await vscode.workspace.openTextDocument(proposal.uri);
      if (!await saved.save()) throw new Error("the file could not be saved");
      this.proposals.delete(id);
      await this.deps.refreshDiagnostics?.(proposal.uri);
      void vscode.window.showInformationMessage(`ESP Pin Planner: applied the AI configuration for ${proposal.chip}.`);
    } catch (error) {
      void vscode.window.showErrorMessage(`ESP Pin Planner: could not apply the configuration — ${describeFailure(error)}.`);
    }
  }

  private store(uri: vscode.Uri, config: PinConfigDocument, chip: string): Proposal {
    const proposal: Proposal = { id: `proposal-${++this.counter}`, uri, text: JSON.stringify(config, null, 2) + "\n", chip };
    this.proposals.set(proposal.id, proposal);
    while (this.proposals.size > MAX_PROPOSALS) {
      const oldest = this.proposals.keys().next().value;
      if (oldest === undefined) break;
      this.proposals.delete(oldest);
    }
    return proposal;
  }

  // ── model plumbing ────────────────────────────────────────────────────────

  private async selectModel(): Promise<vscode.LanguageModelChat | undefined> {
    const lm = lmApi();
    if (!lm) return undefined;
    try {
      const models = await lm.selectChatModels();
      return models[0];
    } catch (error) {
      console.error("ESP Pin Planner: language model selection failed:", error);
      return undefined;
    }
  }

  /** Ask the model for an intent spec, retrying once if the answer is not usable JSON. */
  private async requestIntent(model: vscode.LanguageModelChat, prompt: string, token?: vscode.CancellationToken): Promise<IntentSpec> {
    const messages: vscode.LanguageModelChatMessage[] = [vscode.LanguageModelChatMessage.User(prompt)];
    let lastError: unknown = new Error("the model returned no usable answer");
    for (let attempt = 0; attempt < 2; attempt++) {
      const text = await this.runModel(model, messages, token);
      try {
        return extractIntentJson(text);
      } catch (error) {
        lastError = error;
        messages.push(vscode.LanguageModelChatMessage.Assistant(text));
        messages.push(vscode.LanguageModelChatMessage.User(`That answer was not usable: ${describeFailure(error)}. Return only the JSON object, nothing else.`));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async runModel(model: vscode.LanguageModelChat, messages: vscode.LanguageModelChatMessage[], token?: vscode.CancellationToken): Promise<string> {
    const response = await model.sendRequest(messages, {
      justification: "ESP Pin Planner uses the language model to turn your description into a pin configuration."
    }, token);
    let text = "";
    for await (const chunk of response.text) text += chunk;
    return text;
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private boardHints(chip: string, settings: PlannerSettings): BoardHints | undefined {
    if (chip !== "esp32s3" && chip !== "esp32c6" && chip !== "esp32p4" && chip !== "esp32c3" && chip !== "esp32c2" && chip !== "esp32" && chip !== "esp32s2") return undefined;
    try {
      const board = resolveBoardFromSettings(settings.board, chip);
      return board ? boardHintsFromProfile(board) : undefined;
    } catch { return undefined; }
  }

  private isConfigUri(uri?: vscode.Uri): uri is vscode.Uri {
    return Boolean(uri && typeof uri.path === "string" && uri.path.endsWith("/.pinconfig.json"));
  }

  private resolveConfigUri(): vscode.Uri | undefined {
    const active = vscode.window.activeTextEditor?.document.uri;
    if (this.isConfigUri(active)) return active;
    const folders = vscode.workspace.workspaceFolders;
    const folder = folders?.length === 1 ? folders[0] : folders?.[0];
    return folder ? vscode.Uri.joinPath(folder.uri, ".pinconfig.json") : undefined;
  }

  private async readText(uri: vscode.Uri): Promise<string | undefined> {
    const document = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === uri.toString());
    if (document) return document.getText();
    try {
      return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
    } catch (error) {
      if (error instanceof vscode.FileSystemError && error.code === "FileNotFound") return undefined;
      throw error;
    }
  }

  private async tryReadChip(uri: vscode.Uri): Promise<string | undefined> {
    try {
      const text = await this.readText(uri);
      return text === undefined ? undefined : parseConfig(text).target.chip;
    } catch { return undefined; }
  }

  dispose(): void {
    this.disposables.forEach(disposable => disposable.dispose());
    this.proposals.clear();
  }
}
