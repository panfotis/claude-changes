import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import {
  SessionInfo,
  Snapshot,
  FileBackup,
  findSessionsForWorkspace,
  getCumulativeChanges,
  readBackupFile,
} from "./checkpointService";

export class CheckpointWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "claudeChanges";
  private _view?: vscode.WebviewView;
  private _revertedFiles = new Set<string>();

  constructor(
    private workspacePath: string | undefined,
    private log?: (msg: string) => void
  ) {}

  refresh(): void {
    if (this._view) {
      this._updateContent(this._view.webview);
    }
  }

  markFileReverted(absolutePath: string): void {
    this._revertedFiles.add(absolutePath);
    this._view?.webview.postMessage({
      command: "markReverted",
      absolutePath,
    });
  }

  markAllReverted(sessionId: string, absolutePaths: string[]): void {
    for (const p of absolutePaths) {
      this._revertedFiles.add(p);
    }
    this._view?.webview.postMessage({
      command: "markAllReverted",
      sessionId,
    });
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
    };

    webviewView.webview.onDidReceiveMessage((message) => {
      switch (message.command) {
        case "viewDiff":
          vscode.commands.executeCommand(
            "claudeChanges.viewDiffData",
            message.sessionId,
            message.filePath,
            message.absolutePath,
            message.backupFileName,
            message.version,
            message.backupTime
          );
          break;
        case "restoreFile":
          vscode.commands.executeCommand(
            "claudeChanges.restoreFileData",
            message.sessionId,
            message.absolutePath,
            message.backupFileName,
            message.version
          );
          break;
        case "revertAll":
          vscode.commands.executeCommand(
            "claudeChanges.revertAllData",
            message.sessionId
          );
          break;
        case "deleteFile":
          vscode.commands.executeCommand(
            "claudeChanges.deleteFileData",
            message.absolutePath
          );
          break;
      }
    });

    this._updateContent(webviewView.webview);
  }

  private async _updateContent(webview: vscode.Webview): Promise<void> {
    if (!this.workspacePath) {
      webview.html = this._getEmptyHtml("No workspace folder open");
      return;
    }

    const sessions = await findSessionsForWorkspace(this.workspacePath, this.log);

    if (sessions.length === 0) {
      webview.html = this._getEmptyHtml("No Claude checkpoints found for this workspace");
      return;
    }

    webview.html = this._getHtml(sessions);
  }

  private _getEmptyHtml(message: string): string {
    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 16px; display: flex; align-items: center; justify-content: center; min-height: 200px; }
  .empty { text-align: center; opacity: 0.6; font-size: 12px; }
  .empty-icon { font-size: 32px; margin-bottom: 8px; }
