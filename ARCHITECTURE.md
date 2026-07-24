# Architecture — VS Code Time Tracker (SolidTime + TimeTagger backends)

> Living design notes for the extension. Captures the goal, the decisions made during brainstorming, and the open questions. This is not an implementation plan — it is the reference we build the spec from.
>
> **Naming:** repo/folder `vscode-time-tracker`; marketplace publisher `nokotata`; config/command namespace `ntTimeTracker.*`. Backends are **SolidTime** and **TimeTagger**, each via its own pluggable adapter behind a common `TimeDestination` contract (the earlier "clockify" name is retired; see §5 for the adapter model added after SolidTime shipped as v1).

## 1. Goal

A VS Code extension that **automatically tracks coding time per project and branch, buffers it in a centralized local outbox, and delivers it to whichever of [SolidTime](https://github.com/solidtime-io/solidtime) and [TimeTagger](https://github.com/almarklein/timetagger) are enabled, when reachable**. It keeps working with the server(s) down or no internet, and never loses time across a VS Code restart or crash. **Each enabled backend is the source of truth / report / backup for its own data; local storage is a temporary per-destination outbox that is purged once every enabled backend has confirmed delivery of a given segment.**

Core behaviors the user wants:

- Track automatically, no manual start/stop, and no editor activity required — focus alone (with a resolvable project) opens a segment, so reading/reviewing counts as work.
- Track only the VS Code window currently in focus; tolerate a brief look-away (a short focus-loss grace period, §10) without pausing, but pause a window that stays unfocused (the user runs multiple VS Code windows/projects at once).
- **Idle safety cap, not a heartbeat:** a focused-but-quiet window keeps counting up to a bounded cap past the last real activity (§10) — this credits genuine no-typing work (reading, reviewing an agent's output) without reintroducing the server-side heartbeat inference the design rejects elsewhere.
- Associate time with the active workspace, Git repository, and branch.
- **Local-first and fully offline-capable:** never lose time because the server is stopped, restarting, or unreachable — including across a VS Code restart/crash. Buffer to a centralized on-disk outbox; deliver when the server is on; **purge local data after a confirmed successful send.**
- **Any running window can drain the shared outbox** — even data from a project whose window crashed and is never reopened gets delivered by some other running instance.
- **No server-side or heartbeat inference of duration** — the extension decides exactly what counts (precise focus-based intervals) and ships finished intervals.
- **Dev-machine performance over everything.** This must never be the extension a developer disables because VS Code feels slow. Low write cadence, minimal main-thread work, no heavy dependencies.
- SolidTime's modern web UI for reviewing working hours per project.
- Optionally use commit messages as entry notes / per-commit entries (later, opt-in).

## 2. Backend decision — SolidTime

**Chosen backend: SolidTime (self-hosted).**

Why, against the alternatives evaluated (Clockify Free, Wakapi, TimeTagger, Kimai, ActivityWatch):

- **Best UI + real data model** — modern SaaS-like interface with first-class **projects / tasks / clients / tags / billable**, which maps cleanly to repo→project, branch→task. The user's primary stated goal is a cool UI to see hours per project.
- **Interval-based** — you POST exact `start`/`end` entries, so precise focus-based tracking is honored with no server-side inference (unlike Wakapi's heartbeat density).
- **Local-first / offline compatible** — SolidTime accepts finished entries; it does not need to be always-on. The extension buffers to disk and flushes when reachable.
- **No API quota** — it's the user's own server, so the entire Clockify-style rate-budget design is unnecessary.
- **Runs on modest self-hosted hardware** (if self-hosting) — a low-power box with a weak CPU is enough for a single user. Estimated footprint idle ≈ 0.5–0.9 GB RAM, light single-user ≈ 0.8–1.5 GB; the CPU is the limiting factor but fine for single-user bursty load. **Recommended: disable the Gotenberg/PDF service** (the heaviest component) unless PDF export is needed. _(Largely moot for v1, which targets Cloud Free.)_

### Deployment is a config choice, not a design choice

The extension is **deployment-agnostic**: cloud and self-hosted expose the **same API and UI**, so the only difference is the `apiUrl` setting and which token is pasted. No code changes to switch.

- **SolidTime Cloud — Free "Solo" plan:** 1 user; includes clients/projects/tags/tasks, billable rates, reporting. **API access is available on Free** — tokens are created per-user under Profile Settings → Create API Token, with no plan gating. (Paid "Professional" adds teams, invoicing, PDF/shareable reports, rounding — not API access.) **Cloud rate limit = 200 req/min** (verified via `x-ratelimit-limit` on a real call) — ~12k/hour, far above our batched usage; no budget machinery needed.
- **Self-hosted:** no rate limit, full data ownership, works on LAN; costs maintenance + always-on hosting.

**Recommendation:** start on **Cloud Free** (zero infra, validate fast); self-host later if a limit is hit or full data ownership is wanted — a two-setting change. The extension only ever sends project/branch names, timestamps, durations, and (later, opt-in) commit message first lines — never source code or AI prompts.

### Reference: the existing community extension

**[0pandadev/solidtime-vscode](https://github.com/0pandadev/solidtime-vscode)** proves the SolidTime API works and is a useful **API-layer reference**, but does **not** meet our requirements and will **not** be forked. Its gaps: state is **in-memory only** (loses time on restart while offline), it uses a **heartbeat accumulator** (counts gaps up to a 15-min idle as work — the inference we reject), it has **no branch/task, no commit messages, no multi-window coordination** (module-level state, entry-ID collisions), and it stores the **API key in plaintext settings**. We build our own and lift only its proven API calls.

### SolidTime REST surface (verified against Cloud + the first-party desktop client)

- Auth: **personal API token** via `Authorization: Bearer <token>`, `Accept: application/json`. (The first-party desktop app uses OAuth2 PKCE instead — better UX, much more work; a possible future enhancement, not v1.)
- `GET /api/v1/users/me` → `{ data: { id, name, email, timezone, ... } }`.
- `GET /api/v1/users/me/memberships` → `{ data: [{ id, organization: { id, name, currency }, role }] }`. **`membership.id` IS the `member_id`** required on every entry — no separate `/members` lookup needed.
- `GET|POST /api/v1/organizations/{org}/projects` — create body `{ name, color, is_billable, billable_rate?, client_id?, is_public? }`. **`client_id` must be present (nullable — `null` works, no named client needed) and `color` must be lowercase hex** (e.g. `#6c7280`); omitting `client_id` or sending an uppercase hex color → 422. New projects get a **random color from SolidTime's own 19-color palette** (previously all created with a fixed gray `#6c7280` — that literal is now kept around only as `LEGACY_GRAY`, the marker the Recolor command matches against).
- `PUT /api/v1/organizations/{org}/projects/{id}` — full create-shaped body; used to recolor an existing project in place (preserving its other fields, so time entries are untouched). The **`Time Tracker nt: Recolor Gray SolidTime Projects`** command lists projects, finds those whose color is exactly `LEGACY_GRAY`, and `PUT`s each with a new random palette color, behind a modal confirm — projects the user has colored themselves are never touched.
- `GET|POST /api/v1/organizations/{org}/tasks` — **org-scoped** (not project-nested); create body `{ name, project_id, estimated_time? }`.
- `GET /api/v1/organizations/{org}/time-entries` — list (reconciliation; supports `member_id`/date filters).
- `POST /api/v1/organizations/{org}/time-entries` — body `{ member_id, start, end?, billable, project_id?, task_id?, description?, tags? }` → `{ data: { id, ... } }`. **No `duration`** — the server derives it from `start`/`end`. `end` omitted = a running entry (not our case; we send finished intervals with both). **Dates must be `Y-m-d\TH:i:s\Z` — no milliseconds** (strip the `.000` before sending; a millisecond-bearing date → 422), including the `?start=` filter on the list endpoint above.
- `PUT /api/v1/organizations/{org}/time-entries/{id}` — update; **accepts a description-only body** (used to retitle a delivered entry to its covering commit, §6 item 10, without touching start/end/project/task). **No bulk-create endpoint** (single POST per entry; fine at 200 req/min). No server-side idempotency key — we add our own `[vsc:<segmentId>]` description marker + reconciliation (§8).

### 2a. Second backend — TimeTagger

Added after SolidTime shipped as v1, as a **second, independent delivery backend** rather than a replacement — see §5 for how the two coexist behind a common adapter contract. [TimeTagger](https://github.com/almarklein/timetagger) is a simpler, tag-based time tracker with the same interval-based, offline-friendly model as SolidTime, so the same tracking core (Layer 1) feeds it unchanged. It has **no project/task entities** — instead:

- Auth: personal API token via the `authtoken` header (not `Authorization: Bearer`).
- `PUT /api/v2/records` — the entire API surface for writes: an **upsert** keyed by a client-chosen `key`, body `[{ key, t1, t2, mt, st, ds }]` → `{ accepted: [...], failed: [...], errors: [...] }`. `t1`/`t2` (start/end) and `mt` (modified time) are **Unix seconds**, not ISO strings. `st` is a status flag (`0` = normal). `ds` is a free-text description.
- **No separate project/task fields** — project and branch are encoded as **`#tags`** inside `ds` (e.g. `my-repo #my-repo #feature-branch`), TimeTagger's own convention for categorization.
- `GET /api/v2/records?timerange=...` — read back records in a time range (used only for the live smoke-test verification in Task 10, not by the running extension).
- **Native idempotency, no marker needed:** because `PUT /records` is a keyed upsert, using the **segment id as the record `key`** makes delivery naturally idempotent — resending the same key updates the same record instead of duplicating it. This is materially simpler than SolidTime's approach (§2, `[vsc:<segmentId>]` description marker + a `listEntryMarkers` reconciliation pass) and needs no `prepare()` step to fetch existing state.
- Retitling (§6 item 10) reuses the exact same `PUT /records` upsert with the same `key` and an updated `ds` — there is no separate "update" endpoint to distinguish, unlike SolidTime's dedicated description-only `PUT .../time-entries/{id}`.

## 3. Design principles

> **1. Dev-machine performance first.** Nothing the tracker does may make the editor feel slow. Debounced signals, a low (60 s) write cadence, small synchronous writes, no native/heavy dependencies, negligible startup cost. If a feature and performance conflict, performance wins.
>
> **2. Track precisely locally; deliver opportunistically.** The extension records exact focus-based intervals to a centralized local outbox and delivers them to every **enabled** backend whenever it is reachable. Backend availability never affects the accuracy or completeness of tracking, and no data is lost across a restart or crash; a backend being down never blocks delivery to another enabled backend (§5, per-destination isolation).
>
> **3. Local is a temporary outbox, not a ledger.** Each enabled backend is the source of truth, report, and backup for its own copy of the data. A segment is purged locally only once **every** enabled backend has confirmed delivery — not just one — so local storage still behaves as a queue of undelivered work, not an archive, even with two backends in flight at different speeds.

## 4. Reference extensions (feature sources)

- **Simple Coding Time Tracker** — https://github.com/twentyTwo/vsc-ext-coding-time-tracker
  Borrow: session state machine, activity/inactivity detection, project+branch attribution, local-first persistence, status-bar summaries, local history/filtering/export, splitting sessions on project/branch change. Improve: use built-in Git extension events instead of polling.
- **WakaTime** — https://github.com/wakatime/vscode-wakatime
  Borrow: event-driven activity _signals_, debouncing/dedup, offline buffering, project+branch context, activity classification. Do **not** copy server-side duration inference — we ship exact intervals.
- **Clockify Timer** — https://github.com/gbrlstr/clockify-timer
  Borrow: command/UX patterns, status-bar + (later) TreeView navigation, error handling. Do **not** copy live-timer, plaintext key storage, or IDE-open/close autostart.
- **solidtime-vscode** — API-layer reference only (see §2).

## 5. Two-layer architecture + destinations

The extension is two decoupled layers:

**Layer 1 — Tracker (backend-agnostic).** Turns VS Code signals into precise local work segments. Activity sources: editor edits/cursor/save, active-editor + workspace changes, tasks/debug, **Git branch and commits**, and **terminal / AI interactions**. Owns the state machine and the **centralized outbox store** (behind a `Store` interface). Knows nothing about any server.

**Layer 2 — Sync engine + destination adapters.** A central dispatcher (`SyncEngine`) drains undelivered segments from the outbox, aggregates them into delivery blocks (§6 item 6), and **fans each block out to every enabled `TimeDestination` adapter** — not just one. A destination is enabled purely by **having its API token set** (§9); there is no separate on/off toggle. If neither SolidTime's nor TimeTagger's token is set, the extension still tracks locally and delivers to nothing. Adapters are pluggable — `SolidtimeDestination` and `TimetaggerDestination` are the two shipped today — behind a small, uniform contract (`src/connectors/destination.ts`):

```ts
interface TimeDestination {
	readonly id: string; // stable per-destination key: 'solidtime' | 'timetagger'
	readonly label: string; // human label for logs/status: 'SolidTime' | 'TimeTagger'
	prepare(sinceIso: string): Promise<void>; // pre-fetch anything the run needs; no-op if key-idempotent
	deliver(block: DeliveryBlock): Promise<string>; // idempotent create/update; returns a ref for retitling, or ''
	retitle(ref: string, title: string, ctx: TitleCtx): Promise<void>; // no-op when ref === ''
}
```

- **`SolidtimeDestination`** wraps the existing SolidTime REST connector plus the project/task lookup-or-create logic (§11) and the `[vsc:<segmentId>]` description-marker dedup (§2, §8) — the same mechanics SolidTime always used, just relocated behind the adapter interface. `prepare()` resolves the member id and lists existing entry markers since the earliest pending block.
- **`TimetaggerDestination`** wraps a thin `TimetaggerClient` around `PUT /api/v2/records` (§2a). `prepare()` is a no-op — the `records` API is natively idempotent by `key`, so there is nothing to pre-fetch. `deliver()` uses the **segment id as the record `key`**; project and branch are rendered as `#tags` in the description.
- **Per-destination failure isolation.** The dispatcher calls `prepare()` and `deliver()` per destination inside their own try/catch; a destination whose `prepare()` throws is dropped for that run's delivery pass (logged, with an auth hint pointing at its own Set-Token command on a 401), and a destination whose `deliver()` throws a retryable error is skipped for the rest of that run without touching the others. **A failed request to one backend never blocks or delays the other** — each destination's segments are claimed, delivered, and marked independently.
- **Commit-title retitling works for both backends symmetrically** (§6 item 10): the titling pass calls `retitle()` once per destination per delivered-but-untitled entry, so a covering commit renames the entry in SolidTime _and_ in TimeTagger.

Concrete adapters: `SolidtimeDestination` and `TimetaggerDestination` (the REST calls of §2 and §2a respectively). Project/task lookup-or-create and the resolved-id cache live in `mappingStore.ts`, used only by the SolidTime adapter — TimeTagger has no such state. A different backend would be a new `TimeDestination` implementation with **no change to Layer 1 or the dispatcher**.

### 5a. Centralized outbox + atomic claim

- **One shared folder.** `context.globalStorageUri` is shared across all windows of the extension, so every window reads/writes the same outbox. There is no per-window read filtering — a fresh or crashed-and-reopened window sees everything undelivered.
- **Writes stay per-window-file to avoid contention.** Each window appends its own live segments to its own file (named by a per-process id) so two windows never write the same file concurrently. Reads and delivery span **all** files.
- **Delivery claims atomically.** Before sending a segment, the delivering instance claims it via an atomic filesystem operation (e.g. `rename` into a `claimed/` area, or a claim marker written with `wx`/exclusive create). Only the winner sends; a stale claim (owner died mid-send) is reclaimable after a timeout. This replaces a leader election with per-item claiming. The claim is per-segment, not per-(segment, destination) — one window's delivery pass still fans out to all enabled destinations for that segment (§5).
- **Per-destination delivery tombstones.** A delivered marker is written per `(segmentId, destinationId)` pair — `markDelivered(segmentId, destinationId)` — so a segment can be "delivered to SolidTime but not yet to TimeTagger" (or vice versa) without either backend blocking the other. `listUndelivered(enabledIds)` and `compact(enabledIds)` are parameterized by the **currently enabled** destination ids so that a purged/disabled destination never keeps a segment from being purged. **A segment is only purged once every currently-enabled destination has its own tombstone** — `isFullyDelivered` requires `enabledIds.every(id => isDelivered(segmentId, id))`. A bare, suffix-less tombstone predates multi-backend support and is treated as a legacy SolidTime delivery for backward compatibility.
- **Purge after delivery.** Once a segment is fully delivered (every enabled destination's tombstone present), it is removed from the outbox. **Compaction** (the "VACUUM"): periodically rewrite a window's file dropping fully-delivered segments, and delete fully-drained/renamed files and their now-orphaned tombstones/claims. Data volume is tiny, so compaction is cheap.
- **A `Store` interface** hides all of this from the tracker and the sync engine: `append(segment)`, `listUndelivered(enabledIds)`, `claim(id): boolean`, `isDelivered(segmentId, destinationId): boolean`, `markDelivered(segmentId, destinationId)`, `compact(enabledIds)`, `recover()` (adopt orphaned in-progress segments at their last checkpoint). SQLite could implement the same interface later.

### Activity-source status

| Source                                 | Layer-1 role                                      | First-cycle implementation                    |
| -------------------------------------- | ------------------------------------------------- | --------------------------------------------- |
| Window focus (no activity needed)      | opens/sustains a segment up to the idle cap (§10) | ✅ shipped                                    |
| Editor / cursor / save / active-editor | activity signal                                   | ✅ pass 1                                     |
| Tasks / debug                          | activity signal                                   | ✅ pass 1                                     |
| Terminal interactions                  | activity signal                                   | ✅ pass 1 (shell-execution / terminal events) |
| Git branch                             | segment attribution (→ task)                      | ✅ pass 1                                     |
| Git commits                            | enrichment (retitle to covering commit)           | ✅ pass 4                                     |
| AI interactions                        | classification metadata                           | ⏳ later (deferred, opt-in)                   |

## 6. Decisions locked (brainstorming)

1. **Backend = SolidTime.** **v1 targets SolidTime Cloud Free ("Solo")**; self-hosted is the documented fallback, reachable by changing only `apiUrl` + token (no code change). See §2. _(Later extended, without revisiting this decision: TimeTagger was added as a second, independent backend — see §6b.)_
2. **First delivery cycle = local tracking core + SolidTime sync.** Commit-message enrichment shipped in pass 4 as **retitling an already-delivered entry to its covering commit** (see item 10) — per-commit entries (splitting a work block at each commit) and AI-activity metadata remain deferred.
   2a. **Config namespace = `ntTimeTracker.*`.** The `nt` prefix (matching the `nokotata` marketplace publisher) avoids clashing with other extensions; the name is **independent of any one destination**. Tracker settings live under `ntTimeTracker.tracking.*`; each destination's settings live under their own sub-namespace, e.g. `ntTimeTracker.solidtime.apiUrl` / `ntTimeTracker.solidtime.organizationId` and `ntTimeTracker.timetagger.apiUrl`, with each token in `context.secrets` (keyed `ntTimeTracker.solidtime.apiToken` / `ntTimeTracker.timetagger.apiToken`). Commands share the `ntTimeTracker.` prefix.
3. **Multi-window focus: per-window local only.** Each window tracks while focused (`onDidChangeWindowState`), stops on blur. No focus lease file — the OS enforces single-window focus.
4. **Centralized outbox, any-instance drain — no leader.** All windows share one outbox in `context.globalStorageUri` (already shared per-extension across windows). Any running window may drain and deliver _any_ undelivered segment — so a crashed project's data is delivered by whatever instance is alive. To prevent two windows double-sending the same segment, delivery **atomically claims** a segment before sending (see §5a). No elected leader.
5. **Storage: centralized non-native outbox (files + index), behind a `Store` interface.** Chosen over SQLite: a native SQLite module (`better-sqlite3`) risks an Electron-ABI mismatch that fails extension activation — the worst "developer disables it" outcome, and the data volume (a few writes/minute) does not need a DB. SQLite (or `node:sqlite` when stable in the VS Code runtime) stays a future swap behind the same interface. **API token in `context.secrets`** (never settings.json); server URL + org id in settings.
6. **Entry granularity: aggregated, minute-rounded delivery blocks** (`connectors/aggregate.ts`). Contiguous segments sharing the same project + branch are merged into one block when the gap between them is **≤ 2 min** (`MERGE_GAP_MS`). A block is only built once it has **settled** — the last segment's end is **≥ 5 min** in the past (`SETTLE_MS`) — so still-active work is never delivered mid-flight. The block's start is floored and its end is ceiled to the nearest whole minute; a block that rounds to under 1 minute is dropped. No further rollup beyond this — no quota to protect.
7. **Offline-first, purge-after-delivery.** Segments persist to the outbox immediately and stay there until SolidTime confirms delivery, then are **purged** (they are undelivered work, not an archive). The outbox survives restarts, crashes, server downtime, and no-internet. **Provisioning and sending happen at delivery time (online)** — tracking offline records `workspaceKey`/`branch`, and project/task are resolved/created only when the server is reachable.
8. **Idempotency (per destination, two strategies):** each segment has a stable UUID. **SolidTime** has no server-side idempotency key, so the entry `description` carries a marker `[vsc:<segmentId>]`; before creating any block's entry, `SolidtimeDestination.prepare()` calls `listEntryMarkers` (existing entries since the earliest pending block's start, extracting their `[vsc:…]` markers) and skips creation for any block whose marker is already present. **TimeTagger** needs none of this — its `PUT /records` is a keyed upsert, so using the segment id as the record `key` (§2a) makes delivery naturally idempotent; `prepare()` is a no-op. Either way, on successful delivery the outbox records a **per-destination** tombstone (§5a) and the segment is purged only once every enabled destination has confirmed it.
9. **Performance budget.** Checkpoint/write cadence **60 s** (was 30 s); debounce activity signals; do only trivial synchronous work on VS Code event handlers; no heavy or native dependencies; keep activation cost negligible.
10. **Commit-title enrichment (pass 4), now per destination.** A delivered block starts out titled with its branch name (item 6). It is later retitled to its **covering commit** — the earliest commit on the same branch at or after the entry's end time — once that commit lands, **in every enabled destination**. `tracker/context/gitCommits.ts` watches the VS Code Git extension's `onDidChange` for new HEAD commits, and separately **backfills** commits made while VS Code was closed (e.g. from a terminal) at activation. `connectors/titleStore.ts` persists delivered-but-untitled entries **per destination** and a rolling per-branch commit log in `globalState`, so retitling survives a restart. Retitling runs (via each destination's `retitle()` — a description-only `PUT` for SolidTime, the same keyed `PUT /records` upsert for TimeTagger) after every sync, whenever a new commit is observed, and after the activation-time backfill; each backend's own idempotency mechanism (§8) is preserved in the rewritten description. **Re-titling on a later `amend`/rebase is deliberately not implemented** — a commit's hash and message are captured once and the title is set once; if the covering commit is later amended or the branch rebased, the entry keeps its original title (in both backends).

## 6a. Consciously rejected (do not re-litigate)

Two independent analyses of the community extension recommend a **shared focus-owner lease** and a **single sync coordinator/leader**. We deliberately do **not** adopt either:

- **No focus lease.** The double-counting those analyses warn about is a symptom of the _heartbeat-inference_ model (computing duration from a stale timestamp across a focus gap). Our design closes a precise segment on blur and never derives an interval from an old timestamp, so the bug cannot occur. The OS focuses one window at a time and each window observes its own focus/blur — per-window tracking is already correct.
- **No sync coordinator/leader.** Instead of electing a leader over a shared store, any instance drains the centralized outbox and claims each segment atomically before sending (§5a). Per-item claiming + per-segment idempotency (§8) prevent duplicates without a leader.

If a real duplication or race is ever observed in practice, revisit; until then, simpler wins.

## 6b. Second delivery backend — TimeTagger

TimeTagger was added as a **second delivery backend alongside SolidTime**, not a replacement, driven by the same Layer 1 tracking core:

- **Enablement by token presence, not a separate setting.** Whichever of `ntTimeTracker.solidtime.apiToken` / `ntTimeTracker.timetagger.apiToken` is set in `context.secrets` determines which `TimeDestination` adapters `extension.ts`'s `buildDestinations()` constructs for that sync run. Deleting a token (**Delete SolidTime Token** / **Delete TimeTagger Token**) disables that backend on the next run; setting it again re-enables it. With neither token set, the extension tracks locally and delivers nothing — never an error state.
- **No shared coupling between backends.** The `SyncEngine` dispatcher (§5) treats `destinations: TimeDestination[]` as an unordered list; nothing about SolidTime's provisioning, marker scheme, or REST shape leaks into the TimeTagger adapter or vice versa.
- **Both support a custom self-hosted URL** the same way: `ntTimeTracker.solidtime.apiUrl` (default `https://app.solidtime.io`) and `ntTimeTracker.timetagger.apiUrl` (default `https://timetagger.app`) are independent settings; changing either only affects that one backend's HTTP client construction.
- **Commands renamed/added for clarity now that there are two backends:** the original single `ntTimeTracker.setApiToken` command was removed in favor of `Set SolidTime Token` / `Delete SolidTime Token` / `Set TimeTagger Token` / `Delete TimeTagger Token` — each backend's lifecycle is a first-class, individually addressable command pair.
- **Project color is a SolidTime-only concern.** New SolidTime projects get a random color from SolidTime's own 19-color palette instead of the fixed gray (`LEGACY_GRAY`, `#6c7280`) every project used to get; TimeTagger has no project entity, so nothing here applies to it. The **`Time Tracker nt: Recolor Gray SolidTime Projects`** command (§2) is a one-off migration for projects created before randomization landed — it only touches projects whose color is exactly `LEGACY_GRAY`, so manually colored projects are never overwritten.

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

## 9. Module layout

```text
src/
  extension.ts          # wiring, constants (tick/checkpoint/sync/settle/merge-gap), commands,
                         # buildDestinations() — constructs the enabled TimeDestination[] from tokens
  tracker/              # LAYER 1 — backend-agnostic
    activity/           # activityCollector, sessionStateMachine, focusController
    context/            # workspaceResolver, gitProvider (branch), gitCommits (commit watch + backfill)
    storage/            # store.ts (Store interface), fileOutboxStore (per-destination tombstones), recovery, compaction
    types.ts
  connectors/           # LAYER 2 — sync engine + destination adapters
    connector.ts         # ConnectorError, markerFor — shared low-level REST error/marker helpers
    destination.ts        # TimeDestination adapter contract (prepare/deliver/retitle)
    aggregate.ts           # merge + settle + minute-round undelivered segments into delivery blocks
    syncEngine.ts           # dispatcher — fans each block out to every enabled destination, per-destination isolation
    mappingStore.ts          # cached project/task ids per workspace+branch (SolidTime only)
    titleStore.ts             # delivered-but-untitled entries per destination + commit log; covering-commit retitling
    solidtime/                # solidtimeConnector (REST client) + solidtimeDestination (TimeDestination adapter)
    timetagger/                # timetaggerClient (records API) + timetaggerDestination (TimeDestination adapter)
  ui/                   # statusBar (health indicator only: liveness + pending count + sync-error), commands
  configuration/        # settings, secrets (per-destination token get/set/delete)
```

The status bar is a **health indicator only** — a liveness dot (tracking / paused / unfocused), the count of undelivered segments, and a warning when delivery is failing. **No totals** — per-project reporting lives in each enabled backend's own web UI.

## 10. Activity state machine

States (`currentStatus()`): `disabled`, `paused`, `unfocused`, `idle`, `tracking`, `tracking-idle`, `grace`. (There is no separate "syncing" state — delivery health is reported by the status bar, not the tracking state machine; see the module layout in §9.) The status bar renders these as, respectively, `off`, `paused`, `unfocused`, `idle`, `tracking`, `tracking (idle)`, and `tracking (grace)`.

**Focus alone starts tracking — no editor activity required.** As soon as the window gains focus and has a resolvable context (`canTrack()`), a segment opens; editor activity (edit/cursor/save/task/debug) also opens or sustains one. This means reading or reviewing — including watching an AI agent's terminal output — counts as work, not just typing.

Key transitions:

- Window gains focus with a resolvable context → segment opens immediately, status `tracking`.
- Editor activity while a segment is open → refreshes `lastActivity`; while none is open (e.g. just regained focus) → opens one.
- No activity for `idleHintMs` (default 60s, not user-configurable) while still focused → status becomes `tracking-idle` as a heads-up — the segment is still open and still counting toward the cap.
- No activity for the **idle timeout** (`idleTimeoutSeconds`, default 300s/5 min) → the segment closes, **credited up to the cap past the last real activity** (not dropped to zero), and status returns to `idle`. Any subsequent activity or focus opens a fresh segment.
- Window loses focus → the open segment is **not** closed immediately. Status becomes `grace` for up to the **focus-loss tolerance** (`focusLossToleranceSeconds`, default 30s) so a brief look-away (checking a second monitor, a quick app switch) doesn't fragment the segment. If focus returns within the tolerance, tracking resumes uninterrupted with no gap. If the tolerance elapses first, the segment closes **at the moment focus was lost** (`blurAt`, not the end of the tolerance window) and status becomes `unfocused`.
- **Discard idle time:** while status is `tracking-idle`, the `ntTimeTracker.discardIdle` command (bound to a status-bar click in that state) prompts a modal confirm and, if accepted, trims the open segment back to `lastActivity` — the idle tail is dropped but the active work already counted is kept. Nothing is delivered yet at that point, so there is nothing to undo server-side.
- Workspace/repo/branch change → close current segment; new context resolves a new task lazily at sync time.
- Shutdown → persist current segment synchronously to the journal, ending it at `blurAt` if focus was already lost, otherwise at the shutdown time.

Default tracking timings (tunable via `ntTimeTracker.tracking.*`): idle cap **300s** (5 min), look-away tolerance **30s**, minimum segment **20s**, checkpoint/write cadence **60s** (performance budget, §3), plus an idle-hint display threshold of **60s** (`idleHintMs`, not user-configurable) that switches the status bar to `tracking (idle)` before the cap is reached. Delivery-side timings (§6 item 6, not user-configurable): settle delay **5 min**, merge gap **2 min**, sync attempt every **3 min**.

## 11. Identity & mapping

- **Resolve context by the active document's workspace folder**, not `workspaceFolders[0]` — the latter misattributes multi-root workspaces (a bug in the reference extension). Fall back to the single/first folder only when there is no active editor.
- **Workspace identity order** (stable project key): normalized Git remote (`host/owner/repo`) → repo-root path hash → workspace-file URI → workspace-folder URI. (Two repos can both be named `backend`.)
- **Project name templates:** default repo name; collision `owner/repo`; no-git → workspace-folder name; multi-root → `workspace / folder`.
- **Branch → task** by default. Detached HEAD → `detached/<short-hash>`; no repo → no task.
- **Provisioning is lazy, online-only, and cached forever (SolidTime only):** at flush time resolve `workspaceKey` → check local mapping cache → search SolidTime by name → reuse if found (carrying our marker) else create with a random palette color (§2, §6b) → store id in the shared mapping cache → never re-search unless the server returns 404 or the user requests remap. TimeTagger has no project/task entities to provision — project and branch are rendered directly as `#tags` (§2a) with no lookup-or-create step.

## 12. Tooling & conventions (matches the reference extension `vscode-send-to-terminal`)

- TypeScript **strict**, module `Node16`, target `ES2022`, `outDir: out`, `rootDir: src`.
- **ESLint + `eslint-plugin-unicorn` + Prettier** (`eslint-config-prettier` last). _(Unicorn is new vs. the reference; the rest matches.)_
- Prettier: `useTabs: true`, `singleQuote: true`, `semi: true`, `trailingComma: es5`, `printWidth: 100`.
- Tests: Mocha via `@vscode/test-cli` / `@vscode/test-electron`.
- Packaging: `@vscode/vsce`, output to `tmp/`. Node 22 (`.nvmrc`). Compile with `tsc` (not Bun/esbuild — matches your other extension).

## 13. Test focus

State-machine and storage: focus gain/loss, rapid window switching, switching to another app, idle timeout, activity just before idle, workspace/branch changes, multi-root, detached HEAD, crash/restart recovery. Outbox: a fresh window sees **all** windows' undelivered segments (centralized read), atomic claim prevents two windows double-sending, orphaned in-progress segments recovered at last checkpoint, **a segment is purged only once every currently-enabled destination has its own tombstone** (not just one), delivered-to-one-not-the-other segments stay pending correctly. Sync: offline operation (backend down / no internet) buffering, **no data loss across a restart/crash**, drain-on-reconnect, lazy provisioning at delivery time (SolidTime), idempotent behavior after an ambiguous POST/PUT (SolidTime: reconciliation by marker; TimeTagger: keyed upsert by segment id) → no duplicates either way, auth failure and server error handling per destination, member-id resolution, **one destination's failure never blocks or delays delivery to the other** (dispatcher-level isolation, §5).
