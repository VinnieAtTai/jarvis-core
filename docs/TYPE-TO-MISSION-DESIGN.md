# Type-to-mission — design draft

_Draft by delta (jarvis punchlist worker), 2026-07-10 night, from Chris's voice brief.
For Chris's review. Builds directly on [PROJECT-MANAGER-DESIGN.md](PROJECT-MANAGER-DESIGN.md)
(P2/P3) — this is that vision applied to the **conversation surface**._

## Intent (Chris, voice, 2026-07-10 night)

> "We need to fix the text. When I'm in a tab I want it to go where I am — when I'm on the
> carrier gap analysis, I want the message to go there. I want to figure out which of the
> sub-workers it needs to poke — I want *it* to handle that, I don't want to have to go to each
> individual thing. I love that if multiple things are working on something I can target it —
> I can use that inside the chat. But I really need these missions to be where I do the
> conversation, because then it's persistent through the whole thing. That's going to make for
> context issues, but we're going to have to deal with that. The talking is really for focus —
> I can focus, I can target, I know where I'm going. When I'm on a mission tab I want to go to
> the mission tab, and I want that mission tab to just go out and work on it."

## The three behaviors Chris is asking for

1. **Typing follows the tab.** On a mission tab, a typed message goes to *that mission* — not
   the global jarvis focus. (Voice stays the focus/steering channel; typing is the targeting
   channel.)
2. **The mission owns ONE persistent conversation.** Chris converses *with the mission*, and
   that thread persists for the mission's whole life — across sub-workers retiring and
   respawning. He explicitly accepts the context-growth cost this implies.
3. **The mission dispatches its own sub-workers.** Chris talks to the mission; *it* decides
   which sub-workers to poke and fans out. He never messages each worker by hand. The existing
   per-worker target dropdown stays for when he *does* want to aim at one.

## What already exists (we EXTEND, not rebuild)

Console (`console.js`):
- **Mission tabs** (`6c372a1`, `3e45e53`): a mission renders as one aggregated chat tab
  (`'m:<id>'`), pooling every worker bound to that mission. `missionChatSets()` builds the
  mission→identities map from `board.projectContext.missionId`.
- **Typed-to-mission already half-works** (`sendTyped`, ~L1077): on a mission tab, a typed
  message is resolved to `missionManagerCallsign(id)` (the project-card callsign, else the first
  live worker) and sent as `on <cs>, <text>` → `POST /hear`.
- **Send-to dropdown** (`populateSendTo`, ~L1094): follow-tab / general / jarvis / each live
  worker. Missions are **not** in it.

Server (`jarvis-core.mjs`):
- **`routeTo(cs, msg)`** (L923) resolves a **callsign OR a project name** (`liveUidOf(cs) ||
  projectWorkerUid(cs)`) to a uid, buses the message, and even queues + nags if that session is
  quiet. This is the spine we route missions through.
- **Projects have a persistent manager + durable context** (P1, built): `projects.json` holds
  `{name, title, missionId, managerUid, context:{summary,currentFocus,openThreads,recentLog,docs}}`.
  The manager is a *role* any successor rehydrates into via `GET /project`.
- **Missions↔projects** link **one-way**: `project.missionId → mission.id`. Missions themselves
  (`missions.json`: `{id,title,status,phases,docs}`) have **no members and no conversation**.

## The gaps (what's actually missing)

| # | Gap | Today | Needed |
|---|-----|-------|--------|
| G1 | Mission is not a routable target | console resolves mission→a callsign client-side; server only knows callsigns/projects | server resolves `mission → its project → manager`, one authoritative place |
| G2 | A manager-less mission loses messages | if no live worker, `sendTyped` drops to the general bus; the fallthrough in `handleUtterance` (L1576–1581) records to transcript only | a mission message is **never dropped** — it's persisted to the mission conversation and (T2) revives the coordinator |
| G3 | No persistent mission conversation | reconstructed client-side each render by filtering transcript on member callsigns; fragile, callsign-keyed | a durable, **mission-keyed** conversation the coordinator rehydrates from |
| G4 | Mission has no coordinator concept | a mission's "manager" is implicitly the manager of the project that points at it | make mission↔project usable: reverse-lookup + lazy-ensure a project so every conversational mission has a coordinator home |
| G5 | Mission not targetable from elsewhere | dropdown lists workers only | add missions to the send-to dropdown |

## Design