</style></head>
<body><div class="empty"><div class="empty-icon">&#x1f50d;</div>${message}</div></body></html>`;
  }

  private _getHtml(sessions: SessionInfo[]): string {
    const sessionsHtml = sessions.map((s, si) => this._renderSession(s, si)).join("");

    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: transparent;
    padding: 0 4px 8px 4px;
    line-height: 1.4;
  }

  /* ── Toolbar ── */
  .toolbar {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 2px;
    padding: 6px 4px;
    position: sticky;
    top: 0;
    z-index: 10;
    background: var(--vscode-sideBar-background);
  }

  .toolbar-btn {
    background: none;
    border: none;
    color: var(--vscode-foreground);
    cursor: pointer;
    padding: 3px 6px;
    border-radius: 4px;
    font-size: 11px;
    opacity: 0.6;
    transition: opacity 0.1s, background 0.1s;
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .toolbar-btn:hover {
    opacity: 1;
    background: var(--vscode-toolbar-hoverBackground);
  }
  .toolbar-btn svg { width: 14px; height: 14px; }

  /* ── Session Card ── */
  .session {
    margin-bottom: 12px;
    border-radius: 6px;
    background: var(--vscode-sideBar-background);
    border: 1px solid var(--vscode-panel-border, transparent);
    overflow: hidden;
  }

  .session-header {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 10px 12px;
    cursor: pointer;
    user-select: none;
    transition: background 0.15s;
  }
  .session-header:hover {
    background: var(--vscode-list-hoverBackground);
  }

  .session-chevron {
    flex-shrink: 0;
    width: 16px;
    height: 16px;
    margin-top: 2px;
    transition: transform 0.2s ease;
    opacity: 0.7;
  }
  .session.collapsed .session-chevron {
    transform: rotate(-90deg);
  }

  .session-info { flex: 1; min-width: 0; }

  .session-title {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    font-weight: 600;
    color: var(--vscode-foreground);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .session-dot {
    flex-shrink: 0;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--vscode-gitDecoration-addedResourceForeground, #73c991);
  }

  .relative-time {
    font-weight: 600;
    color: var(--vscode-textLink-foreground);
  }

  .session-meta {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 3px;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
  }

  .badge {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 1px 6px;
    border-radius: 9px;
    font-size: 10px;
    font-weight: 500;
    background: color-mix(in srgb, var(--vscode-foreground) 12%, transparent);
    color: var(--vscode-descriptionForeground);
  }
  .badge.files {
    background: color-mix(in srgb, var(--vscode-gitDecoration-addedResourceForeground, #73c991) 20%, transparent);
    color: var(--vscode-gitDecoration-addedResourceForeground, #73c991);
  }

  .session-body {
    max-height: 5000px;
    overflow: hidden;
    transition: max-height 0.3s ease, opacity 0.2s ease;
    opacity: 1;
    background: color-mix(in srgb, var(--vscode-foreground) 4%, transparent);
  }
  .session.collapsed .session-body {
    max-height: 0;
    opacity: 0;
  }

  /* ── Section Label ── */
  .section-label {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--vscode-descriptionForeground);
    padding: 8px 12px 4px 12px;
  }

  /* ── Cumulative Files ── */
  .cumulative-files {
    padding: 0 6px 6px 6px;
  }

  /* ── Timeline Toggle ── */
  .timeline-toggle {
    margin: 4px 6px 6px 6px;
  }

  .timeline-toggle-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 8px;
    cursor: pointer;
    user-select: none;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 500;
    color: var(--vscode-descriptionForeground);
    transition: background 0.1s;
  }
  .timeline-toggle-header:hover {
    background: var(--vscode-list-hoverBackground);
  }

  .timeline-toggle-chevron {
    width: 12px;
    height: 12px;
    transition: transform 0.2s ease;
    opacity: 0.6;
  }
  .timeline-toggle.collapsed .timeline-toggle-chevron {
    transform: rotate(-90deg);
  }

  .timeline-toggle-body {
    max-height: 5000px;
    overflow: hidden;
    transition: max-height 0.3s ease, opacity 0.2s ease;
    opacity: 1;
  }
  .timeline-toggle.collapsed .timeline-toggle-body {
    max-height: 0;
    opacity: 0;
  }

  /* ── Timeline ── */
  .timeline {
    padding: 8px 12px 10px 12px;
    margin: 0 6px 6px 6px;
    position: relative;
    background: color-mix(in srgb, var(--vscode-foreground) 5%, transparent);
    border-radius: 5px;
  }

  .checkpoint {
    position: relative;
    padding-left: 22px;
    padding-bottom: 6px;
  }
  .checkpoint:last-child { padding-bottom: 0; }

  /* Vertical line */
  .checkpoint::before {
    content: '';
    position: absolute;
    left: 5px;
    top: 16px;
    bottom: -2px;
    width: 1px;
    background: var(--vscode-gitDecoration-addedResourceForeground, #73c991);
    opacity: 0.3;
  }
  .checkpoint:last-child::before { display: none; }

  /* Dot */
  .checkpoint::after {
    content: '';
    position: absolute;
    left: 2px;
    top: 8px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--vscode-gitDecoration-addedResourceForeground, #73c991);
    z-index: 1;
  }

  .checkpoint-header {
    display: flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
    user-select: none;
    padding: 3px 6px;
    margin-left: -6px;
    border-radius: 4px;
    transition: background 0.1s;
  }
  .checkpoint-header:hover {
    background: var(--vscode-list-hoverBackground);
  }

  .checkpoint-time {
    font-size: 11px;
    font-weight: 600;
    color: var(--vscode-foreground);
    transition: color 0.15s;
  }
  .checkpoint-header:hover .checkpoint-time {
    color: var(--vscode-textLink-foreground);
  }

  .checkpoint-count {
    font-size: 10px;
    padding: 0 5px;
    border-radius: 8px;
    background: color-mix(in srgb, var(--vscode-gitDecoration-addedResourceForeground, #73c991) 20%, transparent);
    color: var(--vscode-gitDecoration-addedResourceForeground, #73c991);
  }

  .checkpoint-chevron {
    width: 12px;
    height: 12px;
    transition: transform 0.2s ease;
    opacity: 0.5;
  }
  .checkpoint.collapsed .checkpoint-chevron {
    transform: rotate(-90deg);
  }

  .checkpoint-files {
    max-height: 500px;
    overflow: hidden;
    transition: max-height 0.25s ease, opacity 0.15s ease;
    opacity: 1;
    margin-top: 2px;
  }
  .checkpoint.collapsed .checkpoint-files {
    max-height: 0;
    opacity: 0;
  }

  /* ── File Items ── */
  .file-item {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 6px;
    border-radius: 4px;
    cursor: pointer;
    transition: background 0.1s;
    font-size: 12px;
  }
  .file-item:hover {
    background: var(--vscode-list-hoverBackground);
  }

  .file-item.reverted {
    opacity: 0.45;
    pointer-events: none;
  }
  .file-item.reverted .file-name {
    text-decoration: line-through;
  }
  .file-item.reverted .file-actions {
    display: none;
  }
  .reverted-badge {
    font-size: 9px;
    padding: 0 5px;
    border-radius: 8px;
    background: color-mix(in srgb, var(--vscode-gitDecoration-addedResourceForeground, #73c991) 20%, transparent);
    color: var(--vscode-gitDecoration-addedResourceForeground, #73c991);
    font-weight: 600;
  }

  .file-icon {
    flex-shrink: 0;
    width: 16px;
    height: 16px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 10px;
    font-weight: 700;
    border-radius: 3px;
  }
  .file-icon.added {
    color: var(--vscode-gitDecoration-addedResourceForeground, #73c991);
  }
  .file-icon.modified {
    color: var(--vscode-gitDecoration-modifiedResourceForeground, #e2c08d);
  }

  .file-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--vscode-foreground);
  }
  .file-path {
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 120px;
  }

  .file-actions {
    display: flex;
    gap: 2px;
    flex-shrink: 0;
  }

  .action-btn {
    background: none;
    border: none;
    color: var(--vscode-foreground);
    cursor: pointer;
    padding: 2px 4px;
    border-radius: 3px;
    font-size: 12px;
    opacity: 0.6;
    transition: opacity 0.1s, background 0.1s;
  }
  .action-btn:hover {
    opacity: 1;
    background: var(--vscode-toolbar-hoverBackground);
  }

  /* ── Revert All Button ── */
  .revert-all-btn {
    margin-left: auto;
    background: none;
    border: 1px solid color-mix(in srgb, var(--vscode-foreground) 20%, transparent);
    color: var(--vscode-foreground);
    cursor: pointer;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 10px;
    font-family: var(--vscode-font-family);
    opacity: 0.7;
    transition: opacity 0.1s, background 0.1s;
  }
  .revert-all-btn:hover {
    opacity: 1;
    background: var(--vscode-toolbar-hoverBackground);
  }

  /* ── Scrollbar ── */
  ::-webkit-scrollbar { width: 6px; }
  ::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background); border-radius: 3px; }
  ::-webkit-scrollbar-thumb:hover { background: var(--vscode-scrollbarSlider-hoverBackground); }
</style>
</head>
<body>
  <div class="toolbar">
    <button class="toolbar-btn" id="expandAll" title="Expand All">
      <svg viewBox="0 0 16 16" fill="currentColor"><path d="M9 9H4v1h5V9zm0-4H4v1h5V5zm3-3H1v11h11V2zm-1 10H2V3h9v9zm2-12v1h1v11H4v-1H3v2h12V0h-2z"/></svg>
      <span>Expand</span>
    </button>
    <button class="toolbar-btn" id="collapseAll" title="Collapse All">
      <svg viewBox="0 0 16 16" fill="currentColor"><path d="M14 1H3L2 2v11l1 1h11l1-1V2l-1-1zM8 11H4v-1h4v1zm3-4H4V6h7v1z"/></svg>
      <span>Collapse</span>
    </button>
  </div>
  ${sessionsHtml}
  <script>
    const vscode = acquireVsCodeApi();

    // Session toggle
    document.querySelectorAll('.session-header').forEach(el => {
      el.addEventListener('click', () => {
        el.closest('.session').classList.toggle('collapsed');
      });
    });

    // Checkpoint toggle
    document.querySelectorAll('.checkpoint-header').forEach(el => {
      el.addEventListener('click', () => {
        el.closest('.checkpoint').classList.toggle('collapsed');
      });
    });

    // Timeline toggle
    document.querySelectorAll('.timeline-toggle-header').forEach(el => {
      el.addEventListener('click', () => {
        el.closest('.timeline-toggle').classList.toggle('collapsed');
      });
    });

    // Expand all
    document.getElementById('expandAll').addEventListener('click', () => {
      document.querySelectorAll('.session.collapsed').forEach(el => el.classList.remove('collapsed'));
      document.querySelectorAll('.timeline-toggle.collapsed').forEach(el => el.classList.remove('collapsed'));
      document.querySelectorAll('.checkpoint.collapsed').forEach(el => el.classList.remove('collapsed'));
    });

    // Collapse all
    document.getElementById('collapseAll').addEventListener('click', () => {
      document.querySelectorAll('.session:not(.collapsed)').forEach(el => el.classList.add('collapsed'));
      document.querySelectorAll('.timeline-toggle:not(.collapsed)').forEach(el => el.classList.add('collapsed'));
      document.querySelectorAll('.checkpoint:not(.collapsed)').forEach(el => el.classList.add('collapsed'));
    });

    // File click -> diff
    document.querySelectorAll('.file-item').forEach(el => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('.action-btn')) return;
        vscode.postMessage({
          command: 'viewDiff',
          sessionId: el.dataset.sessionId,
          filePath: el.dataset.filePath,
          absolutePath: el.dataset.absolutePath,
          backupFileName: el.dataset.backupFileName || null,
          version: parseInt(el.dataset.version),
          backupTime: el.dataset.backupTime
        });
      });
    });

    // Restore button
    document.querySelectorAll('.restore-btn').forEach(el => {
      el.addEventListener('click', () => {
        const fi = el.closest('.file-item');
        vscode.postMessage({
          command: 'restoreFile',
          sessionId: fi.dataset.sessionId,
          absolutePath: fi.dataset.absolutePath,
          backupFileName: fi.dataset.backupFileName || null,
          version: parseInt(fi.dataset.version)
        });
      });
    });

    // Delete button (for created files)
    document.querySelectorAll('.delete-btn').forEach(el => {
      el.addEventListener('click', () => {
        const fi = el.closest('.file-item');
        vscode.postMessage({
          command: 'deleteFile',
          absolutePath: fi.dataset.absolutePath
        });
      });
    });

    // Revert All button
    document.querySelectorAll('.revert-all-btn').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({
          command: 'revertAll',
          sessionId: el.dataset.sessionId
        });
      });
    });
    // Listen for messages from extension (mark reverted)
    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.command === 'markReverted') {
        document.querySelectorAll('.file-item').forEach(el => {
          if (el.dataset.absolutePath === msg.absolutePath && !el.classList.contains('reverted')) {
            el.classList.add('reverted');
            const actions = el.querySelector('.file-actions');
            if (actions) {
              actions.insertAdjacentHTML('beforebegin', '<span class="reverted-badge">reverted</span>');
            }
          }
        });
      }
      if (msg.command === 'markAllReverted') {
        document.querySelectorAll('.file-item').forEach(el => {
          if (el.closest('.session')?.querySelector('[data-session-id="' + msg.sessionId + '"]') && !el.classList.contains('reverted')) {
            el.classList.add('reverted');
            const actions = el.querySelector('.file-actions');
            if (actions) {
              actions.insertAdjacentHTML('beforebegin', '<span class="reverted-badge">reverted</span>');
            }
          }
        });
      }
    });
  </script>
