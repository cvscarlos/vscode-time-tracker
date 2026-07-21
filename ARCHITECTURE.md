# Architecture — VS Code Time Tracker (solidtime backend)

> Living design notes for the extension. Captures the goal, the decisions made during brainstorming, and the open questions. This is not an implementation plan — it is the reference we build the spec from.
>
> **Naming:** repo/folder `vscode-time-tracker`; marketplace publisher `nokotata`; config/command namespace `ntTimeTracker.*`. Backend is **solidtime** via a pluggable connector (the earlier "clockify" name is retired).

## 1. Goal

A VS Code extension that **automatically tracks coding time per project and branch, buffers it in a centralized local outbox, and delivers it to a [solidtime](https://github.com/solidtime-io/solidtime) instance when reachable**. It keeps working with the server down or no internet, and never loses time across a VS Code restart or crash. **The server is the source of truth / report / backup; local storage is a temporary outbox that is purged once data is confirmed delivered.**

Core behaviors the user wants:

- Track automatically, no manual start/stop.
- Track only the VS Code window currently in focus; tolerate a brief look-away (a short focus-loss grace period, §10) without pausing, but pause a window that stays unfocused (the user runs multiple VS Code windows/projects at once).
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

### solidtime REST surface (verified against Cloud + the first-party desktop client)

- Auth: **personal API token** via `Authorization: Bearer <token>`, `Accept: application/json`. (The first-party desktop app uses OAuth2 PKCE instead — better UX, much more work; a possible future enhancement, not v1.)
- `GET /api/v1/users/me` → `{ data: { id, name, email, timezone, ... } }`.
- `GET /api/v1/users/me/memberships` → `{ data: [{ id, organization: { id, name, currency }, role }] }`. **`membership.id` IS the `member_id`** required on every entry — no separate `/members` lookup needed.
- `GET|POST /api/v1/organizations/{org}/projects` — create body `{ name, color, is_billable, billable_rate?, client_id?, is_public? }`. **`client_id` must be present (nullable — `null` works, no named client needed) and `color` must be lowercase hex** (e.g. `#6c7280`); omitting `client_id` or sending an uppercase hex color → 422.
- `GET|POST /api/v1/organizations/{org}/tasks` — **org-scoped** (not project-nested); create body `{ name, project_id, estimated_time? }`.
- `GET /api/v1/organizations/{org}/time-entries` — list (reconciliation; supports `member_id`/date filters).
- `POST /api/v1/organizations/{org}/time-entries` — body `{ member_id, start, end?, billable, project_id?, task_id?, description?, tags? }` → `{ data: { id, ... } }`. **No `duration`** — the server derives it from `start`/`end`. `end` omitted = a running entry (not our case; we send finished intervals with both). **Dates must be `Y-m-d\TH:i:s\Z` — no milliseconds** (strip the `.000` before sending; a millisecond-bearing date → 422), including the `?start=` filter on the list endpoint above.
- `PUT /api/v1/organizations/{org}/time-entries/{id}` — update; **accepts a description-only body** (used to retitle a delivered entry to its covering commit, §6 item 10, without touching start/end/project/task). **No bulk-create endpoint** (single POST per entry; fine at 200 req/min). No server-side idempotency key — we add our own `[vsc:<segmentId>]` description marker + reconciliation (§8).

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
	resolveMember(): Promise<{ organizationId; memberId }>;
	findProjectByName(organizationId, name): Promise<projectId | null>;
	createProject(organizationId, name): Promise<projectId>;
	findTaskByName(organizationId, projectId, name): Promise<taskId | null>;
	createTask(organizationId, projectId, name): Promise<taskId>;
	listEntryMarkers(organizationId, memberId, sinceIso): Promise<Set<segmentId>>; // reconciliation
	createEntry(organizationId, memberId, entry): Promise<entryId>;
	updateEntryDescription(organizationId, entryId, description): Promise<void>; // commit-title retitle
}
```

Concrete implementation: `SolidtimeConnector` (the REST calls of §2). Project/task lookup-or-create and the resolved-id cache live one layer up, in `syncEngine.ts` + `mappingStore.ts` — the connector itself is a thin, stateless REST client. A different server would be a new connector with **no change to Layer 1**.

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
| Git commits                            | enrichment (retitle to covering commit) | ✅ pass 4                          |
| AI interactions                        | classification metadata      | ⏳ later (deferred, opt-in)                   |

## 6. Decisions locked (brainstorming)

1. **Backend = solidtime.** **v1 targets solidtime Cloud Free ("Solo")**; self-hosted is the documented fallback, reachable by changing only `apiUrl` + token (no code change). See §2.
2. **First delivery cycle = local tracking core + solidtime sync.** Commit-message enrichment shipped in pass 4 as **retitling an already-delivered entry to its covering commit** (see item 10) — per-commit entries (splitting a work block at each commit) and AI-activity metadata remain deferred.
   2a. **Config namespace = `ntTimeTracker.*`.** The `nt` prefix (matching the `nokotata` marketplace publisher) avoids clashing with other extensions; the name is **independent of the sync connector**. Tracker settings live under `ntTimeTracker.tracking.*`; connector settings under their own sub-namespace, e.g. `ntTimeTracker.solidtime.apiUrl` / `ntTimeTracker.solidtime.organizationId`, with the token in `context.secrets` keyed `ntTimeTracker.solidtime.apiToken`. Commands share the `ntTimeTracker.` prefix.
3. **Multi-window focus: per-window local only.** Each window tracks while focused (`onDidChangeWindowState`), stops on blur. No focus lease file — the OS enforces single-window focus.
4. **Centralized outbox, any-instance drain — no leader.** All windows share one outbox in `context.globalStorageUri` (already shared per-extension across windows). Any running window may drain and deliver _any_ undelivered segment — so a crashed project's data is delivered by whatever instance is alive. To prevent two windows double-sending the same segment, delivery **atomically claims** a segment before sending (see §5a). No elected leader.
5. **Storage: centralized non-native outbox (files + index), behind a `Store` interface.** Chosen over SQLite: a native SQLite module (`better-sqlite3`) risks an Electron-ABI mismatch that fails extension activation — the worst "developer disables it" outcome, and the data volume (a few writes/minute) does not need a DB. SQLite (or `node:sqlite` when stable in the VS Code runtime) stays a future swap behind the same interface. **API token in `context.secrets`** (never settings.json); server URL + org id in settings.
6. **Entry granularity: aggregated, minute-rounded delivery blocks** (`connectors/aggregate.ts`). Contiguous segments sharing the same project + branch are merged into one block when the gap between them is **≤ 2 min** (`MERGE_GAP_MS`). A block is only built once it has **settled** — the last segment's end is **≥ 5 min** in the past (`SETTLE_MS`) — so still-active work is never delivered mid-flight. The block's start is floored and its end is ceiled to the nearest whole minute; a block that rounds to under 1 minute is dropped. No further rollup beyond this — no quota to protect.
7. **Offline-first, purge-after-delivery.** Segments persist to the outbox immediately and stay there until solidtime confirms delivery, then are **purged** (they are undelivered work, not an archive). The outbox survives restarts, crashes, server downtime, and no-internet. **Provisioning and sending happen at delivery time (online)** — tracking offline records `workspaceKey`/`branch`, and project/task are resolved/created only when the server is reachable.
8. **Idempotency:** each segment has a stable UUID; the entry `description` carries a marker `[vsc:<segmentId>]`. On successful create, record delivery and purge locally. Before creating any block's entry, the sync engine calls `listEntryMarkers` (lists existing entries since the earliest pending block's start and extracts their `[vsc:…]` markers) and skips creation for any block whose marker is already present — prevents duplicates after a crash or an ambiguous prior send.
9. **Performance budget.** Checkpoint/write cadence **60 s** (was 30 s); debounce activity signals; do only trivial synchronous work on VS Code event handlers; no heavy or native dependencies; keep activation cost negligible.
10. **Commit-title enrichment (pass 4).** A delivered block starts out titled with its branch name (item 6). It is later retitled to its **covering commit** — the earliest commit on the same branch at or after the entry's end time — once that commit lands. `tracker/context/gitCommits.ts` watches the VS Code Git extension's `onDidChange` for new HEAD commits, and separately **backfills** commits made while VS Code was closed (e.g. from a terminal) at activation. `connectors/titleStore.ts` persists delivered-but-untitled entries and a rolling per-branch commit log in `globalState`, so retitling survives a restart. Retitling runs (via `updateEntryDescription`, a description-only `PUT`) after every sync, whenever a new commit is observed, and after the activation-time backfill; the `[vsc:<segmentId>]` idempotency marker (§8) is always preserved in the rewritten description. **Re-titling on a later `amend`/rebase is deliberately not implemented** — a commit's hash and message are captured once and the title is set once; if the covering commit is later amended or the branch rebased, the entry keeps its original title.

## 6a. Consciously rejected (do not re-litigate)

Two independent analyses of the community extension recommend a **shared focus-owner lease** and a **single sync coordinator/leader**. We deliberately do **not** adopt either:

- **No focus lease.** The double-counting those analyses warn about is a symptom of the _heartbeat-inference_ model (computing duration from a stale timestamp across a focus gap). Our design closes a precise segment on blur and never derives an interval from an old timestamp, so the bug cannot occur. The OS focuses one window at a time and each window observes its own focus/blur — per-window tracking is already correct.
- **No sync coordinator/leader.** Instead of electing a leader over a shared store, any instance drains the centralized outbox and claims each segment atomically before sending (§5a). Per-item claiming + per-segment idempotency (§8) prevent duplicates without a leader.

If a real duplication or race is ever observed in practice, revisit; until then, simpler wins.

## 7. Deferred to later cycles

- Re-titling on commit `amend`/rebase — a delivered entry's title is set once from its covering commit (§6 item 10) and does not track later history rewrites.
- OAuth2 (PKCE) authentication — the personal API token is the current and only auth method.
- Per-commit entries (splitting a work block at each commit) and commit messages beyond the single retitle.
- AI-vs-human activity metadata (as a `#ai-assisted` tag).
- Full TreeView reporting panel (first cycle may ship status bar + commands only).
- Local export (CSV/JSON), diagnostics bundle.
- Client assignment / billable-rate configuration beyond a default.

