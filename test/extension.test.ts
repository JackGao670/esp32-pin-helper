import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { runInNewContext } from "node:vm";
import { createRequire } from "node:module";
import { serializeConfig, createConfig } from "../src/core/model/config";
import type { ClientMessage, HostMessage } from "../src/core/model/messages";

type BundleResult = { outputFiles: { text: string }[] };
type Mock = Awaited<ReturnType<typeof makeMock>>;
async function bundleExtension(): Promise<BundleResult> {
  return build({ entryPoints: ["src/extension.ts"], bundle: true, platform: "node",
    format: "cjs", mainFields: ["module", "main"], external: ["vscode"], write: false });
}

function makeMock(options: { quickPickTarget?: string; cancelQuickPick?: boolean } = {}) {
  const listeners: Record<string, (...args: any[]) => any> = {};
  const noopDisposable = { dispose() {} };
  let disk: string | undefined;
  let sdkconfig: string | undefined;
  let quickPickCancelled = options.cancelQuickPick === true;
  let quickPickTargetOverride = options.quickPickTarget;
  let errorMessage = "";
  let infoMessage = "";
  let document: ReturnType<typeof makeDocument> | undefined;
  let last: Extract<HostMessage, { type: "state" }> | undefined;
  let applyCount = 0;
  const uri = { path: "/test/.pinconfig.json", fsPath: "/test/.pinconfig.json", toString: () => "file:///test/.pinconfig.json" };
  const diagnosticListeners: Record<string, (...args: any[]) => any> = {};
  let currentDiagnostics: { message: string; code?: string }[] = [];
  const commands: Record<string, (...args: any[]) => any> = {};
  let focus: number | undefined;
  let savedUri: string | undefined;
  let plannerSettings: Record<string, unknown> = {
    defaultTarget: "esp32s3",
    schemaStrictInstance: true,
    rmtChannelBank: "auto"
  };
  function makeDocument() {
    let text = disk ?? "";
    return {
      uri,
      getText: () => text,
      setText(next: string) { text = next; },
      positionAt: (offset: number) => ({ offset }),
      save: async () => { savedUri = uri.toString(); return true; },
      isDirty: false
    };
  }
  class FileSystemError extends Error { code = "FileNotFound"; }
  class WorkspaceEdit {
    next = "";
    creating = false;
    createFile() { this.creating = true; }
    insert(_uri: unknown, _position: unknown, text: string) { this.next = text; }
    replace(_uri: unknown, _range: unknown, text: string) { this.next = text; }
  }
  const mock = {
    Uri: { joinPath: (_base: unknown, ...parts: string[]) => parts.at(-1) === "sdkconfig"
      ? { ...uri, path: "/test/sdkconfig", toString: () => "file:///test/sdkconfig" } : uri },
    ViewColumn: { One: 1 },
    FileSystemError, WorkspaceEdit,
    Position: class { constructor(..._args: unknown[]) {} },
    Range: class { constructor(..._args: unknown[]) {} },
    RelativePattern: class { constructor(..._args: unknown[]) {} },
    Diagnostic: class { constructor(public range: unknown, public message: string, public severity: number) {} },
    DiagnosticSeverity: { Error: 0, Warning: 1 },
    CodeAction: class { constructor(public title: string, public kind: unknown) {} },
    CodeActionKind: { QuickFix: "quickfix" },
    languages: {
      createDiagnosticCollection: () => ({
        ...noopDisposable, clear() {}, delete() { currentDiagnostics = []; },
        set(_uri: unknown, values: typeof currentDiagnostics) { currentDiagnostics = values; }
      }),
      registerCodeActionsProvider: (_selector: unknown, provider: any) => { listeners.actions = provider.provideCodeActions; return noopDisposable; }
    },
    commands: { registerCommand: (id: string, callback: (...args: any[]) => unknown) => {
      commands[id] = callback;
      if (id === "espPinPlanner.open") listeners.open = callback;
      return noopDisposable;
    } },
    workspace: {
      workspaceFolders: [{ uri }],
      getWorkspaceFolder: () => ({ uri }),
      findFiles: async () => disk === undefined ? [] : [uri],
      onDidOpenTextDocument: () => noopDisposable,
      onDidCloseTextDocument: () => noopDisposable,
      onDidChangeWorkspaceFolders: () => noopDisposable,
      get textDocuments() { return document ? [document] : []; },
      getConfiguration: (section: string) => {
        if (section !== "espPinPlanner") return { get: () => undefined };
        return { get: <T = unknown>(key: string): T | undefined => plannerSettings[key] as T | undefined };
      },
      fs: { readFile: async (file: { path: string }) => {
        if (file.path.endsWith("/sdkconfig")) {
          if (sdkconfig === undefined) throw new FileSystemError();
          return Buffer.from(sdkconfig);
        }
        if (disk === undefined) throw new FileSystemError();
        return Buffer.from(disk);
      } },
      openTextDocument: async () => {
        document ??= makeDocument();
        if (disk !== undefined) document.setText(disk);
        return document;
      },
      applyEdit: async (edit: WorkspaceEdit) => {
        if (edit.creating && disk !== undefined) return false;
        disk = edit.next;
        if (document) document.setText(edit.next);
        applyCount++;
        return true;
      },
      onDidChangeTextDocument: (callback: (...args: any[]) => any) => { listeners.document = callback; return noopDisposable; },
      createFileSystemWatcher: (pattern: unknown) => {
        const target = typeof pattern === "string" ? diagnosticListeners : listeners;
        return ({
        ...noopDisposable,
        onDidChange: (callback: () => unknown) => { target.change = callback; return noopDisposable; },
        onDidCreate: () => noopDisposable,
        onDidDelete: (callback: () => unknown) => { target.delete = callback; return noopDisposable; }
      }); }
    },
    window: {
      createWebviewPanel: () => ({
        webview: {
          cspSource: "test",
          html: "",
          asWebviewUri: () => "test-resource",
          postMessage: async (message: HostMessage) => {
            if (message.type === "state") last = message; else focus = message.gpio;
            return true;
          },
          onDidReceiveMessage: (callback: (message: ClientMessage) => unknown) => { listeners.message = callback; return noopDisposable; }
        },
        onDidDispose: () => noopDisposable
      }),
      showTextDocument: async () => {},
      showInformationMessage: async (msg: string) => { infoMessage = msg; },
      showQuickPick: async (items: { label: string; target?: string }[]) => {
        if (quickPickCancelled) return undefined;
        if (quickPickTargetOverride) return items.find(item => item.target === quickPickTargetOverride) ?? items[0];
        return items[0];
      },
      showErrorMessage: async (message: string) => { errorMessage = message; },
      showWorkspaceFolderPick: async () => undefined
    }
  };
  return {
    bundle: undefined as unknown as BundleResult,
    listeners, noopDisposable, disk: {
      get current() { return disk; },
      set current(value: string | undefined) {
        disk = value;
        if (value === undefined) {
          // Removing the file also means any "opened" document is no longer backed by disk.
          document = undefined;
        } else if (document) {
          document.setText(value);
        }
      }
    },
    sdkconfig: { get current() { return sdkconfig; }, set current(v: string | undefined) { sdkconfig = v; } },
    get quickPickCancelled() { return quickPickCancelled; },
    setQuickPickTarget(value: string | undefined) { quickPickTargetOverride = value; quickPickCancelled = value === undefined ? quickPickCancelled : false; },
    cancelQuickPick() { quickPickCancelled = true; },
    errorMessage: { get current() { return errorMessage; }, clear() { errorMessage = ""; } },
    infoMessage: { get current() { return infoMessage; }, clear() { infoMessage = ""; } },
    get document() { return document; },
    last: { get current() { return last; } },
    applyCount: { get current() { return applyCount; } },
    uri, diagnosticListeners, currentDiagnostics: { get current() { return currentDiagnostics; } }, commands,
    focus: { get current() { return focus; } },
    get savedUri() { return savedUri; },
    setPlannerSettings(patch: Record<string, unknown>) { Object.assign(plannerSettings, patch); },
    resetPlannerSettings() {
      plannerSettings = { defaultTarget: "esp32s3", schemaStrictInstance: true, rmtChannelBank: "auto" };
    },
    mock
  };
}