</body></html>`;
  }

  private _renderSession(session: SessionInfo, index: number): string {
    const date = session.lastActivity;
    const dateStr = date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
    const timeStr = date.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    const title = this._escapeHtml(
      session.firstUserMessage || session.slug || session.sessionId.slice(0, 8)
    );
    const totalFiles = new Set(
      session.snapshots.flatMap((s) => s.files.map((f) => f.filePath))
    ).size;

    const collapsed = index > 0 ? " collapsed" : "";

    // Cumulative changes: all unique files, first backup per file
    const cumulativeFiles = getCumulativeChanges(session);
    const cumulativeHtml = cumulativeFiles
      .map((f) => this._renderFileItem(session, f, "cumulative"))
      .join("");

    // Timeline checkpoints
    const checkpointsHtml = [...session.snapshots]
      .reverse()
      .map((snap, i) =>
        this._renderCheckpoint(session, snap, session.snapshots.length - 1 - i)
      )
      .join("");

    return `
      <div class="session${collapsed}">
        <div class="session-header">
          <svg class="session-chevron" viewBox="0 0 16 16" fill="currentColor">
            <path d="M5.7 13.7L5 13l4.6-4.6L5 3.7l.7-.7 5.3 5.3-5.3 5.4z"/>
          </svg>
          <div class="session-info">
            <div class="session-title"><span class="session-dot"></span>${title}</div>
            <div class="session-meta">
              <span class="relative-time">${this._relativeTime(date)}</span>
              <span>${dateStr}, ${timeStr}</span>
            </div>
            <div class="session-meta">
              <span class="badge">${session.snapshots.length} checkpoint${session.snapshots.length !== 1 ? "s" : ""}</span>
              <span class="badge files">${totalFiles} file${totalFiles !== 1 ? "s" : ""}</span>
            </div>
          </div>
        </div>
        <div class="session-body">
          <div class="timeline-toggle">
            <div class="timeline-toggle-header">
              <svg class="timeline-toggle-chevron" viewBox="0 0 16 16" fill="currentColor">
                <path d="M5.7 13.7L5 13l4.6-4.6L5 3.7l.7-.7 5.3 5.3-5.3 5.4z"/>
              </svg>
              <span>All Changes</span>
              <span class="badge files">${totalFiles} file${totalFiles !== 1 ? "s" : ""}</span>
              <button class="revert-all-btn" data-session-id="${session.sessionId}" title="Revert all files to before this session">&#x21A9; Revert All</button>
            </div>
            <div class="timeline-toggle-body">
              <div class="cumulative-files">
                ${cumulativeHtml}
              </div>
            </div>
          </div>
          <div class="timeline-toggle collapsed">
            <div class="timeline-toggle-header">
              <svg class="timeline-toggle-chevron" viewBox="0 0 16 16" fill="currentColor">
                <path d="M5.7 13.7L5 13l4.6-4.6L5 3.7l.7-.7 5.3 5.3-5.3 5.4z"/>
              </svg>
              <span>Timeline</span>
              <span class="badge">${session.snapshots.length} checkpoint${session.snapshots.length !== 1 ? "s" : ""}</span>
            </div>
            <div class="timeline-toggle-body">
              <div class="timeline">
                ${checkpointsHtml}
              </div>
            </div>
          </div>
        </div>
      </div>`;
  }

  private _renderCheckpoint(
    session: SessionInfo,
    snapshot: Snapshot,
    index: number
  ): string {
    const date = new Date(snapshot.timestamp);
    const timeStr = date.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });

    const filesHtml = snapshot.files
      .map((f) => this._renderFileItem(session, f, "checkpoint"))
      .join("");

    return `
      <div class="checkpoint collapsed">
        <div class="checkpoint-header">
          <svg class="checkpoint-chevron" viewBox="0 0 16 16" fill="currentColor">
            <path d="M5.7 13.7L5 13l4.6-4.6L5 3.7l.7-.7 5.3 5.3-5.3 5.4z"/>
          </svg>
          <span class="checkpoint-time">#${index + 1} &middot; ${timeStr}</span>
          <span class="checkpoint-count">${snapshot.files.length} file${snapshot.files.length !== 1 ? "s" : ""}</span>
        </div>
        <div class="checkpoint-files">
          ${filesHtml}
        </div>
      </div>`;
  }

  private _renderFileItem(
    session: SessionInfo,
    f: FileBackup,
    mode: "cumulative" | "checkpoint"
  ): string {
    const fileName = path.basename(f.absolutePath);
    const dirName = path.dirname(f.filePath);
    const isNew = f.backupFileName === null;
    const iconClass = isNew ? "added" : "modified";
    const iconChar = isNew ? "A" : "M";
    let isReverted = this._revertedFiles.has(f.absolutePath);
    if (!isReverted) {
      if (isNew) {
        // Created file: reverted if it no longer exists
        isReverted = !fs.existsSync(f.absolutePath);
      } else {
        // Modified file: reverted if backup matches current file
        try {
          const backup = readBackupFile(session.sessionId, f.backupFileName!);
          const current = fs.existsSync(f.absolutePath)
            ? fs.readFileSync(f.absolutePath, "utf-8")
            : null;
          isReverted = backup !== null && backup === current;
        } catch {
          // On error, assume not reverted
        }
      }
    }

    const actionBtn = isReverted
      ? `<span class="reverted-badge">reverted</span>`
      : isNew
        ? `<button class="action-btn delete-btn" title="Delete (file created by Claude)">&#x1F5D1;</button>`
        : `<button class="action-btn restore-btn" title="Restore">&#x21A9;</button>`;
    const revertedClass = isReverted ? " reverted" : "";

    return `
      <div class="file-item${revertedClass}"
        data-session-id="${session.sessionId}"
        data-file-path="${this._escapeAttr(f.filePath)}"
        data-absolute-path="${this._escapeAttr(f.absolutePath)}"
        data-backup-file-name="${this._escapeAttr(f.backupFileName ?? "")}"
        data-version="${f.version}"
        data-backup-time="${f.backupTime}"
        data-mode="${mode}">
        <span class="file-icon ${iconClass}">${iconChar}</span>
        <span class="file-name">${this._escapeHtml(fileName)}</span>
        ${dirName && dirName !== "." ? `<span class="file-path">${this._escapeHtml(dirName)}</span>` : ""}
        <div class="file-actions">
          ${actionBtn}
        </div>
      </div>`;
  }

  private _relativeTime(date: Date): string {
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    const isToday =
      date.getDate() === now.getDate() &&
      date.getMonth() === now.getMonth() &&
      date.getFullYear() === now.getFullYear();

    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const isYesterday =
      date.getDate() === yesterday.getDate() &&
      date.getMonth() === yesterday.getMonth() &&
      date.getFullYear() === yesterday.getFullYear();

    if (isToday) { return "Today"; }
    if (isYesterday) { return "Yesterday"; }
    if (diffDays < 7) { return `${diffDays}d ago`; }
    if (diffDays < 30) { return `${Math.floor(diffDays / 7)}w ago`; }
    return `${Math.floor(diffDays / 30)}mo ago`;
  }

  private _escapeHtml(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  private _escapeAttr(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  }
}