## 8. Open questions

Resolved against Cloud (2026-07-21): task API is org-scoped `GET/POST /organizations/{org}/tasks` with `project_id` in the body; rate limit is 200 req/min; `member_id` resolves via `GET /users/me/memberships` — that entry's own `id` (no separate `/members` lookup). Remaining, non-blocking design choices for pass 2:

- **Provisioning race mitigation** — search-before-create + atomic mapping cache is enough for a single user (200/min headroom); no file lock needed.
- **Flush policy** — when to attempt sync (segment finalize, focus loss, every N minutes, on server-back-online). No quota pressure; just avoid needless chatter.
- **Server-reachability detection** — cheap probe vs. attempt-and-backoff on the real request.
- **Project/task naming + slugging** — templates for project name (repo remote → name) and branch→task name (branches with `/`, detached HEAD).

## 9. Proposed module layout (first-cycle scope)

```text
src/
  extension.ts          # wiring, constants (tick/checkpoint/sync/settle/merge-gap), commands
  tracker/              # LAYER 1 — backend-agnostic
    activity/           # activityCollector, sessionStateMachine, focusController
    context/            # workspaceResolver, gitProvider (branch), gitCommits (commit watch + backfill)
    storage/            # store.ts (Store interface), fileOutboxStore, recovery, compaction
    types.ts
  connectors/           # LAYER 2 — sync connectors
    connector.ts        # TimeSyncConnector interface
    aggregate.ts         # merge + settle + minute-round undelivered segments into delivery blocks
    syncEngine.ts        # drains + claims from the outbox, delivers blocks, marks delivered
    mappingStore.ts       # cached project/task ids per workspace+branch
    titleStore.ts         # delivered-but-untitled entries + commit log; covering-commit retitling
    solidtime/            # solidtimeConnector — the concrete REST client
  ui/                   # statusBar (health indicator only: liveness + pending count + sync-error), commands
  configuration/        # settings, secrets
```