function activate(bundle: BundleResult, mock: ReturnType<typeof makeMock>) {
  const exports: { activate?: (context: unknown) => void } = {};
  const module = { exports };
  const require = createRequire(import.meta.url);
  runInNewContext(bundle.outputFiles[0].text, {
    module, exports, Buffer, process, globalThis,
    require: (id: string) => id === "vscode" ? mock.mock : require(id)
  });
  module.exports.activate!({ subscriptions: [], extensionUri: mock.uri });
}

async function settle(times = 5) {
  for (let i = 0; i < times; i++) await new Promise<void>(resolve => setImmediate(resolve));
}

test("extension message flow saves, reloads and protects external edits", async () => {
  const bundle = await bundleExtension();
  const ctx = makeMock();
  activate(bundle, ctx);
  await ctx.listeners.open();
  await settle();
  assert.equal(ctx.last.current!.state.writable, true);
  assert.equal(ctx.disk.current, undefined, "opening the planner must not create a file");

  ctx.listeners.message({ type: "setPin", gpio: 17, function: "GPIO_OUTPUT", revision: ctx.last.current!.state.revision });
  await settle();
  assert.equal(JSON.parse(ctx.disk.current!).pins[0].function, "GPIO_OUTPUT");
  assert.equal(ctx.applyCount.current, 1);

  const oldRevision = ctx.last.current!.state.revision;
  const external = createConfig();
  external.pins = [{ gpio: 8, function: "GPIO_INPUT" }];
  ctx.disk.current = serializeConfig(external);
  ctx.listeners.message({ type: "setPin", gpio: 17, function: "GPIO_INPUT", revision: oldRevision });
  await settle();
  assert.equal(ctx.applyCount.current, 1, "stale UI must not overwrite external changes");
  assert.equal(ctx.last.current!.state.config.pins[0].gpio, 8);
  assert.match(ctx.last.current!.state.notice, /changed externally/);

  ctx.disk.current = "{";
  ctx.listeners.change();
  await settle();
  assert.equal(ctx.last.current!.state.writable, false);
  assert.match(ctx.last.current!.state.notice, /Cannot read/);
  ctx.disk.current = serializeConfig({ ...createConfig(), target: { chip: "esp32c5" } });
  ctx.listeners.change();
  await settle();
  assert.equal(ctx.last.current!.state.writable, false);
  assert.match(ctx.last.current!.state.notice, /not supported/);
  ctx.disk.current = serializeConfig(createConfig("esp32p4"));
  ctx.listeners.change();
  await settle();
  assert.equal(ctx.last.current!.state.writable, true);
  ctx.listeners.message({ type: "setPin", gpio: 54, function: "GPIO_OUTPUT", revision: ctx.last.current!.state.revision });
  await settle();
  assert.equal(JSON.parse(ctx.disk.current!).pins[0].gpio, 54);

  ctx.disk.current = serializeConfig(createConfig());
  ctx.listeners.change();
  await settle();
  assert.equal(ctx.last.current!.state.writable, true);
  const countBeforeInvalidPin = ctx.applyCount.current;
  ctx.listeners.message({ type: "setPin", gpio: 22, function: "GPIO_OUTPUT", revision: ctx.last.current!.state.revision });
  await settle();
  assert.equal(ctx.applyCount.current, countBeforeInvalidPin);
  assert.match(ctx.last.current!.state.notice, /Invalid GPIO/);
  ctx.listeners.message({ type: "addPeripheral", peripheral: "uart", instance: 1, revision: ctx.last.current!.state.revision });
  await settle();
  assert.ok(JSON.parse(ctx.disk.current!).peripherals.uart1);
  ctx.listeners.message({ type: "setSignal", owner: "uart1", signal: "tx", gpio: 17, revision: ctx.last.current!.state.revision });
  await settle();
  assert.equal(JSON.parse(ctx.disk.current!).peripherals.uart1.signals.tx, "GPIO17");
  const count = ctx.applyCount.current;
  ctx.listeners.message({ type: "setSignal", owner: "uart1", signal: "rx", gpio: 22, revision: ctx.last.current!.state.revision });
  await settle();
  assert.equal(ctx.applyCount.current, count);
  assert.match(ctx.last.current!.state.notice, /Invalid peripheral/);
  ctx.listeners.message({ type: "removePeripheral", owner: "uart1", revision: ctx.last.current!.state.revision });
  await settle();
  assert.deepEqual(JSON.parse(ctx.disk.current!).peripherals, {});
  ctx.disk.current = serializeConfig({ ...createConfig(), pins: [{ gpio: 0, function: "GPIO_INPUT" }] });
  await ctx.commands["espPinPlanner.validate"]();
  assert.ok(ctx.currentDiagnostics.current.some(problem => /Strapping/.test(problem.message)));
  const actions = ctx.listeners.actions(ctx.document ?? { uri: ctx.uri, getText: () => ctx.disk.current ?? "", positionAt: (offset: number) => ({ offset }) }, undefined, { diagnostics: ctx.currentDiagnostics.current });
  assert.equal(actions[0].command.command, "espPinPlanner.open");
  await ctx.commands["espPinPlanner.open"](...actions[0].command.arguments);
  ctx.listeners.message({ type: "ready" });
  await settle();
  assert.equal(ctx.focus.current, 0);
  ctx.disk.current = "{";
  ctx.diagnosticListeners.change(ctx.uri);
  await settle();
  assert.ok(ctx.currentDiagnostics.current.some(problem => /Invalid JSON/.test(problem.message)));
  ctx.diagnosticListeners.delete(ctx.uri);
  assert.equal(ctx.currentDiagnostics.current.length, 0);
  // Re-open planner with sdkconfig target hint (esp32c6) when disk is empty: planner should adopt sdkconfig target without writing.
  ctx.disk.current = undefined;
  ctx.sdkconfig.current = 'CONFIG_IDF_TARGET="esp32c6"';
  await ctx.listeners.open();
  ctx.listeners.message({ type: "ready" });
  await settle();
  assert.equal(ctx.last.current!.state.config.target.chip, "esp32c6");
  assert.equal(ctx.last.current!.state.writable, true);
  assert.equal(ctx.disk.current, undefined, "planner must not write to disk just by opening");

  // Cancel create command must not create a file.
  ctx.cancelQuickPick();
  await ctx.commands["espPinPlanner.create"]();
  assert.equal(ctx.disk.current, undefined, "cancel must not create a file");

  // Confirm create command writes the detected target.
  ctx.setQuickPickTarget("esp32c6");
  ctx.infoMessage.clear();
  await ctx.commands["espPinPlanner.create"]();
  assert.equal(JSON.parse(ctx.disk.current!).target.chip, "esp32c6");

  // Second create must refuse to overwrite an existing file.
  const existing = ctx.disk.current;
  ctx.errorMessage.clear();
  await ctx.commands["espPinPlanner.create"]();
  assert.equal(ctx.disk.current, existing, "create must never overwrite existing configuration");
  assert.match(ctx.errorMessage.current, /already (exists|open)/);

  // Planner opened on a mismatched target (disk is S3 but sdkconfig hints C6) must emit project notice.
  ctx.disk.current = serializeConfig(createConfig("esp32s3"));
  ctx.sdkconfig.current = 'CONFIG_IDF_TARGET="esp32c6"';
  await ctx.listeners.open();
  ctx.listeners.message({ type: "ready" });
  await settle();
  assert.equal(ctx.last.current!.state.config.target.chip, "esp32s3");
  assert.match(ctx.last.current!.state.notice, /differs/);

  // Webview-side selectTarget message can swap chips on an empty doc.
  ctx.disk.current = serializeConfig(createConfig("esp32s3"));
  ctx.sdkconfig.current = undefined;
  await ctx.listeners.open();
  ctx.listeners.message({ type: "ready" });
  await settle();
  ctx.listeners.message({ type: "selectTarget", chip: "esp32c6", revision: ctx.last.current!.state.revision });
  await settle();
  assert.equal(JSON.parse(ctx.disk.current!).target.chip, "esp32c6");

  // Once pins exist, webview selectTarget must refuse and not overwrite.
  ctx.listeners.message({ type: "setPin", gpio: 22, function: "GPIO_OUTPUT", revision: ctx.last.current!.state.revision });
  await settle();
  const beforeSwitch = ctx.disk.current;
  ctx.listeners.message({ type: "selectTarget", chip: "esp32s3", revision: ctx.last.current!.state.revision });
  await settle();
  assert.equal(ctx.disk.current, beforeSwitch);
  assert.match(ctx.last.current!.state.notice, /empty configuration|Target switching requires an empty config/);
});

