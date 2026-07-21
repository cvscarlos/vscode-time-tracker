# Architecture — VS Code Time Tracker (solidtime backend)

> Living design notes for the extension. Captures the goal, the decisions made during brainstorming, and the open questions. This is not an implementation plan — it is the reference we build the spec from.
>
> **Note on the repo name:** the project is still named `vscode-clockify-time-tracker` for historical reasons, but the chosen backend is **solidtime** (self-hosted), not Clockify. Rename is cosmetic and non-blocking.

## 1. Goal

A VS Code extension that **automatically tracks coding time per project and branch, buffers it in a centralized local outbox, and delivers it to a [solidtime](https://github.com/solidtime-io/solidtime) instance when reachable**. It keeps working with the server down or no internet, and never loses time across a VS Code restart or crash. **The server is the source of truth / report / backup; local storage is a temporary outbox that is purged once data is confirmed delivered.**

Core behaviors the user wants:

- Track automatically, no manual start/stop.
- Track only the VS Code window currently in focus; pause a window the instant it loses focus (the user runs multiple VS Code windows/projects at once).
- Associate time with the active workspace, Git repository, and branch.
- **Local-first and fully offline-capable:** never lose time because the server is stopped, restarting, or unreachable — including across a VS Code restart/crash. Buffer to a centralized on-disk outbox; deliver when the server is on; **purge local data after a confirmed successful send.**
- **Any running window can drain the shared outbox** — even data from a project whose window crashed and is never reopened gets delivered by some other running instance.
- **No server-side or heartbeat inference of duration** — the extension decides exactly what counts (precise focus-based intervals) and ships finished intervals.
- **Dev-machine performance over everything.** This must never be the extension a developer disables because VS Code feels slow. Low write cadence, minimal main-thread work, no heavy dependencies.
- solidtime's modern web UI for reviewing working hours per project.
- Optionally use commit messages as entry notes / per-commit entries (later, opt-in).

## 2. Backend decision — solidtime

**Chosen backend: solidtime (self-hosted).**

Why, against the alternatives evaluated (Clockify Free, Wakapi, TimeTagger, Kimai, ActivityWatch):

- **Best UI + real data model** — modern SaaS-like interface with first-class **projects / tasks / clients / tags / billable**, which maps cleanly to repo→project, branch→task. The user's primary stated goal is a cool UI to see hours per project.
- **Interval-based** — you POST exact `start`/`end` entries, so precise focus-based tracking is honored with no server-side inference (unlike Wakapi's heartbeat density).
- **Local-first / offline compatible** — solidtime accepts finished entries; it does not need to be always-on. The extension buffers to disk and flushes when reachable.
- **No API quota** — it's the user's own server, so the entire Clockify-style rate-budget design is unnecessary.
- **Runs on modest self-hosted hardware** (if self-hosting) — a low-power box with a weak CPU is enough for a single user. Estimated footprint idle ≈ 0.5–0.9 GB RAM, light single-user ≈ 0.8–1.5 GB; the CPU is the limiting factor but fine for single-user bursty load. **Recommended: disable the Gotenberg/PDF service** (the heaviest component) unless PDF export is needed. _(Largely moot for v1, which targets Cloud Free.)_

### Deployment is a config choice, not a design choice

The extension is **deployment-agnostic**: cloud and self-hosted expose the **same API and UI**, so the only difference is the `apiUrl` setting and which token is pasted. No code changes to switch.

- **solidtime Cloud — Free "Solo" plan:** 1 user; includes clients/projects/tags/tasks, billable rates, reporting. **API access is available on Free** — tokens are created per-user under Profile Settings → Create API Token, with no plan gating. (Paid "Professional" adds teams, invoicing, PDF/shareable reports, rounding — not API access.) **Cloud rate limit = 200 req/min** (verified via `x-ratelimit-limit` on a real call) — ~12k/hour, far above our batched usage; no budget machinery needed.
- **Self-hosted:** no rate limit, full data ownership, works on LAN; costs maintenance + always-on hosting.

**Recommendation:** start on **Cloud Free** (zero infra, validate fast); self-host later if a limit is hit or full data ownership is wanted — a two-setting change. The extension only ever sends project/branch names, timestamps, durations, and (later, opt-in) commit message first lines — never source code or AI prompts.

### Reference: the existing community extension

**[0pandadev/solidtime-vscode](https://github.com/0pandadev/solidtime-vscode)** proves the solidtime API works and is a useful **API-layer reference**, but does **not** meet our requirements and will **not** be forked. Its gaps: state is **in-memory only** (loses time on restart while offline), it uses a **heartbeat accumulator** (counts gaps up to a 15-min idle as work — the inference we reject), it has **no branch/task, no commit messages, no multi-window coordination** (module-level state, entry-ID collisions), and it stores the **API key in plaintext settings**. We build our own and lift only its proven API calls.

### solidtime REST surface (from the reference extension)

- Auth: `Authorization: Bearer <token>`, `Accept: application/json`.
- `GET /api/v1/users/me` → user id.
- `GET /api/v1/users/me/memberships` → organizations.
- `GET /api/v1/organizations/{org}/members` → resolve **`member_id`** (match on user id). Required on every entry.
- `GET|POST /api/v1/organizations/{org}/projects` → list / create project.
- `GET|POST /api/v1/organizations/{org}/tasks` → list / create task (**org-scoped**, not project-nested; the task carries `project_id`). Verified against Cloud.
- `GET /api/v1/organizations/{org}/time-entries?start=&end=` → list (used for reconciliation).
- `POST /api/v1/organizations/{org}/time-entries` — body `{ member_id, start, end, duration, billable, project_id, task_id?, description, tags[] }`.
- `PUT /api/v1/organizations/{org}/time-entries/{id}` — update.

## 3. Design principles

> **1. Dev-machine performance first.** Nothing the tracker does may make the editor feel slow. Debounced signals, a low (60 s) write cadence, small synchronous writes, no native/heavy dependencies, negligible startup cost. If a feature and performance conflict, performance wins.
>
> **2. Track precisely locally; deliver opportunistically.** The extension records exact focus-based intervals to a centralized local outbox and delivers them to solidtime whenever it is reachable. Server availability never affects the accuracy or completeness of tracking, and no data is lost across a restart or crash.
>
> **3. Local is a temporary outbox, not a ledger.** The server is the source of truth, report, and backup. Local data exists only until it is confirmed delivered, then it is purged. Local storage is sized and reasoned about as a queue of undelivered work, not an archive.

## 4. Reference extensions (feature sources)

- **Simple Coding Time Tracker** — https://github.com/twentyTwo/vsc-ext-coding-time-tracker
  Borrow: session state machine, activity/inactivity detection, project+branch attribution, local-first persistence, status-bar summaries, local history/filtering/export, splitting sessions on project/branch change. Improve: use built-in Git extension events instead of polling.
- **WakaTime** — https://github.com/wakatime/vscode-wakatime
  Borrow: event-driven activity _signals_, debouncing/dedup, offline buffering, project+branch context, activity classification. Do **not** copy server-side duration inference — we ship exact intervals.
- **Clockify Timer** — https://github.com/gbrlstr/clockify-timer
  Borrow: command/UX patterns, status-bar + (later) TreeView navigation, error handling. Do **not** copy live-timer, plaintext key storage, or IDE-open/close autostart.
- **solidtime-vscode** — API-layer reference only (see §2).

## 5. Two-layer architecture + connectors

The extension is two decoupled layers:

**Layer 1 — Tracker (backend-agnostic).** Turns VS Code signals into precise local work segments. Activity sources: editor edits/cursor/save, active-editor + workspace changes, tasks/debug, **Git branch and commits**, and **terminal / AI interactions**. Owns the state machine and the **centralized outbox store** (behind a `Store` interface). Knows nothing about any server.

**Layer 2 — Sync connectors.** Drains undelivered segments from the outbox and pushes them to a time-tracker server through a small **`TimeSyncConnector` interface**, then marks them delivered so the outbox can purge them. Connectors are pluggable; **Solidtime is the first and currently only connector.**

```ts
interface TimeSyncConnector {
	resolveOrCreateProject(workspaceKey, name): Promise<projectId>;
	resolveOrCreateTask(projectId, branch): Promise<taskId>;
	createEntry(entry): Promise<backendEntryId>;
	updateEntry(id, entry): Promise<void>;
	findEntryByMarker(marker, timeRange): Promise<id | null>; // reconciliation
}
```

Concrete implementation: `solidtimeConnector` (resolves + caches `member_id`, embeds the idempotency marker per §8). A different server would be a new connector with **no change to Layer 1**.

### 5a. Centralized outbox + atomic claim

- **One shared folder.** `context.globalStorageUri` is shared across all windows of the extension, so every window reads/writes the same outbox. There is no per-window read filtering — a fresh or crashed-and-reopened window sees everything undelivered.
- **Writes stay per-window-file to avoid contention.** Each window appends its own live segments to its own file (named by a per-process id) so two windows never write the same file concurrently. Reads and delivery span **all** files.
- **Delivery claims atomically.** Before sending a segment, the delivering instance claims it via an atomic filesystem operation (e.g. `rename` into a `claimed/` area, or a claim marker written with `wx`/exclusive create). Only the winner sends; a stale claim (owner died mid-send) is reclaimable after a timeout. This replaces a leader election with per-item claiming.
- **Purge after delivery.** A delivered segment is removed from the outbox. **Compaction** (the "VACUUM"): periodically rewrite a window's file dropping delivered segments, and delete fully-drained/renamed files. Data volume is tiny, so compaction is cheap.
- **A `Store` interface** hides all of this from the tracker and the sync engine: `append(segment)`, `listUndelivered()`, `claim(id): boolean`, `markDelivered(id)`, `compact()`, `recover()` (adopt orphaned in-progress segments at their last checkpoint). SQLite could implement the same interface later.

### Activity-source status

| Source                                 | Layer-1 role                 | First-cycle implementation                    |
| -------------------------------------- | ---------------------------- | --------------------------------------------- |
| Editor / cursor / save / active-editor | activity signal              | ✅ pass 1                                     |
| Tasks / debug                          | activity signal              | ✅ pass 1                                     |
| Terminal interactions                  | activity signal              | ✅ pass 1 (shell-execution / terminal events) |
| Git branch                             | segment attribution (→ task) | ✅ pass 1                                     |
| Git commits                            | enrichment (description)     | ⏳ later (deferred)                           |
| AI interactions                        | classification metadata      | ⏳ later (deferred, opt-in)                   |

## 6. Decisions locked (brainstorming)

1. **Backend = solidtime.** **v1 targets solidtime Cloud Free ("Solo")**; self-hosted is the documented fallback, reachable by changing only `apiUrl` + token (no code change). See §2.
2. **First delivery cycle = local tracking core + solidtime sync.** Git commit enrichment (commit messages, per-commit entries) and AI-activity metadata are deferred.
   2a. **Config namespace = `cvsTimeTracker.*`.** The short `cvs` prefix avoids clashing with other extensions; the name is **independent of the sync connector**. Tracker settings live under `cvsTimeTracker.tracking.*`; connector settings under their own sub-namespace, e.g. `cvsTimeTracker.solidtime.apiUrl` / `cvsTimeTracker.solidtime.organizationId`, with the token in `context.secrets` keyed `cvsTimeTracker.solidtime.apiToken`. Commands share the `cvsTimeTracker.` prefix. _(Say the word if you'd rather the namespace be plain `cvs.*`.)_
3. **Multi-window focus: per-window local only.** Each window tracks while focused (`onDidChangeWindowState`), stops on blur. No focus lease file — the OS enforces single-window focus.
4. **Centralized outbox, any-instance drain — no leader.** All windows share one outbox in `context.globalStorageUri` (already shared per-extension across windows). Any running window may drain and deliver _any_ undelivered segment — so a crashed project's data is delivered by whatever instance is alive. To prevent two windows double-sending the same segment, delivery **atomically claims** a segment before sending (see §5a). No elected leader.
5. **Storage: centralized non-native outbox (files + index), behind a `Store` interface.** Chosen over SQLite: a native SQLite module (`better-sqlite3`) risks an Electron-ABI mismatch that fails extension activation — the worst "developer disables it" outcome, and the data volume (a few writes/minute) does not need a DB. SQLite (or `node:sqlite` when stable in the VS Code runtime) stays a future swap behind the same interface. **API token in `context.secrets`** (never settings.json); server URL + org id in settings.
6. **Entry granularity: one entry per contiguous focus-based work block** (exact intervals; short-gap merge deferred to the sync/aggregation layer). No rollups — no quota to protect.
7. **Offline-first, purge-after-delivery.** Segments persist to the outbox immediately and stay there until solidtime confirms delivery, then are **purged** (they are undelivered work, not an archive). The outbox survives restarts, crashes, server downtime, and no-internet. **Provisioning and sending happen at delivery time (online)** — tracking offline records `workspaceKey`/`branch`, and project/task are resolved/created only when the server is reachable.
8. **Idempotency:** each segment has a stable UUID; the entry `description` carries a marker `[vsc:<segmentId>]`. On successful create, record delivery and purge locally. On an ambiguous failure (POST may have landed), keep the segment claimed-but-undelivered and, on the next online run, `findEntryByMarker` within the segment's time range before deciding to create — prevents duplicates after a crash.
9. **Performance budget.** Checkpoint/write cadence **60 s** (was 30 s); debounce activity signals; do only trivial synchronous work on VS Code event handlers; no heavy or native dependencies; keep activation cost negligible.

## 6a. Consciously rejected (do not re-litigate)

Two independent analyses of the community extension recommend a **shared focus-owner lease** and a **single sync coordinator/leader**. We deliberately do **not** adopt either:

- **No focus lease.** The double-counting those analyses warn about is a symptom of the _heartbeat-inference_ model (computing duration from a stale timestamp across a focus gap). Our design closes a precise segment on blur and never derives an interval from an old timestamp, so the bug cannot occur. The OS focuses one window at a time and each window observes its own focus/blur — per-window tracking is already correct.
- **No sync coordinator/leader.** Instead of electing a leader over a shared store, any instance drains the centralized outbox and claims each segment atomically before sending (§5a). Per-item claiming + per-segment idempotency (§8) prevent duplicates without a leader.

If a real duplication or race is ever observed in practice, revisit; until then, simpler wins.

## 7. Deferred to later cycles

- Git commit enrichment: commit messages in `description`, split-on-commit, per-commit entries (opt-in).
- AI-vs-human activity metadata (as a `#ai-assisted` tag).
- Full TreeView reporting panel (first cycle may ship status bar + commands only).
- Local export (CSV/JSON), diagnostics bundle.
- Client assignment / billable-rate configuration beyond a default.

## 8. Open questions

Resolved against Cloud (2026-07-21): task API is org-scoped `GET/POST /organizations/{org}/tasks` with `project_id` in the body; rate limit is 200 req/min; `member_id` resolves via `/organizations/{org}/members` matched on the user id. Remaining, non-blocking design choices for pass 2:

- **Provisioning race mitigation** — search-before-create + atomic mapping cache is enough for a single user (200/min headroom); no file lock needed.
- **Flush policy** — when to attempt sync (segment finalize, focus loss, every N minutes, on server-back-online). No quota pressure; just avoid needless chatter.
- **Server-reachability detection** — cheap probe vs. attempt-and-backoff on the real request.
- **Project/task naming + slugging** — templates for project name (repo remote → name) and branch→task name (branches with `/`, detached HEAD).

## 9. Proposed module layout (first-cycle scope)

```text
src/
  extension.ts
  tracker/              # LAYER 1 — backend-agnostic
    activity/           # activityCollector, sessionStateMachine, focusController
    context/            # workspaceResolver, gitProvider (branch; commits later); terminal source
    storage/            # store.ts (Store interface), fileOutboxStore, recovery, compaction
  connectors/           # LAYER 2 — sync connectors
    connector.ts        # TimeSyncConnector interface
    syncEngine.ts       # drains + claims from the outbox, delivers, marks delivered
    solidtime/          # solidtimeConnector, entityProvisioner, descriptionBuilder, mappingStore
  ui/                   # statusBar (health indicator only: liveness + pending count + sync-error), commands
  configuration/        # settings, secrets
```

The status bar is a **health indicator only** — a liveness dot (tracking / paused / unfocused), the count of undelivered segments, and a warning when delivery is failing. **No totals** — per-project reporting lives in solidtime's web UI.

## 10. Activity state machine

States: `Disabled`, `PausedManually`, `Unfocused`, `FocusedIdle`, `Tracking`, `Syncing`.

Key transitions:

- Window gains focus → `FocusedIdle`; qualifying activity (edit/cursor/save/task/debug) → `Tracking`.
- No qualifying activity for idle timeout → close segment, `FocusedIdle`.
- Window loses focus → close segment immediately (after a small focus-loss grace to avoid flicker), `Unfocused`.
- Workspace/repo/branch change → close current segment; new context resolves a new task lazily at sync time.
- Shutdown → persist current segment synchronously to the journal.

Default timings (tunable): idle timeout 120s, focus-loss grace 250ms, minimum segment 20s, **checkpoint/write cadence 60s** (performance budget, §3). Short-gap merge is deferred to the sync/aggregation layer.

## 11. Identity & mapping

- **Resolve context by the active document's workspace folder**, not `workspaceFolders[0]` — the latter misattributes multi-root workspaces (a bug in the reference extension). Fall back to the single/first folder only when there is no active editor.
- **Workspace identity order** (stable project key): normalized Git remote (`host/owner/repo`) → repo-root path hash → workspace-file URI → workspace-folder URI. (Two repos can both be named `backend`.)
- **Project name templates:** default repo name; collision `owner/repo`; no-git → workspace-folder name; multi-root → `workspace / folder`.
- **Branch → task** by default. Detached HEAD → `detached/<short-hash>`; no repo → no task.
- **Provisioning is lazy, online-only, and cached forever:** at flush time resolve `workspaceKey` → check local mapping cache → search solidtime by name → reuse if found (carrying our marker) else create → store id in the shared mapping cache → never re-search unless the server returns 404 or the user requests remap.

## 12. Tooling & conventions (matches the reference extension `vscode-send-to-terminal`)

- TypeScript **strict**, module `Node16`, target `ES2022`, `outDir: out`, `rootDir: src`.
- **ESLint + `eslint-plugin-unicorn` + Prettier** (`eslint-config-prettier` last). _(Unicorn is new vs. the reference; the rest matches.)_
- Prettier: `useTabs: true`, `singleQuote: true`, `semi: true`, `trailingComma: es5`, `printWidth: 100`.
- Tests: Mocha via `@vscode/test-cli` / `@vscode/test-electron`.
- Packaging: `@vscode/vsce`, output to `tmp/`. Node 22 (`.nvmrc`). Compile with `tsc` (not Bun/esbuild — matches your other extension).

## 13. Test focus (first cycle)

State-machine and storage: focus gain/loss, rapid window switching, switching to another app, idle timeout, activity just before idle, workspace/branch changes, multi-root, detached HEAD, crash/restart recovery. Outbox: a fresh window sees **all** windows' undelivered segments (centralized read), atomic claim prevents two windows double-sending, orphaned in-progress segments recovered at last checkpoint, delivered segments purged/compacted. Sync: offline operation (server down / no internet) buffering, **no data loss across a restart/crash**, drain-on-reconnect, lazy provisioning at delivery time, idempotent behavior after an ambiguous POST (reconciliation by marker → no duplicates), auth failure and server error handling, member-id resolution.
