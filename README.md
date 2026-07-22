<h1 align="center">Time Tracker nt</h1>

<div align="center">
  <img alt="Time Tracker nt" src="https://raw.githubusercontent.com/cvscarlos/vscode-time-tracker/main/images/og-banner.png" width="720" />
</div>

<p align="center">Automatic, offline-first coding-time tracking for VS Code — per <b>project</b> and <b>git branch</b> — that delivers your time to <a href="https://www.solidtime.io">solidtime</a> and/or <a href="https://timetagger.app">TimeTagger</a> (cloud or self-hosted).</p>

It tracks quietly in the background based on **editor focus and activity** (no manual start/stop), buffers everything locally so nothing is lost when you're offline or the server is down, and syncs when it can. Performance first: it does minimal work on the editor thread and has no heavy dependencies.

## How it works

- **Tracks only the focused window**, only while you're active. A brief look-away doesn't stop tracking — losing focus only ends a work interval once it lasts longer than a short tolerance (~25 seconds by default), so switching to a second monitor or another app for a moment doesn't fragment your time.
- **Project = your git repository** (or workspace folder); **task = your git branch**. In solidtime, projects and tasks are created automatically the first time they're needed; in TimeTagger, project and branch become `#tags` on the entry.
- **Local-first outbox with aggregation:** finished time intervals are written to a local outbox first. Nearby intervals on the same project and branch are merged and rounded to whole minutes, then delivered a few minutes after that work settles down — so what shows up in your tracker is clean, minute-accurate blocks rather than a stream of tiny fragments. If a backend is unreachable, everything waits locally; once delivered, local copies are purged. Any running window can deliver another window's buffered time.
- **Entries are named after your work:** a delivered entry starts out titled with the branch name, then is automatically renamed to the message of the commit that covers it, as soon as you commit.
- **Status bar** shows a small health indicator only (tracking / idle / paused, a count of not-yet-delivered intervals, and a warning if delivery is failing). Your actual reports live in each backend's own web UI.

## Setup

Time Tracker nt supports two independent delivery backends — **solidtime** and **TimeTagger**. Each is enabled purely by setting its API token; you can enable one or both. If neither token is set, the extension still tracks locally (nothing is lost) but delivers nothing until a token is added.

**solidtime:**

1. Get a solidtime **API token**: solidtime → Profile Settings → **Create API Token** (shown once).
2. In VS Code, run **`Time Tracker nt: Set solidtime Token`** and paste it.
3. By default it targets **solidtime Cloud** (`https://app.solidtime.io`). To use a self-hosted instance, set `ntTimeTracker.solidtime.apiUrl`. Nothing else changes.

**TimeTagger:**

1. Get a TimeTagger **API token** from your TimeTagger account settings.
2. In VS Code, run **`Time Tracker nt: Set TimeTagger Token`** and paste it.
3. By default it targets the public app (`https://timetagger.app`). To use a self-hosted instance, set `ntTimeTracker.timetagger.apiUrl`. Nothing else changes.

Tokens are stored in VS Code's encrypted **SecretStorage** (OS keychain) — never in settings or on disk in plaintext. Run **`Time Tracker nt: Delete solidtime Token`** or **`Delete TimeTagger Token`** to disable that backend again; the other keeps working independently. Once at least one token is set, open a git repo and start coding — a few minutes after you stop working on a stretch of code, a time entry appears in every enabled backend, under a project named after your repo with the task/tag set to your branch.

## Settings

| Setting                                            | Default                    | Description                                                          |
| -------------------------------------------------- | -------------------------- | -------------------------------------------------------------------- |
| `ntTimeTracker.enabled`                            | `true`                     | Enable tracking.                                                     |
| `ntTimeTracker.solidtime.apiUrl`                   | `https://app.solidtime.io` | solidtime base URL (cloud or self-hosted).                           |
| `ntTimeTracker.solidtime.organizationId`           | `""`                       | solidtime organization id; blank uses your first organization.       |
| `ntTimeTracker.timetagger.apiUrl`                  | `https://timetagger.app`   | TimeTagger base URL (public app or self-hosted).                     |
| `ntTimeTracker.tracking.idleTimeoutSeconds`        | `120`                      | Idle timeout that ends a work interval.                              |
| `ntTimeTracker.tracking.focusLossToleranceSeconds` | `25`                       | Seconds a brief look-away is tolerated before a work segment closes. |
| `ntTimeTracker.tracking.minimumSegmentSeconds`     | `20`                       | Intervals shorter than this are discarded.                           |

## Commands

- **Time Tracker nt: Set solidtime Token** / **Delete solidtime Token**
- **Time Tracker nt: Set TimeTagger Token** / **Delete TimeTagger Token**
- **Time Tracker nt: Sync Now**
- **Time Tracker nt: Pause** / **Resume**
- **Time Tracker nt: Show Output**

## Privacy

The extension only ever sends **project/branch names, timestamps, durations, and the first line of the commit message that covers a given entry** (used as its title) to the backends you've enabled. It never sends source code, file contents, or AI prompts. Each API token stays in the OS keychain via VS Code SecretStorage.

## Status

Early (`0.x`). Tracking, aggregation, commit-title naming, and delivery to solidtime and TimeTagger all work end-to-end. Planned next: optional AI-assist metadata and a dedicated reporting panel.
