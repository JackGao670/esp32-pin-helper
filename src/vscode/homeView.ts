import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { buildHomeModel, renderHomeHtml, type HomeModel } from "./homeModel";
import type { PlannerSettings } from "../config/userSettings";

/**
 * Webview view shown in the ESP Pin Planner activity bar container. It is the extension's
 * discoverable entry point: contributes no scripts, only status rows and `command:` links.
 * The provider only does I/O; all decision logic lives in the pure functions of homeModel.ts.
 */
export class PlannerHomeProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;

  constructor(private readonly readSettings: () => PlannerSettings) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: false, enableCommandUris: true };
    view.onDidDispose(() => { if (this.view === view) this.view = undefined; });
    void this.refresh();
  }

  async refresh(): Promise<void> {
    const view = this.view;
    if (!view) return;
    const model = await this.collect();
    view.description = model.folderName;
    view.webview.html = renderHomeHtml(model, { nonce: randomBytes(16).toString("hex") });
  }

  private async collect(): Promise<HomeModel> {
    const folders = vscode.workspace.workspaceFolders;
    const folder = folders?.length === 1 ? folders[0] : folders?.[0];
    const settings = this.readSettings();
    if (!folder) return buildHomeModel({ folderName: undefined, raw: undefined, settings });
    const uri = vscode.Uri.joinPath(folder.uri, ".pinconfig.json");
    const open = vscode.workspace.textDocuments.find(document => document.uri.toString() === uri.toString());
    let raw: string | undefined;
    if (open) raw = open.getText();
    else {
      try { raw = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8"); }
      catch (error) {
        if (error instanceof vscode.FileSystemError && error.code === "FileNotFound") return buildHomeModel({ folderName: folder.name, raw: undefined, settings });
        throw error;
      }
    }
    return buildHomeModel({ folderName: folder.name, raw, settings });
  }
}
