<h1 align="center">Time Tracker nt</h1>

<div align="center">
  <img alt="Time Tracker nt" src="https://raw.githubusercontent.com/cvscarlos/vscode-time-tracker/main/images/og-banner.png" width="720" />
</div>

<p align="center">Automatic, offline-first coding-time tracking for VS Code — per <b>project</b> and <b>git branch</b> — that delivers your time to <a href="https://www.solidtime.io">SolidTime</a> and/or <a href="https://timetagger.app">TimeTagger</a> (cloud or self-hosted).</p>

It tracks quietly in the background based on **editor focus** (no manual start/stop), buffers everything locally so nothing is lost when you're offline or the server is down, and syncs when it can. Performance first: it does minimal work on the editor thread and has no heavy dependencies.

## How it works

- **Focus alone starts tracking** — no typing required. As soon as the focused VS Code window has a resolvable project, a work segment opens, so reading code or watching an AI agent's terminal output counts as work just like editing does.
- **Idle safety cap:** a focused window with no editor activity keeps counting for up to `ntTimeTracker.tracking.idleTimeoutSeconds` (default **5 min**) past your last activity, so a quiet reading stretch is still credited — it isn't dropped to zero. Once the cap is reached, tracking stops until you're active again, which opens a fresh segment.
- **Look-away tolerance:** losing window focus doesn't immediately stop tracking — the segment is held open for `ntTimeTracker.tracking.focusLossToleranceSeconds` (default **30s**) so a brief switch to another app or monitor doesn't fragment your time. The segment's end time is the moment focus was actually lost; if focus returns within the tolerance, tracking continues uninterrupted.
- **Project = your git repository** (or workspace folder); **task = your git branch**. In SolidTime, projects and tasks are created automatically the first time they're needed (new projects get a random color from SolidTime's palette); in TimeTagger, project and branch become `#tags` on the entry.
- **Local-first outbox with aggregation:** finished time intervals are written to a local outbox first. Nearby intervals on the same project and branch are merged and rounded to whole minutes, then delivered a few minutes after that work settles down — so what shows up in your tracker is clean, minute-accurate blocks rather than a stream of tiny fragments. If a backend is unreachable, everything waits locally; once delivered, local copies are purged. Any running window can deliver another window's buffered time.
- **Entries are named after your work:** a delivered entry starts out titled with the branch name, then is automatically renamed to the message of the commit that covers it, as soon as you commit.
- **Status bar** shows a small health indicator: `tracking`, `tracking (idle)` (focused but quiet for a while, still counting toward the cap), `tracking (grace)` (focus just lost, within the look-away tolerance, still counting), `idle` (focused, cap reached, stopped), `unfocused`, `paused`, or `off` — plus a count of not-yet-delivered intervals and a warning if delivery is failing. Your actual reports live in each backend's own web UI.
- **Discard idle time:** while the bar shows `tracking (idle)`, clicking it offers to trim the current segment back to your last real activity (your active work is kept) — also available as **`Time Tracker nt: Discard Current Idle Time`**. When not idle, clicking the status bar opens the output log.

## Setup

Time Tracker nt supports two independent delivery backends — **SolidTime** and **TimeTagger**. Each is enabled purely by setting its API token; you can enable one or both. If neither token is set, the extension still tracks locally (nothing is lost) but delivers nothing until a token is added.

**SolidTime:**

1. Get a SolidTime **API token**: SolidTime → Profile Settings → **Create API Token** (shown once).
2. In VS Code, run **`Time Tracker nt: Set SolidTime Token`** and paste it.
3. By default it targets **SolidTime Cloud** (`https://app.solidtime.io`). To use a self-hosted instance, set `ntTimeTracker.solidtime.apiUrl`. Nothing else changes.

**TimeTagger:**

1. Get a TimeTagger **API token** from your TimeTagger account settings.
2. In VS Code, run **`Time Tracker nt: Set TimeTagger Token`** and paste it.
3. By default it targets the public app (`https://timetagger.app`). To use a self-hosted instance, set `ntTimeTracker.timetagger.apiUrl`. Nothing else changes.

Tokens are stored in VS Code's encrypted **SecretStorage** (OS keychain) — never in settings or on disk in plaintext. Run **`Time Tracker nt: Delete SolidTime Token`** or **`Delete TimeTagger Token`** to disable that backend again; the other keeps working independently. Once at least one token is set, open a git repo and keep the window focused — a few minutes after you stop working on a stretch of code, a time entry appears in every enabled backend, under a project named after your repo with the task/tag set to your branch.

## Settings

| Setting                                            | Default                    | Description                                                                                                                                                   |
| -------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ntTimeTracker.enabled`                            | `true`                     | Enable tracking.                                                                                                                                              |
| `ntTimeTracker.solidtime.apiUrl`                   | `https://app.solidtime.io` | SolidTime base URL (cloud or self-hosted).                                                                                                                    |
| `ntTimeTracker.solidtime.organizationId`           | `""`                       | SolidTime organization id; blank uses your first organization.                                                                                                |
| `ntTimeTracker.timetagger.apiUrl`                  | `https://timetagger.app`   | TimeTagger base URL (public app or self-hosted).                                                                                                              |
| `ntTimeTracker.tracking.idleTimeoutSeconds`        | `300`                      | Safety cap: a focused window keeps counting with no editor activity up to this many seconds, then stops (reading counts up to the cap); any activity resumes. |
| `ntTimeTracker.tracking.focusLossToleranceSeconds` | `30`                       | Seconds a look-away is tolerated before the segment closes; the status bar shows "tracking (grace)" during it.                                                |
| `ntTimeTracker.tracking.minimumSegmentSeconds`     | `20`                       | Intervals shorter than this are discarded.                                                                                                                    |

## Commands

- **Time Tracker nt: Set SolidTime Token** / **Delete SolidTime Token**
- **Time Tracker nt: Set TimeTagger Token** / **Delete TimeTagger Token**
- **Time Tracker nt: Sync Now**
- **Time Tracker nt: Pause** / **Resume**
- **Time Tracker nt: Discard Current Idle Time**
- **Time Tracker nt: Recolor Gray SolidTime Projects** — recolors existing SolidTime projects still using the old default gray (`#6c7280`) with a random color from SolidTime's palette; projects you've colored yourself are left untouched. Behind a confirm prompt.
- **Time Tracker nt: Show Output**

## Privacy

The extension only ever sends **project/branch names, timestamps, durations, and the first line of the commit message that covers a given entry** (used as its title) to the backends you've enabled. It never sends source code, file contents, or AI prompts. Each API token stays in the OS keychain via VS Code SecretStorage.

## Status

Early (`0.x`). Tracking, aggregation, commit-title naming, and delivery to SolidTime and TimeTagger all work end-to-end. Planned next: optional AI-assist metadata and a dedicated reporting panel.
