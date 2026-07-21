<h1 align="center">Time Tracker nt</h1>

<div align="center">
  <img alt="Time Tracker nt" src="https://raw.githubusercontent.com/cvscarlos/vscode-time-tracker/main/images/og-banner.png" width="720" />
</div>

<p align="center">Automatic, offline-first coding-time tracking for VS Code — per <b>project</b> and <b>git branch</b> — that delivers your time to a <a href="https://www.solidtime.io">solidtime</a> instance (cloud or self-hosted).</p>

It tracks quietly in the background based on **editor focus and activity** (no manual start/stop), buffers everything locally so nothing is lost when you're offline or the server is down, and syncs when it can. Performance first: it does minimal work on the editor thread and has no heavy dependencies.

## How it works

- **Tracks only the focused window**, only while you're active. A brief look-away doesn't stop tracking — losing focus only ends a work interval once it lasts longer than a short tolerance (~25 seconds by default), so switching to a second monitor or another app for a moment doesn't fragment your time.
- **Project = your git repository** (or workspace folder); **task = your git branch**. Projects and tasks are created in solidtime automatically the first time they're needed.
- **Local-first outbox with aggregation:** finished time intervals are written to a local outbox first. Nearby intervals on the same project and branch are merged and rounded to whole minutes, then delivered to solidtime a few minutes after that work settles down — so what shows up in solidtime is clean, minute-accurate blocks rather than a stream of tiny fragments. If the server is unreachable, everything waits locally; once delivered, local copies are purged. Any running window can deliver another window's buffered time.
- **Entries are named after your work:** a delivered entry starts out titled with the branch name, then is automatically renamed to the message of the commit that covers it, as soon as you commit.
- **Status bar** shows a small health indicator only (tracking / idle / paused, a count of not-yet-delivered intervals, and a warning if delivery is failing). Your actual reports live in solidtime's web UI.

## Setup

1. Install the extension.
2. Get a solidtime **API token**: solidtime → Profile Settings → **Create API Token** (shown once).
3. In VS Code, run **`Time Tracker nt: Set solidtime API Token`** and paste it. The token is stored in VS Code's encrypted **SecretStorage** (OS keychain) — never in settings or on disk in plaintext.
4. That's it — open a git repo and start coding. A few minutes after you stop working on a stretch of code, a time entry appears in solidtime under a project named after your repo, with the task set to your branch.

By default it targets **solidtime Cloud** (`https://app.solidtime.io`). To use a self-hosted instance, set `ntTimeTracker.solidtime.apiUrl`. Nothing else changes.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `ntTimeTracker.enabled` | `true` | Enable tracking. |
| `ntTimeTracker.solidtime.apiUrl` | `https://app.solidtime.io` | solidtime base URL (cloud or self-hosted). |
| `ntTimeTracker.solidtime.organizationId` | `""` | solidtime organization id; blank uses your first organization. |
| `ntTimeTracker.tracking.idleTimeoutSeconds` | `120` | Idle timeout that ends a work interval. |
| `ntTimeTracker.tracking.focusLossToleranceSeconds` | `25` | Seconds a brief look-away is tolerated before a work segment closes. |
| `ntTimeTracker.tracking.minimumSegmentSeconds` | `20` | Intervals shorter than this are discarded. |

## Commands

- **Time Tracker nt: Set solidtime API Token**
- **Time Tracker nt: Sync Now**
- **Time Tracker nt: Pause** / **Resume**
- **Time Tracker nt: Show Output**

## Privacy

The extension only ever sends **project/branch names, timestamps, durations, and the first line of the commit message that covers a given entry** (used as its title) to your solidtime instance. It never sends source code, file contents, or AI prompts. The API token stays in the OS keychain via VS Code SecretStorage.

## Status

Early (`0.x`). Tracking, aggregation, commit-title naming, and solidtime delivery all work end-to-end. Planned next: optional AI-assist metadata and a dedicated reporting panel.