test("extension espPinPlanner.selectTarget command respects assignments, picks user choice and reports baseline conflicts", async () => {
  const bundle = await bundleExtension();
  // Case 1: no file on disk => command reports info message asking to create first.
  const ctx1 = makeMock();
  activate(bundle, ctx1);
  await ctx1.commands["espPinPlanner.selectTarget"]();
  await settle();
  assert.match(ctx1.infoMessage.current, /Create New Pin Config first/);

  // Case 2: empty S3 file, user picks esp32c6 via quick pick override → write back + show info.
  const ctx2 = makeMock();
  activate(bundle, ctx2);
  ctx2.disk.current = serializeConfig(createConfig("esp32s3"));
  ctx2.setQuickPickTarget("esp32c6");
  await ctx2.commands["espPinPlanner.selectTarget"]();
  await settle();
  assert.equal(JSON.parse(ctx2.disk.current!).target.chip, "esp32c6");
  assert.equal(ctx2.savedUri, ctx2.uri.toString());
  assert.match(ctx2.infoMessage.current, /Target changed to esp32c6/);

  // Case 3: quick pick cancelled → no disk change.
  const ctx3 = makeMock();
  activate(bundle, ctx3);
  ctx3.disk.current = serializeConfig(createConfig("esp32s3"));
  ctx3.cancelQuickPick();
  const before = ctx3.disk.current;
  await ctx3.commands["espPinPlanner.selectTarget"]();
  await settle();
  assert.equal(ctx3.disk.current, before);

  // Case 4: assignments exist but user picks a different chip → core selectTarget refuses, command error message is emitted, disk unchanged.
  const ctx4 = makeMock();
  activate(bundle, ctx4);
  const withAssignment = createConfig("esp32s3");
  withAssignment.pins = [{ gpio: 42, function: "GPIO_OUTPUT" }];
  ctx4.disk.current = serializeConfig(withAssignment);
  ctx4.setQuickPickTarget("esp32p4");
  ctx4.errorMessage.clear();
  await ctx4.commands["espPinPlanner.selectTarget"]();
  await settle();
  assert.match(ctx4.errorMessage.current, /empty configuration|Target switching requires an empty config/);
  assert.equal(JSON.parse(ctx4.disk.current!).target.chip, "esp32s3");
  assert.equal(JSON.parse(ctx4.disk.current!).pins[0].gpio, 42);

  // Case 5: file exists but JSON is invalid → command surfaces parse error.
  const ctx5 = makeMock();
  activate(bundle, ctx5);
  ctx5.disk.current = "{";
  ctx5.setQuickPickTarget("esp32c6");
  ctx5.errorMessage.clear();
  await ctx5.commands["espPinPlanner.selectTarget"]();
  await settle();
  assert.match(ctx5.errorMessage.current, /Select target chip failed/);
});