### Addressing — the mission is a first-class target
- The console addresses a mission by a **stable mission token**, not a resolved-client-side
  callsign. Proposed wire form through the existing `/hear` parser: `on mission <id>, <text>`
  (and the dropdown/tab can emit it directly).
- The **server** owns resolution (new branch in `handleUtterance`, before the generic
  `on <word>` parse at L1566):
  1. `mission = missions.find(id)` (or match by title word, reusing `matchMissionByPhrase`).
  2. `project = projectForMission(projects, mission.id)` — reverse lookup; lazy-ensure one named
     after the mission if none is linked yet, so the coordinator role + durable context exist.
  3. `uid = projectWorkerUid(project.name)`.
  4. **Live coordinator** → `routeTo(project.name, text)` (existing path; buses + queues).
  5. **No live coordinator** → persist to the mission conversation (G3) and, in T2, revive the
     coordinator. **Never drop** (fixes G2).
- Every mission message is **always** appended to the mission conversation, whether or not a
  coordinator is live — so the thread is complete and the next coordinator rehydrates the full
  exchange.

### Persistence — the mission conversation
- Reuse the transcript infrastructure rather than a parallel store: tag the relevant `record()` /
  bus entries with `missionId`. Add **`GET /mission-chat?missionId=<id>`** to read them back
  server-authoritatively (the console stops reconstructing from member callsigns and reads the
  mission's own thread). Same trim/rotate behavior as the transcript — no new persistence code.
- This is the durable thread Chris wants: **keyed by mission, not by callsign**, so it survives
  worker turnover automatically.
- **Context-growth tradeoff (Chris flagged it).** The coordinator does NOT re-ingest the entire
  history each turn. It rehydrates from (a) the project-context *summary* (curated "where this
  stands") plus (b) the most-recent N mission messages. The full thread stays on disk for Chris
  and for audit; the coordinator's working context is bounded. This is the "we'll deal with the
  context issues" answer.

### Dispatch — the coordinator fans out
- The mission's coordinator **is** the manager of its linked project — a persistent role (P1/
  model B). Chris's typed message lands on the coordinator; the coordinator decides which
  sub-workers to engage and delegates to them (P2 `parentProject` sub-workers), exactly the
  manager-isolated pattern JARVIS already runs on. Chris talks to the mission; the coordinator
  does the poking.
- The per-worker **target dropdown stays** for when Chris wants to aim at a single sub-worker
  inside the mission (he called this out as something he likes).

## Phasing

- **T1 — routable + persistent (tonight; additive, deploy-on-restart).**
  - Pure, unit-tested resolver `projectForMission(projects, missionId)` in `jarvis-text.mjs`.
  - Server: `on mission <id>` routing branch; mission-tagged conversation records; never-drop;
    `GET /mission-chat`.
  - Console: missions in the send-to dropdown; mission-tab/dropdown sends emit the stable mission
    address so they're robust even with no live coordinator (no silent fall to the general bus).
  - Inert against existing behavior for non-mission traffic; server half is dormant until the
    next hub restart. **Verify:** `npm test` + scratch-port boot (`JARVIS_PORT`).
- **T2 — auto-revive the coordinator (needs a supervised window; it spawns a process).**
  - A mission message to a manager-less mission spawns/resumes the coordinator (reuse
    `spawnWorker(project=…)` + the auto-successor path) so "talk to the mission → it goes to
    work" always has a live brain.
- **T3 — sub-workers under the mission's project (P2/P3).**
  - `parentProject` sub-workers nested under the mission's project; coordinator auto-dispatches;
    console nests sub-worker tabs under the mission. Merges with the existing P2 board items.

## Open decisions (my calls; Chris can override)

1. **A conversational mission needs a project.** I lazy-ensure a project (named after the
   mission) the first time Chris talks to a mission with no linked project — so the coordinator
   role and durable context have a home. Alternative: refuse and prompt Chris to bind one.
2. **Persist as missionId-tagged transcript records**, not a separate `mission-<id>-chat.jsonl`
   — reuses trim/rotate/backup and keeps one source of truth. Alternative: a dedicated per-
   mission log if we later want independent retention.
3. **Bounded rehydration** (summary + recent-N), not full-history replay, to honor the context
   budget. Alternative: full replay with server-side summarization when it gets large.
4. **Wire form `on mission <id>`** through the existing `/hear` text parser (keeps one input
   path) rather than a new structured `POST /mission-message` endpoint. Alternative: a dedicated
   endpoint if we want typed mission chat to bypass the speech parser entirely.
