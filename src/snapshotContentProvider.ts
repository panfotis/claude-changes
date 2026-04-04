import * as vscode from "vscode";
import { readBackupFile } from "./checkpointService";

/**
 * URI scheme: claude-checkpoint:///<sessionId>/<backupFileName>?label=<displayLabel>
 */
export const SCHEME = "claude-checkpoint";

export class SnapshotContentProvider
  implements vscode.TextDocumentContentProvider
{
  private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  provideTextDocumentContent(uri: vscode.Uri): string {
    const parts = uri.path.split("/").filter(Boolean);
    if (parts.length < 2) {
      return "";
    }

    const sessionId = parts[0];
    const backupFileName = parts[1];

    const content = readBackupFile(sessionId, backupFileName);
    return content ?? "";
  }
}

/**
 * Build a URI for viewing a checkpoint backup file.
 */
export function buildCheckpointUri(
  sessionId: string,
  backupFileName: string,
  displayLabel: string
): vscode.Uri {
  return vscode.Uri.parse(
    `${SCHEME}:///${sessionId}/${backupFileName}`
  ).with({ query: displayLabel });
}
