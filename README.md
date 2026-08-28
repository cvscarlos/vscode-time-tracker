<h1 align="center">Time Tracker nt</h1>

<div align="center">
  <img alt="Time Tracker nt" src="https://raw.githubusercontent.com/cvscarlos/vscode-time-tracker/main/images/og-banner.png" width="720" />
</div>

<p align="center">Automatic, offline-first coding-time tracking for VS Code — per <b>project</b> and <b>git branch</b> — delivered to <a href="https://www.solidtime.io">SolidTime</a> and/or <a href="https://timetagger.app">TimeTagger</a> (cloud or self-hosted).</p>

Tracks quietly in the background from **editor focus** — no start/stop buttons. Everything is buffered locally, so nothing is lost when you're offline or the server is down; it syncs when it can. Lightweight: minimal work on the editor thread, no heavy dependencies.

## How it works

- **Focus starts tracking** — no typing needed. A focused window with an open project counts as work, so reading code or watching a terminal counts just like editing.
- **Smart idle handling** — a focused-but-inactive window keeps counting up to a safety cap (default 5 min) then stops; the status bar flags it and lets you discard that idle time. A brief look-away (default 30s tolerance) won't fragment your time.
- **Project = your git repo, task = your git branch** — created automatically in the backend the first time they're needed (new SolidTime projects get a random color).
- **Clean, minute-accurate entries** — nearby intervals on the same project and branch are merged, rounded to whole minutes, and delivered a few minutes after you stop. Any window can flush another window's buffer; delivered copies are then purged locally.
- **Named after your work** — an entry starts titled with its branch, then is auto-renamed to the message of the commit that covers it. If it banked any idle time, the description notes the split — e.g. `fix: login form (12m focus, 3m idle)`.
- **At-a-glance status bar** — the current state (`tracking`, `idle`, `unfocused`, …), a count of not-yet-delivered entries, and a warning if delivery is failing. Your reports live in each backend's own web UI.

## Setup

Enable **SolidTime**, **TimeTagger**, or both — each is switched on just by setting its API token. With no token the extension still tracks locally; it delivers once you add one.

- **SolidTime** — create an API token (SolidTime → Profile Settings → **Create API Token**), then run **`Time Tracker nt: Set SolidTime Token`** and paste it. Self-hosted? Point `ntTimeTracker.solidtime.apiUrl` at your instance.
- **TimeTagger** — get an API token from your account settings, then run **`Time Tracker nt: Set TimeTagger Token`**. Self-hosted? Set `ntTimeTracker.timetagger.apiUrl`.

Tokens are kept in VS Code's encrypted SecretStorage (your OS keychain), never in plaintext. Then open a git repo and work — a few minutes after each stretch, an entry appears in every enabled backend under your repo and branch. Run the matching **Delete … Token** command to switch a backend off.

## Settings

- **`ntTimeTracker.enabled`** — turn tracking on or off. Default `true`.
- **`ntTimeTracker.solidtime.apiUrl`** — SolidTime server URL (cloud or self-hosted). Default `https://app.solidtime.io`.
- **`ntTimeTracker.solidtime.organizationId`** — SolidTime organization id; blank uses your first organization.
- **`ntTimeTracker.timetagger.apiUrl`** — TimeTagger server URL (public app or self-hosted). Default `https://timetagger.app`.
- **`ntTimeTracker.tracking.idleTimeoutSeconds`** — how long a focused window keeps counting with no editor activity before stopping (reading counts up to this cap). Default `300`.
- **`ntTimeTracker.tracking.focusLossToleranceSeconds`** — how long a brief look-away is tolerated before a segment closes. Default `30`.
- **`ntTimeTracker.tracking.minimumSegmentSeconds`** — intervals shorter than this are discarded. Default `20`.

## Commands

- **Set / Delete SolidTime Token**, **Set / Delete TimeTagger Token** — manage each backend.
- **Sync Now** — deliver settled entries immediately.
- **Pause** / **Resume** — stop or restart tracking.
- **Discard Current Idle Time** — drop the idle tail of the current segment (active work is kept).
- **Recolor Gray SolidTime Projects** — give your old default-gray projects random colors; projects you've colored yourself are untouched.
- **Show Output** — open the log.

## Privacy

Only **project and branch names, timestamps, durations, and the first line of the covering commit** (used as the entry title) are sent to the backends you enable — never your source code, file contents, or AI prompts. Each token stays in the OS keychain.
