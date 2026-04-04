# Claude Changes

Review all file changes made by Claude Code sessions with diffs and one-click revert.

## Features

- **Session overview** — See all Claude Code sessions for your workspace, sorted by most recent
- **All Changes view** — Flat list of every file Claude touched in a session, with cumulative diffs (before Claude vs current)
- **Timeline view** — Step-by-step checkpoint breakdown showing what changed at each point
- **One-click diffs** — Click any file to see the diff between the checkpoint backup and the current file
- **Restore files** — Revert individual files or all files at once to their pre-session state
- **Auto-refresh** — Panel updates automatically when Claude creates new checkpoints
- **Cross-platform** — Works on Linux, macOS, and Windows

## How It Works

Claude Code automatically creates file backups (checkpoints) before editing files. This extension reads that checkpoint data and presents it in a visual panel so you can review what Claude changed and revert if needed.

## Usage

1. Open a project where you've used Claude Code
2. Click the eye icon in the activity bar to open the Claude Changes panel
3. Expand a session to see all files that were changed
4. Click a file to view the diff
5. Use the restore button to revert individual files, or "Revert All" to undo an entire session

## Requirements

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) must be installed and used at least once in your project

## Disclaimer

This is an independent community extension and is **not affiliated with, endorsed by, or associated with Anthropic** or the official Claude Code project. It simply reads the checkpoint data that Claude Code creates locally on your machine.