The status bar is a **health indicator only** — a liveness dot (tracking / paused / unfocused), the count of undelivered segments, and a warning when delivery is failing. **No totals** — per-project reporting lives in solidtime's web UI.

## 10. Activity state machine

States (`currentStatus()`): `disabled`, `paused`, `unfocused`, `idle`, `tracking`. (There is no separate "syncing" state — delivery health is reported by the status bar, not the tracking state machine; see the module layout in §9.)

Key transitions:

- Window gains focus → `idle`; qualifying activity (edit/cursor/save/task/debug) → `tracking` (opens a segment).
- No qualifying activity for the idle timeout → close segment, back to `idle`.
- Window loses focus → the open segment is **not** closed immediately. Status stays `tracking` for up to the **focus-loss tolerance** (default 25s, `focusLossToleranceSeconds`) so a brief look-away (checking a second monitor, a quick app switch) doesn't fragment the segment. If focus isn't regained before the tolerance elapses, the segment closes and status becomes `unfocused`.
- Workspace/repo/branch change → close current segment; new context resolves a new task lazily at sync time.
- Shutdown → persist current segment synchronously to the journal.

Default tracking timings (tunable via `ntTimeTracker.tracking.*`): idle timeout **120s**, focus-loss tolerance **25s**, minimum segment **20s**, checkpoint/write cadence **60s** (performance budget, §3). Delivery-side timings (§6 item 6, not user-configurable): settle delay **5 min**, merge gap **2 min**, sync attempt every **3 min**.

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
