import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { createConfig, gpioFunctions, parseConfig, serializeConfig, setPin } from "./core/model/config";
import type { ClientMessage, PlannerState } from "./core/model/messages";
import { validateGpio } from "./core/validator/gpio";
import { devices, getDevice } from "./database/loader";
import { addPeripheral, removePeripheral, setSignal, selectTarget } from "./core/model/peripherals";
import { candidates, definition } from "./core/resolver/peripherals";
import { PinDiagnostics } from "./vscode/diagnostics";
import { PlannerHomeProvider } from "./vscode/homeView";
import { detectTarget } from "./vscode/projectDetector";
import { projectNotice } from "./core/model/project";
import { readSettings, type PlannerSettings } from "./config/userSettings";
import { resolveBoardFromSettings, boardInfoOf } from "./database/boardLoader";
import type { BoardInfo } from "./core/model/messages";

function readExtensionSettings(overrides: Partial<PlannerSettings> = {}): PlannerSettings {
  // Prefer the live VS Code workspace configuration; fall back to env/static defaults in tests.
  try {
    return readSettings(overrides, vscode.workspace);
  } catch {
    return readSettings(overrides);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const diagnostics = new PinDiagnostics();
  const home = new PlannerHomeProvider(readExtensionSettings);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("espPinPlanner.home", home),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void home.refresh()),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration("espPinPlanner")) void home.refresh();
    }),
    vscode.workspace.onDidChangeTextDocument(event => {
      const path = event.document.uri.path;
      if (path.endsWith("/.pinconfig.json") || path.endsWith("/sdkconfig")) void home.refresh();
    })
  );
  context.subscriptions.push(diagnostics,
    vscode.commands.registerCommand("espPinPlanner.selectTarget", async () => {
      try {
        const folders = vscode.workspace.workspaceFolders;
        const folder = folders?.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick();
        if (!folder) { void vscode.window.showInformationMessage("Open a workspace containing .pinconfig.json first."); return; }
        const uri = vscode.Uri.joinPath(folder.uri, ".pinconfig.json");
        let baseline: string | undefined;
        try { baseline = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8"); }
        catch (error) {
          if (error instanceof vscode.FileSystemError && error.code === "FileNotFound") {
            void vscode.window.showInformationMessage("No .pinconfig.json in this workspace. Use Create New Pin Config first.");
          } else { throw error; }
          return;
        }
        const open = vscode.workspace.textDocuments.find(document => document.uri.toString() === uri.toString());
        if (open?.isDirty) throw new Error("Save or discard JSON editor changes before selecting the target chip.");
        const config = parseConfig(baseline);
        const hasAssignments = config.pins.length > 0 || Object.keys(config.peripherals ?? {}).length > 0;
        const choices = devices.map(device => ({ label: device.id, description: device.id === config.target.chip ? `${device.name} (current)` : device.name, detail: hasAssignments ? "Assignments are kept and re-checked against the new chip." : undefined, target: device.id }));
        const currentIndex = choices.findIndex(choice => choice.label === config.target.chip);
        if (currentIndex > 0) {
          const [current] = choices.splice(currentIndex, 1);
          choices.unshift(current);
        }
        const picked = await vscode.window.showQuickPick(choices, {
          title: "Select Target Chip",
          placeHolder: `Current target: ${config.target.chip}`
        });
        if (!picked || picked.target === config.target.chip) return;
        const updated = selectTarget(config, picked.target);
        const next = serializeConfig(updated);
        const edit = new vscode.WorkspaceEdit();
        const document = await vscode.workspace.openTextDocument(uri);
        if (document.getText() !== baseline) throw new Error("Configuration changed while selecting target.");
        edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), next);
        if (!await vscode.workspace.applyEdit(edit)) throw new Error("Could not update the target chip.");
        const saved = await vscode.workspace.openTextDocument(uri);
        if (!await saved.save()) throw new Error("Target change could not be saved.");
        await diagnostics.refresh(uri, true);
        void vscode.window.showInformationMessage(hasAssignments
          ? `Target changed to ${picked.target}. Existing assignments were kept; review the new diagnostics.`
          : `Target changed to ${picked.target}.`);
      } catch (error) {
        void vscode.window.showErrorMessage(`Select target chip failed: ${String(error)}`);
      }
    }),
    vscode.commands.registerCommand("espPinPlanner.create", async () => {
      try {
        const folders = vscode.workspace.workspaceFolders;
        const folder = folders?.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick();
        if (!folder) { void vscode.window.showInformationMessage("Open a workspace before creating a pin configuration."); return; }
        const detected = await detectTarget(folder);
        const settings = readExtensionSettings();
        const choices = devices.map(device => device.id);
        if (detected) {
          const index = choices.indexOf(detected);
          if (index >= 0) choices.splice(index, 1);
          choices.unshift(detected);
        } else if (settings.defaultTarget && choices.includes(settings.defaultTarget)) {
          // When the project cannot be detected, honour the user default target (after devices validation).
          const idx = choices.indexOf(settings.defaultTarget);
          if (idx > 0) choices.splice(idx, 1);
          choices.unshift(settings.defaultTarget);
        }
        const placeHolder = detected
          ? `Detected target: ${detected}`
          : `Default target (espPinPlanner.defaultTarget): ${choices[0] ?? "esp32s3"}`;
        const chip = await vscode.window.showQuickPick(choices.map(id => ({
          label: id,
          description: getDevice(id) ? "Supported basic database"
            : "Detected project target; database not supported yet"
        })), { title: "Create Pin Configuration", placeHolder });
        if (!chip) return;
        const uri = vscode.Uri.joinPath(folder.uri, ".pinconfig.json");
        if (vscode.workspace.textDocuments.some(document => document.uri.toString() === uri.toString())) {
          throw new Error("A pin configuration is already open. Existing configuration will not be overwritten.");
        }
        const edit = new vscode.WorkspaceEdit();
        edit.createFile(uri, { overwrite: false });
        edit.insert(uri, new vscode.Position(0, 0), serializeConfig(createConfig(chip.label)));
        if (!await vscode.workspace.applyEdit(edit)) throw new Error("Could not create configuration; check whether it already exists.");
        const document = await vscode.workspace.openTextDocument(uri);
        if (!await document.save()) throw new Error("Configuration could not be saved.");
        await vscode.window.showTextDocument(document);
        await diagnostics.refresh(uri, true);
      } catch (error) {
        void vscode.window.showErrorMessage(`Create pin configuration failed: ${String(error)}`);
      }
    }),
    vscode.commands.registerCommand("espPinPlanner.validate", async () => {
      try {
        const active = vscode.window.activeTextEditor?.document.uri;
        const activeConfig = active?.path.endsWith("/.pinconfig.json") && vscode.workspace.getWorkspaceFolder(active) ? active : undefined;
        const folders = vscode.workspace.workspaceFolders;
        const folder = activeConfig ? undefined : folders?.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick();
        const uri = activeConfig ?? (folder ? vscode.Uri.joinPath(folder.uri, ".pinconfig.json") : undefined);
        if (!uri) { void vscode.window.showInformationMessage("Open a workspace containing .pinconfig.json first."); return; }
        const problems = await diagnostics.refresh(uri, true);
        const errors = problems.filter(problem => problem.severity === "error").length;
        void vscode.window.showInformationMessage(`ESP Pin Planner: ${errors} errors, ${problems.length - errors} warnings. Only implemented constraints were checked.`);
      } catch (error) {
        void vscode.window.showErrorMessage(`Pin validation failed: ${String(error)}`);
      }
    }),
    vscode.languages.registerCodeActionsProvider({ language: "json", pattern: "**/.pinconfig.json" }, {
      provideCodeActions(document, _range, actionContext) {
        return actionContext.diagnostics.filter(diagnostic => diagnostic.source === "ESP Pin Planner").map(diagnostic => {
          const action = new vscode.CodeAction("View in Pin Planner", vscode.CodeActionKind.QuickFix);
          const match = /^GPIO(\d+)$/.exec(String(diagnostic.code));
          action.command = { title: action.title, command: "espPinPlanner.open", arguments: [document.uri, match ? Number(match[1]) : undefined] };
          action.diagnostics = [diagnostic];
          return action;
        });
      }
    }));
  context.subscriptions.push(vscode.commands.registerCommand("espPinPlanner.open", async (requestedUri?: vscode.Uri, selectedGpio?: number) => {
    const folders = vscode.workspace.workspaceFolders;
    const requestedFolder = requestedUri && typeof requestedUri.path === "string" && requestedUri.path.endsWith("/.pinconfig.json")
      ? vscode.workspace.getWorkspaceFolder(requestedUri) : undefined;
    const folder = requestedFolder ?? (folders?.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick());
    const uri = requestedFolder ? requestedUri : folder ? vscode.Uri.joinPath(folder.uri, ".pinconfig.json") : undefined;
    const panel = vscode.window.createWebviewPanel("espPinPlanner", "ESP Pin Planner", vscode.ViewColumn.One, {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "dist", "webview")]
    });
    const nonce = randomBytes(16).toString("hex");
    const script = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "dist", "webview", "planner.js"));
    const style = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "dist", "webview", "planner.css"));
    panel.webview.html = `<!doctype html><html><head><meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource}; script-src 'nonce-${nonce}';">
      <link rel="stylesheet" href="${style}"></head><body><div id="root"></div>
      <script nonce="${nonce}" type="module" src="${script}"></script></body></html>`;
    let revision = 0;
    let baseline: string | undefined;
    let state: PlannerState = {
      config: createConfig(), revision, file: uri?.fsPath ?? "Preview (open a workspace to save)",
      writable: Boolean(uri), problems: [], notice: ""
    };
    let queue = Promise.resolve();
    const subscriptions: vscode.Disposable[] = [];
    const computeBoardInfo = (): BoardInfo | undefined => {
      try {
        const s = readExtensionSettings();
        const chip = state.config.target.chip;
        const valid = chip === "esp32s3" || chip === "esp32c6" || chip === "esp32p4" ? chip : "esp32s3";
        const b = resolveBoardFromSettings(s.board, valid);
        return b ? boardInfoOf(b) : undefined;
      } catch {
        return undefined;
      }
    };
    const publish = () => panel.webview.postMessage({
      type: "state" as const,
      state: { ...state, board: computeBoardInfo() }
    });
    const enqueue = (task: () => Promise<void>) => {
      queue = queue.then(task).catch(error => {
        state = { ...state, notice: error instanceof Error ? error.message : String(error) };
        void publish();
      });
    };
    async function readText(): Promise<string | undefined> {
      if (!uri) return undefined;
      const open = vscode.workspace.textDocuments.find(document => document.uri.toString() === uri.toString());
      if (open) return open.getText();
      try {
        return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
      } catch (error) {
        if (error instanceof vscode.FileSystemError && error.code === "FileNotFound") return undefined;
        throw error;
      }
    }
    async function refresh(): Promise<void> {
      try {
        baseline = await readText();
        let detected: string | undefined;
        let detectionNotice = "";
        try { detected = folder ? await detectTarget(folder) : undefined; }
        catch (error) { detectionNotice = `Could not detect project target: ${String(error)}. `; }
        const settings = readExtensionSettings();
        const fallback = detected ?? settings.defaultTarget;
        const config = baseline === undefined ? createConfig(fallback) : parseConfig(baseline);
        const supported = Boolean(getDevice(config.target.chip));
        const createMsg = baseline === undefined && uri
          ? detected ? `Detected project target ${detected}. Choose a GPIO function to create .pinconfig.json.`
            : `Default target ${settings.defaultTarget} (espPinPlanner.defaultTarget). Choose a GPIO function to create .pinconfig.json.`
          : "";
        state = {
          config, revision: ++revision, file: state.file,
          writable: Boolean(uri) && supported,
          problems: validateGpio(config, undefined, settings),
          notice: detectionNotice + (!supported ? `Target ${config.target.chip} is not supported. Editing disabled.` : createMsg)
            + projectNotice(config.target.chip, detected)
        };
      } catch (error) {
        state = { ...state, revision: ++revision, writable: false, notice: `Cannot read configuration: ${String(error)}. Fix it in the JSON editor.` };
      }
      await publish();
    }
    subscriptions.push(panel.webview.onDidReceiveMessage((message: ClientMessage) => {
      enqueue(async () => {
        if (!message || typeof message !== "object") return;
        if (message.type === "ready") {
          await refresh();
          if (Number.isInteger(selectedGpio) && getDevice(state.config.target.chip)?.pins.some(pin => pin.gpio === selectedGpio)) {
            await panel.webview.postMessage({ type: "focus", gpio: selectedGpio });
          }
          return;
        }
        if (message.type === "openJson" && uri) {
          await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
          return;
        }
        if (!["setPin", "addPeripheral", "removePeripheral", "setSignal", "selectTarget"].includes(message.type)) return;
        if (message.type === "openJson") return;
        if (!uri || !state.writable) {
          state.notice = "Configuration is read-only. Open a supported workspace configuration before editing.";
          await publish();
          return;
        }
        if (message.revision !== state.revision || await readText() !== baseline) {
          await refresh();
          state.notice = "Configuration changed externally. Review the refreshed state and retry.";
          await publish();
          return;
        }
        let updated = state.config;
        const device = getDevice(state.config.target.chip);
        if (message.type === "setPin") {
          if (!device?.pins.some(pin => pin.gpio === message.gpio) ||
            (message.function !== null && !(gpioFunctions as readonly unknown[]).includes(message.function))) {
            throw new Error("Invalid GPIO assignment request.");
          }
          updated = setPin(state.config, message.gpio, message.function);
        } else if (message.type === "addPeripheral") {
          updated = addPeripheral(state.config, message.peripheral, message.instance);
        } else if (message.type === "removePeripheral") {
          updated = removePeripheral(state.config, message.owner);
        } else if (message.type === "setSignal") {
          const peripheral = state.config.peripherals?.[message.owner];
          const signal = peripheral && definition(peripheral.type, peripheral.instance, state.config.target.chip)?.signals.find(item => item.id === message.signal);
          if (!signal || (message.gpio !== null && !candidates(signal, state.config.target.chip, peripheral.instance).includes(message.gpio))) {
            throw new Error("Invalid peripheral GPIO route.");
          }
          updated = setSignal(state.config, message.owner, message.signal, message.gpio);
        } else if (message.type === "selectTarget") {
          updated = selectTarget(state.config, message.chip);
        }
        const next = serializeConfig(updated);
        const edit = new vscode.WorkspaceEdit();
        if (baseline === undefined) {
          edit.createFile(uri, { overwrite: false });
          edit.insert(uri, new vscode.Position(0, 0), next);
        } else {
          const document = await vscode.workspace.openTextDocument(uri);
          if (document.getText() !== baseline) { await refresh(); return; }
          if (document.isDirty) {
            throw new Error("Save or discard your JSON editor changes before editing from Pin Planner.");
          }
          edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), next);
        }
        if (!await vscode.workspace.applyEdit(edit)) throw new Error("Could not apply configuration edit.");
        const document = await vscode.workspace.openTextDocument(uri);
        if (!await document.save()) throw new Error("Configuration changed in memory but could not be saved.");
        await refresh();
      });
    }));
    if (uri && folder) {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, ".pinconfig.json"));
      subscriptions.push(watcher,
        watcher.onDidChange(() => enqueue(refresh)),
        watcher.onDidCreate(() => enqueue(refresh)),
        watcher.onDidDelete(() => enqueue(refresh)),
        vscode.workspace.onDidChangeTextDocument(event => {
          if (event.document.uri.toString() === uri.toString()) enqueue(refresh);
        }));
      const targetUri = vscode.Uri.joinPath(folder.uri, "sdkconfig");
      const targetWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, "sdkconfig"));
      subscriptions.push(targetWatcher,
        targetWatcher.onDidChange(() => enqueue(refresh)),
        targetWatcher.onDidCreate(() => enqueue(refresh)),
        targetWatcher.onDidDelete(() => enqueue(refresh)),
        vscode.workspace.onDidChangeTextDocument(event => {
          if (event.document.uri.toString() === targetUri.toString()) enqueue(refresh);
        }));
    }
    panel.onDidDispose(() => subscriptions.forEach(subscription => subscription.dispose()));
    enqueue(refresh);
  }));
}