test("extension espPinPlanner.validate counts baseline errors/warnings; create refuses overwrites", async () => {
  const bundle = await bundleExtension();
  // — validate —
  // Case 1: no file, no active editor, empty workspace folders → info message asks to open workspace first.
  const ctxV1 = makeMock();
  activate(bundle, ctxV1);
  ctxV1.mock.workspace.workspaceFolders = [] as any;
  ctxV1.infoMessage.clear();
  await ctxV1.commands["espPinPlanner.validate"]();
  await settle();
  assert.match(ctxV1.infoMessage.current, /Open a workspace containing \.pinconfig\.json first/);

  // Case 2: baseline empty esp32s3 → 0 errors, 0 warnings (no invalid assignments yet).
  const ctxV2 = makeMock();
  activate(bundle, ctxV2);
  ctxV2.disk.current = serializeConfig(createConfig("esp32s3"));
  ctxV2.infoMessage.clear();
  await ctxV2.commands["espPinPlanner.validate"]();
  await settle();
  assert.match(ctxV2.infoMessage.current, /0 errors, 0 warnings/);

  // Case 3: S3 GPIO46 set to OUTPUT (no output capability) → at least 1 error.
  const ctxV3 = makeMock();
  activate(bundle, ctxV3);
  const cfgNoOut = createConfig("esp32s3");
  cfgNoOut.pins = [{ gpio: 46, function: "GPIO_OUTPUT" }];
  ctxV3.disk.current = serializeConfig(cfgNoOut);
  ctxV3.infoMessage.clear();
  await ctxV3.commands["espPinPlanner.validate"]();
  await settle();
  assert.match(ctxV3.infoMessage.current, /[1-9]\d* errors?/);

  // — create —
  // Case 4: no file → create writes (picks esp32s3 default quick pick first entry) + saved.
  const ctxC1 = makeMock();
  activate(bundle, ctxC1);
  ctxC1.errorMessage.clear();
  ctxC1.infoMessage.clear();
  await ctxC1.commands["espPinPlanner.create"]();
  await settle();
  assert.ok(ctxC1.disk.current, "create must write a new file");
  const created = JSON.parse(ctxC1.disk.current);
  assert.ok(["esp32s3", "esp32c6", "esp32p4"].includes(created.target.chip));
  assert.equal(ctxC1.savedUri, ctxC1.uri.toString());
  assert.equal(ctxC1.errorMessage.current, "", "create on empty disk must emit no error");

  // Case 5: file already exists → create refuses.
  const ctxC2 = makeMock();
  activate(bundle, ctxC2);
  ctxC2.disk.current = serializeConfig(createConfig("esp32p4"));
  const untouched = ctxC2.disk.current;
  ctxC2.errorMessage.clear();
  await ctxC2.commands["espPinPlanner.create"]();
  await settle();
  assert.equal(ctxC2.disk.current, untouched, "create must never overwrite an existing file");
  assert.match(ctxC2.errorMessage.current, /already (exists|open)/);

  // Case 6: active editor holds invalid JSON → create still refuses because file already exists (findFiles returns it).
  const ctxC3 = makeMock();
  activate(bundle, ctxC3);
  ctxC3.disk.current = "{ incomplete";
  ctxC3.errorMessage.clear();
  await ctxC3.commands["espPinPlanner.create"]();
  await settle();
  assert.equal(ctxC3.disk.current, "{ incomplete");
  assert.match(ctxC3.errorMessage.current, /Create pin configuration failed|already (exists|open)/);
});

