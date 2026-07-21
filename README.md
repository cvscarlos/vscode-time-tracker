# Time Tracker nt

Automatic, offline-first coding-time tracking for VS Code — per **project** and **git branch** — that delivers your time to a [solidtime](https://www.solidtime.io) instance (cloud or self-hosted).

It tracks quietly in the background based on **editor focus and activity** (no manual start/stop), buffers everything locally so nothing is lost when you're offline or the server is down, and syncs when it can. Performance first: it does minimal work on the editor thread and has no heavy dependencies.

## How it works

- **Tracks only the focused window**, only while you're active; pauses the instant a window loses focus.
- **Project = your git repository** (or workspace folder); **task = your git branch**. Projects and tasks are created in solidtime automatically the first time they're needed.
- **Local-first outbox:** finished time intervals are written to a local outbox and delivered to solidtime in the background. If the server is unreachable, they wait; once delivered, local copies are purged. Any running window can deliver another window's buffered time.
- **Status bar** shows a small health indicator only (tracking / idle / paused, a count of not-yet-delivered intervals, and a warning if delivery is failing). Your actual reports live in solidtime's web UI.

## Setup

1. Install the extension.
2. Get a solidtime **API token**: solidtime → Profile Settings → **Create API Token** (shown once).
3. In VS Code, run **`Time Tracker nt: Set solidtime API Token`** and paste it. The token is stored in VS Code's encrypted **SecretStorage** (OS keychain) — never in settings or on disk in plaintext.
4. That's it — open a git repo and start coding. Within a few minutes a time entry appears in solidtime under a project named after your repo, with the task set to your branch.

By default it targets **solidtime Cloud** (`https://app.solidtime.io`). To use a self-hosted instance, set `ntTimeTracker.solidtime.apiUrl`. Nothing else changes.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `ntTimeTracker.enabled` | `true` | Enable tracking. |
| `ntTimeTracker.solidtime.apiUrl` | `https://app.solidtime.io` | solidtime base URL (cloud or self-hosted). |
| `ntTimeTracker.solidtime.organizationId` | `""` | solidtime organization id; blank uses your first organization. |
| `ntTimeTracker.tracking.idleTimeoutSeconds` | `120` | Idle timeout that ends a work interval. |
| `ntTimeTracker.tracking.focusLossGraceMilliseconds` | `250` | Grace before a blur counts as focus loss (avoids flicker). |
| `ntTimeTracker.tracking.minimumSegmentSeconds` | `20` | Intervals shorter than this are discarded. |

## Commands

- **Time Tracker nt: Set solidtime API Token**
- **Time Tracker nt: Sync Now**
- **Time Tracker nt: Pause** / **Resume**
- **Time Tracker nt: Show Output**

## Privacy

The extension only ever sends **project/branch names, timestamps, and durations** to your solidtime instance. It never sends source code, file contents, or AI prompts. The API token stays in the OS keychain via VS Code SecretStorage.

## Status

Early (`0.x`). Tracking + solidtime delivery work. Planned next: git-commit annotations and optional AI-assist metadata.
