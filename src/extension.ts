import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  SnapshotContentProvider,
  SCHEME,
  buildCheckpointUri,
} from "./snapshotContentProvider";
import { CheckpointWebviewProvider } from "./checkpointWebviewProvider";
import { readBackupFile, findSessionsForWorkspace, getCumulativeChanges } from "./checkpointService";

const log = vscode.window.createOutputChannel("Claude Changes");

export function activate(context: vscode.ExtensionContext) {
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  log.appendLine(`Workspace path: ${workspacePath ?? "NONE"}`);

  // Register content provider for viewing checkpoint files
  const contentProvider = new SnapshotContentProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, contentProvider)
  );

  // Register webview provider
  const webviewProvider = new CheckpointWebviewProvider(
    workspacePath,
    (msg) => log.appendLine(msg)
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      CheckpointWebviewProvider.viewType,
      webviewProvider
    )
  );

  // Refresh command
  context.subscriptions.push(
    vscode.commands.registerCommand("claudeChanges.refresh", () => {
      webviewProvider.refresh();
    })
  );

  // Auto-refresh: watch the project's JSONL directory for changes
  if (workspacePath) {
    const projectDirName = workspacePath.replace(/[^a-zA-Z0-9]/g, "-");
    const projectDir = path.join(os.homedir(), ".claude", "projects", projectDirName);

    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    const debouncedRefresh = () => {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      debounceTimer = setTimeout(() => {
        log.appendLine("Auto-refresh: checkpoint data changed");
        webviewProvider.refresh();
      }, 500);
    };

    try {
      if (fs.existsSync(projectDir)) {
        const watcher = fs.watch(projectDir, (_eventType, filename) => {
          if (filename?.endsWith(".jsonl")) {
            debouncedRefresh();
          }
        });
        context.subscriptions.push({ dispose: () => watcher.close() });
        log.appendLine(`Watching for changes: ${projectDir}`);
      } else {
        const pollInterval = setInterval(() => {
          if (fs.existsSync(projectDir)) {
            clearInterval(pollInterval);
            const watcher = fs.watch(projectDir, (_eventType, filename) => {
              if (filename?.endsWith(".jsonl")) {
                debouncedRefresh();
              }
            });
            context.subscriptions.push({ dispose: () => watcher.close() });
            log.appendLine(`Watching for changes (delayed): ${projectDir}`);
          }
        }, 5000);
        context.subscriptions.push({ dispose: () => clearInterval(pollInterval) });
      }
    } catch (err: any) {
      log.appendLine(`File watcher error: ${err.message}`);
    }
  }

  // View diff command (from webview messages)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "claudeChanges.viewDiffData",
      async (
        sessionId: string,
        _filePath: string,
        absolutePath: string,
        backupFileName: string | null,
        version: number,
        backupTime: string
      ) => {
        log.appendLine(`viewDiffData: session=${sessionId}, absolutePath=${absolutePath}, backup=${backupFileName}, version=${version}`);
        const fileName = path.basename(absolutePath);
        const date = new Date(backupTime);
        const timeLabel = date.toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        });

        if (!backupFileName) {
          // Newly created file
          const currentUri = vscode.Uri.file(absolutePath);
          if (fs.existsSync(absolutePath)) {
            await vscode.commands.executeCommand(
              "vscode.diff",
              vscode.Uri.parse(`${SCHEME}:///empty/empty`),
              currentUri,
              `${fileName} (new file at ${timeLabel})`
            );
          } else {
            vscode.window.showInformationMessage(
              `File was created but no longer exists: ${absolutePath}`
            );
          }
          return;
        }

        const checkpointUri = buildCheckpointUri(
          sessionId,
          backupFileName,
          `${fileName} @ checkpoint`
        );
        const currentUri = vscode.Uri.file(absolutePath);

        if (fs.existsSync(absolutePath)) {
          await vscode.commands.executeCommand(
            "vscode.diff",
            checkpointUri,
            currentUri,
            `${fileName}: checkpoint v${version} (${timeLabel}) \u2194 current`
          );
        } else {
          const doc = await vscode.workspace.openTextDocument(checkpointUri);
          await vscode.window.showTextDocument(doc, { preview: true });
        }
      }
    )
  );

  // Restore file command (from webview messages)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "claudeChanges.restoreFileData",
      async (
        sessionId: string,
        absolutePath: string,
        backupFileName: string | null,
        version: number
      ) => {
        if (!backupFileName) {
          // File was created by Claude — offer to delete it
          vscode.commands.executeCommand(
            "claudeChanges.deleteFileData",
            absolutePath
          );
          return;
        }

        const confirm = await vscode.window.showWarningMessage(
          `Restore ${path.basename(absolutePath)} to checkpoint v${version}? This will overwrite the current file.`,
          { modal: true },
          "Restore"
        );

        if (confirm !== "Restore") {
          return;
        }

        const content = readBackupFile(sessionId, backupFileName);
        if (content === null) {
          vscode.window.showErrorMessage(
            `Could not read backup file: ${backupFileName}`
          );
          return;
        }

        try {
          const dir = path.dirname(absolutePath);
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
          }
          fs.writeFileSync(absolutePath, content, "utf-8");
          webviewProvider.markFileReverted(absolutePath);
          vscode.window.showInformationMessage(
            `Restored ${path.basename(absolutePath)} to checkpoint v${version}`
          );
        } catch (err: any) {
          vscode.window.showErrorMessage(
            `Failed to restore file: ${err.message}`
          );
        }
      }
    )
  );
  // Delete file command (for files created by Claude)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "claudeChanges.deleteFileData",
      async (absolutePath: string) => {
        log.appendLine(`deleteFileData called: ${absolutePath}`);
        const fileName = path.basename(absolutePath);

        if (!fs.existsSync(absolutePath)) {
          vscode.window.showInformationMessage(
            `${fileName} has already been deleted.`
          );
          return;
        }

        const confirm = await vscode.window.showWarningMessage(
          `Delete ${fileName}? This file was created by Claude and will be permanently deleted.`,
          { modal: true },
          "Delete"
        );

        if (confirm !== "Delete") {
          return;
        }

        try {
          fs.unlinkSync(absolutePath);
          webviewProvider.markFileReverted(absolutePath);
          const dir = path.dirname(absolutePath);
          const isEmpty = fs.readdirSync(dir).length === 0;
          const msg = isEmpty
            ? `Deleted ${fileName}. Note: the parent folder "${path.basename(dir)}/" is now empty and can be removed manually.`
            : `Deleted ${fileName}`;
          vscode.window.showInformationMessage(msg);
        } catch (err: any) {
          vscode.window.showErrorMessage(
            `Failed to delete file: ${err.message}`
          );
        }
      }
    )
  );

  // Revert All command
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "claudeChanges.revertAllData",
      async (sessionId: string) => {
        if (!workspacePath) {
          return;
        }

        const sessions = await findSessionsForWorkspace(workspacePath);
        const session = sessions.find((s) => s.sessionId === sessionId);
        if (!session) {
          vscode.window.showErrorMessage("Session not found.");
          return;
        }

        const files = getCumulativeChanges(session);
        const modified = files.filter((f) => f.backupFileName !== null);
        const created = files.filter(
          (f) => f.backupFileName === null && fs.existsSync(f.absolutePath)
        );

        if (modified.length === 0 && created.length === 0) {
          vscode.window.showInformationMessage("No files to revert.");
          return;
        }

        const parts: string[] = [];
        if (modified.length > 0) {
          parts.push(`restore ${modified.length} modified file${modified.length !== 1 ? "s" : ""}`);
        }
        if (created.length > 0) {
          parts.push(`delete ${created.length} created file${created.length !== 1 ? "s" : ""}`);
        }

        const confirm = await vscode.window.showWarningMessage(
          `Revert all changes? This will ${parts.join(" and ")}.`,
          { modal: true },
          "Revert All"
        );

        if (confirm !== "Revert All") {
          return;
        }

        let restored = 0;
        let deleted = 0;
        let failed = 0;

        for (const file of modified) {
          const content = readBackupFile(session.sessionId, file.backupFileName!);
          if (content === null) {
            failed++;
            continue;
          }
          try {
            const dir = path.dirname(file.absolutePath);
            if (!fs.existsSync(dir)) {
              fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(file.absolutePath, content, "utf-8");
            restored++;
          } catch {
            failed++;
          }
        }

        for (const file of created) {
          try {
            fs.unlinkSync(file.absolutePath);
            deleted++;
          } catch {
            failed++;
          }
        }

        const allPaths = [...modified, ...created].map((f) => f.absolutePath);
        webviewProvider.markAllReverted(sessionId, allPaths);

        const msgParts: string[] = [];
        if (restored > 0) { msgParts.push(`${restored} restored`); }
        if (deleted > 0) { msgParts.push(`${deleted} deleted`); }
        const msg = msgParts.join(", ");
        if (failed > 0) {
          vscode.window.showWarningMessage(`${msg}, ${failed} failed.`);
        } else {
          vscode.window.showInformationMessage(`Reverted: ${msg}.`);
        }
      }
    )
  );
}

export function deactivate() {}