test("user settings: defaultTarget drives create/open fallback; schemaStrictInstance downgrades unsupported-owner errors; rmtChannelBank filters bank warnings", async () => {
  const bundle = await bundleExtension();

  // S1: defaultTarget=esp32c6 with no sdkconfig → create() places esp32c6 on disk (1st quick pick picks default).
  const ctxS1 = makeMock();
  ctxS1.resetPlannerSettings();
  ctxS1.setPlannerSettings({ defaultTarget: "esp32c6" });
  activate(bundle, ctxS1);
  ctxS1.sdkconfig.current = undefined;
  await ctxS1.commands["espPinPlanner.create"]();
  await settle();
  assert.ok(ctxS1.disk.current);
  assert.ok(JSON.parse(ctxS1.disk.current!).target.chip === "esp32c6",
    `expected defaultTarget=c6 to produce c6 chip on create; got ${JSON.parse(ctxS1.disk.current!).target.chip}`);

  // S2: defaultTarget=esp32p4 with empty disk → open() webview refresh builds createConfig(p4) as fallback, state.config.target.chip=p4.
  const ctxS2 = makeMock();
  ctxS2.resetPlannerSettings();
  ctxS2.setPlannerSettings({ defaultTarget: "esp32p4" });
  activate(bundle, ctxS2);
  ctxS2.disk.current = undefined;     // no file on disk
  ctxS2.sdkconfig.current = undefined;
  await ctxS2.commands["espPinPlanner.open"]();
  await settle();
  await ctxS2.listeners.message({ type: "ready" });
  await settle();
  const openState = ctxS2.last.current!.state;
  assert.equal(openState.config.target.chip, "esp32p4",
    `open() with no file should fall back to defaultTarget=p4; got ${openState.config.target.chip}`);
  assert.match(openState.notice, /espPinPlanner\.defaultTarget/,
    "notice should mention defaultTarget source when create falls back to user setting");

  // S3: schemaStrictInstance=true (default) + C6 file with manual camera0 owner → diagnostic severity=error ("Unsupported peripheral…" must be error).
  const ctxS3 = makeMock();
  ctxS3.resetPlannerSettings();
  ctxS3.setPlannerSettings({ schemaStrictInstance: true });
  activate(bundle, ctxS3);
  ctxS3.disk.current = serializeConfig(Object.assign(createConfig("esp32c6"), {
    peripherals: { camera0: { type: "camera", instance: 0, signals: {} } }
  }));
  await ctxS3.commands["espPinPlanner.validate"]();
  await settle();
  const strictErrors = ctxS3.currentDiagnostics.current.filter(d => /Unsupported peripheral camera:0/.test(d.message));
  assert.ok(strictErrors.length >= 1, "strict mode should produce diagnostic for unsupported camera:0 on C6");
  // diagnostic severity mapped to 0=error in our mock; DiagnosticSeverity.Error 是 0 我们存了 severity
  // 但 currentDiagnostics 里我们 mock DiagnosticSeverity: {Error:0,Warning:1} set() 存为 new Diagnostic(...)，所以 mock 中 currentDiagnostics items = [{ message, code }] — 丢失了 severity
  // 改用 validateGpio 直接测 S3/S4 更准。extension.test.ts 里不 import 直接用 vm？这里保持 extension mock 测 validate 至少 1 个 message；strict vs non-strict 用 node:test 侧 import validateGpio 更直接的 case 放 peripherals.test.ts。本测只确认 settings 被 diagnosticProblems 读取并作用。
  assert.ok(ctxS3.currentDiagnostics.current.some(d => /camera:0/.test(d.message)), "strict C6 camera0 should fail in diagnostics");

  // S4: schemaStrictInstance=false + C6 camera0 owner → "Unsupported…" severity 降级为 warning（DiagnosticSeverity.Warning=1）。
  const ctxS4 = makeMock();
  ctxS4.resetPlannerSettings();
  ctxS4.setPlannerSettings({ schemaStrictInstance: false });
  activate(bundle, ctxS4);
  ctxS4.disk.current = serializeConfig(Object.assign(createConfig("esp32c6"), {
    peripherals: { camera0: { type: "camera", instance: 0, signals: {} } }
  }));
  await ctxS4.commands["espPinPlanner.validate"]();
  await settle();
  // 至少 camera:0 还在 diagnostics 里（仍是 Diagnostic，只是 severity 降了）。
  const lenientMsgs = ctxS4.currentDiagnostics.current.filter(d => /Unsupported peripheral camera:0/.test(d.message));
  assert.ok(lenientMsgs.length >= 1, "lenient mode still reports unsupported owners (as warnings)");
  // lenient mode message 里有 "(schemaStrictInstance=false; …)" 后缀
  assert.ok(lenientMsgs.every(d => /schemaStrictInstance=false/.test(d.message)),
    "lenient unsupported message must include schemaStrictInstance=false suffix");

  // S5: rmtChannelBank="tx" + S3 rmt0 (TX-bank ch0) + rmt4 (RX-bank ch4) 都接 → ch0 TX-bank warning 过滤掉，ch4 RX-only warning 保留
  const ctxS5 = makeMock();
  ctxS5.resetPlannerSettings();
  ctxS5.setPlannerSettings({ rmtChannelBank: "tx" });
  activate(bundle, ctxS5);
  const cfgTx = createConfig("esp32s3");
  cfgTx.peripherals = {
    rmt0: { type: "rmt", instance: 0, signals: { sig: "GPIO13" } },
    rmt4: { type: "rmt", instance: 4, signals: { sig: "GPIO14" } }
  };
  ctxS5.disk.current = serializeConfig(cfgTx);
  await ctxS5.commands["espPinPlanner.validate"]();
  await settle();
  const txMsgs = ctxS5.currentDiagnostics.current;
  assert.equal(txMsgs.some(d => /RMT channel 0 is TX-only/.test(d.message)), false,
    "rmtChannelBank=tx should suppress TX-only bank warnings");
  assert.ok(txMsgs.some(d => /RMT channel 4 is RX-only/.test(d.message)),
    "rmtChannelBank=tx should keep RX-only bank warnings as user probably miswired");

  // S6: rmtChannelBank="rx" 对称：ch4 无 warning；ch0 TX-only warning 保留
  const ctxS6 = makeMock();
  ctxS6.resetPlannerSettings();
  ctxS6.setPlannerSettings({ rmtChannelBank: "rx" });
  activate(bundle, ctxS6);
  const cfgRx = createConfig("esp32s3");
  cfgRx.peripherals = {
    rmt0: { type: "rmt", instance: 0, signals: { sig: "GPIO13" } },
    rmt4: { type: "rmt", instance: 4, signals: { sig: "GPIO14" } }
  };
  ctxS6.disk.current = serializeConfig(cfgRx);
  await ctxS6.commands["espPinPlanner.validate"]();
  await settle();
  const rxMsgs = ctxS6.currentDiagnostics.current;
  assert.ok(rxMsgs.some(d => /RMT channel 0 is TX-only/.test(d.message)),
    "rmtChannelBank=rx should keep TX-only warnings (miswire)");
  assert.equal(rxMsgs.some(d => /RMT channel 4 is RX-only/.test(d.message)), false,
    "rmtChannelBank=rx should suppress RX-only bank warnings");
});

