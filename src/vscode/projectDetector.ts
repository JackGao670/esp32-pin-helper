import * as vscode from "vscode";
import { parseSdkconfigTarget } from "../core/model/project";

export async function detectTarget(folder: vscode.WorkspaceFolder): Promise<string | undefined> {
  const uri = vscode.Uri.joinPath(folder.uri, "sdkconfig");
  const document = vscode.workspace.textDocuments.find(document => document.uri.toString() === uri.toString());
  try {
    const text = document?.getText() ?? Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
    return parseSdkconfigTarget(text);
  } catch (error) {
    if (error instanceof vscode.FileSystemError && error.code === "FileNotFound") return undefined;
    throw error;
  }
}
