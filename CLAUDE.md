# Claude Changes - VS Code Extension

## Overview
A VS Code extension that reads Claude Code's checkpoint/rewind data and presents it in a visual panel for reviewing file changes, viewing diffs, and reverting.

## How Claude Code Checkpoints Work
- Claude Code creates file backups before each edit (Write/Edit/NotebookEdit tools only, NOT bash)
- Backups stored in `~/.claude/file-history/<session-uuid>/` as `<sha256-hash-prefix-16chars>@v<version>`
- Hash is `SHA-256(absolute_file_path).slice(0, 16)`
- File-to-hash mapping stored in session JSONL files at `~/.claude/projects/<project-dir>/<session-uuid>.jsonl`
- JSONL entries of type `file-history-snapshot` contain `trackedFileBackups` mapping file paths to backup filenames
- Project directory name: `absolutePath.replace(/[^a-zA-Z0-9]/g, "-")` — works cross-platform
- `backupFileName: null` means the file was newly created (no prior content)
- Checkpoints are file-copy snapshots, NOT git commits

## Architecture

### Source Files
- `src/extension.ts` — Entry point: registers providers, commands (diff, restore, delete, revert all), file watcher for auto-refresh
- `src/checkpointService.ts` — Core service: parses JSONL files, reads backups, filters unchanged files, cumulative changes, session parse cache
- `src/checkpointWebviewProvider.ts` — Main UI: styled webview with session cards, "All Changes" flat list, collapsible timeline, expand/collapse all, reverted state detection
- `src/snapshotContentProvider.ts` — Virtual document provider (`claude-checkpoint://` URI scheme) for viewing checkpoint file contents in VS Code diff editor

### Key Design Decisions
- **Webview over TreeView** — Switched from TreeView to WebviewView for full HTML/CSS control and better visual design
- **Cumulative + Timeline views** — "All Changes" shows flat list of all unique files (first backup vs current), "Timeline" shows per-checkpoint breakdown
- **Auto-detect reverted state** — Compares backup content with current file on disk at render time, no persistence needed
- **Async filtering with cache** — `filterUnchangedFiles` uses async reads with per-refresh content cache for performance
- **Session parse cache** — JSONL files are only re-parsed when their mtime changes
- **File watcher** — Uses `fs.watch()` (not VS Code's workspace watcher) since `~/.claude/` is outside the workspace. 500ms debounce.

### Commands
- `claudeChanges.refresh` — Manual refresh
- `claudeChanges.viewDiffData` — Open diff (checkpoint backup vs current file)
- `claudeChanges.restoreFileData` — Restore a modified file to its checkpoint state
- `claudeChanges.deleteFileData` — Delete a file that was created by Claude
- `claudeChanges.revertAllData` — Revert all files in a session (restore modified + delete created)

## Known Limitations
- Only tracks files changed via Write/Edit/NotebookEdit — bash changes (`sed`, `rm`, etc.) are NOT tracked by Claude Code
- File moves/renames are not detected — moved files will show as "reverted" at the original path
- Binary files are not checkpointed by Claude Code (text only)
- Checkpoint data may grow indefinitely (~14MB across 166 sessions observed)

## Build & Publish
```bash
npm run compile          # Build TypeScript
npx @vscode/vsce package # Create .vsix
```

### Marketplace
- Publisher: `FotisPanokis`
- Identifier: `fotispanokis.claude-changes`
- Upload new versions at: https://marketplace.visualstudio.com/manage/publishers/FotisPanokis
- Bump version in `package.json` before each upload

## Development History (v0.1.0 → v0.5.0)
1. **v0.1.0** — Initial release: TreeView with sessions → checkpoints → files, diff viewer, restore
2. **v0.2.0** — Switched to WebviewView with styled UI, added categories/keywords/icon for marketplace
3. **v0.3.0** — Added "All Changes" cumulative view, collapsible timeline, expand/collapse all, green dots timeline, relative time labels, session badges
4. **v0.4.0** — Added delete button for created files, Revert All handles both modified + created files, visual feedback (greyed out + "reverted" badge)
5. **v0.5.0** — Auto-detect reverted state at render time (survives VS Code restart), async file reads with caching, session parse cache, 500ms debounce
