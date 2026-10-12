import * as vscode from "vscode";
import { diagnosticProblems, type LocatedProblem } from "./diagnosticModel";
import { readSettings, type PlannerSettings } from "../config/userSettings";

export class PinDiagnostics implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection("esp-pin-planner");
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly generations = new Map<string, number>();
  private disposed = false;
  private report(error: unknown): void { console.error("ESP Pin Planner diagnostics:", error); }
  private update(uri: vscode.Uri): void { void this.refresh(uri).catch(error => this.report(error)); }
  private readSettings(): PlannerSettings {
    try { return readSettings({}, vscode.workspace); }
    catch { return readSettings({}); }
  }

  constructor() {
    const watcher = vscode.workspace.createFileSystemWatcher("**/.pinconfig.json");
    this.subscriptions.push(watcher,
      watcher.onDidCreate(uri => this.update(uri)),
      watcher.onDidChange(uri => this.update(uri)),
      watcher.onDidDelete(uri => this.remove(uri)),
      vscode.workspace.onDidOpenTextDocument(document => {
        if (this.isConfig(document.uri)) this.update(document.uri);
      }),
      vscode.workspace.onDidChangeTextDocument(event => {
        if (this.isConfig(event.document.uri)) this.update(event.document.uri);
      }),
      vscode.workspace.onDidCloseTextDocument(document => {
        if (this.isConfig(document.uri)) this.update(document.uri);
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => { this.collection.clear(); void this.scan().catch(error => this.report(error)); }));
    void this.scan().catch(error => this.report(error));
  }

  private isConfig(uri: vscode.Uri): boolean {
    return uri.path.endsWith("/.pinconfig.json") && Boolean(vscode.workspace.getWorkspaceFolder(uri));
  }

  private remove(uri: vscode.Uri): void {
    const key = uri.toString();
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
    this.collection.delete(uri);
  }

  private async scan(): Promise<void> {
    const uris = await vscode.workspace.findFiles("**/.pinconfig.json", "**/node_modules/**");
    if (this.disposed) return;
    await Promise.all(uris.map(uri => this.refresh(uri)));
  }

  async refresh(uri: vscode.Uri, requireExisting = false): Promise<LocatedProblem[]> {
    if (this.disposed) return [];
    const key = uri.toString();
    const generation = (this.generations.get(key) ?? 0) + 1;
    this.generations.set(key, generation);
    try {
      const document = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === key);
      const text = document?.getText() ?? Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
      const problems = diagnosticProblems(text, this.readSettings());
      // A slower file read must not replace newer editor diagnostics or resurrect a deleted file.
      if (this.generations.get(key) !== generation) return problems;
      if (!vscode.workspace.getWorkspaceFolder(uri)) { this.collection.delete(uri); return problems; }
      const lineStarts = [0];
      for (let index = 0; index < text.length; index++) if (text[index] === "\n") lineStarts.push(index + 1);
      const positionAt = (offset: number) => {
        offset = Math.max(0, Math.min(text.length, offset));
        let low = 0, high = lineStarts.length;
        while (low + 1 < high) {
          const middle = Math.floor((low + high) / 2);
          if (lineStarts[middle] <= offset) low = middle; else high = middle;
        }
        return new vscode.Position(low, offset - lineStarts[low]);
      };
      this.collection.set(uri, problems.map(problem => {
        const diagnostic = new vscode.Diagnostic(
          new vscode.Range(positionAt(problem.offset), positionAt(problem.offset + problem.length)),
          problem.message,
          problem.severity === "error" ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning
        );
        diagnostic.source = "ESP Pin Planner";
        diagnostic.code = problem.gpio === undefined ? "configuration" : `GPIO${problem.gpio}`;
        return diagnostic;
      }));
      return problems;
    } catch (error) {
      if (this.generations.get(key) === generation) this.collection.delete(uri);
      if (!requireExisting && error instanceof vscode.FileSystemError && error.code === "FileNotFound") return [];
      throw error;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.generations.clear();
    this.subscriptions.forEach(subscription => subscription.dispose());
    this.collection.dispose();
  }
}
