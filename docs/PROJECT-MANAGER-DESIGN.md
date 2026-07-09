# Persistent project manager — design draft

_Draft by mike (jarvis punchlist worker), 2026-07-09, from Chris's voice brief. For Chris's
review. Chris confirmed the persistence model ("B") live; the rest below is the proposal._

> **P1 BUILT (mike, 2026-07-09), pending hub-restart deploy + runtime verify.** projects.json
> store + `GET /project` / `GET /projects` / `POST /project-context` + rehydrate-on-boot (register
> hands the manager its context; boot prompt tells it to rehydrate) + manager binding on
> register/retire + retiring-manager summary auto-logged + per-card context strip in the console.
> Seeded projects: `jarvis`, `primeng` (linked to the PrimeNG mission), `waterfall` (Waterfall
> Tendering PS-23). 76 unit tests green (10 new for the pure store helpers). P2 (sub-workers under
> a project) and P3 (mission↔project rail) are still the proposal below.

## Intent (Chris, 2026-07-09)

> "My big problem is I lose big projects. Right now we're focused on workers — each task is a
> worker and a tab. But with PrimeNG I want a PrimeNG [project], and under there I'd have an
> alpha that's currently working on something. Ideally I'd have a worker whose job is entirely
> to coach the whole project — it kind of exists and then it spins up other workers that sit
> under the PrimeNG. They come and go, but that manager is persistent, and what it's working on
> is persistent, and that data is persistent. It doesn't have to rebuild the context from
> scratch — it rebuilds from what we've been working on recently."

The pain: the flat **worker = task = tab** model tracks *tasks* well, but a big project (PrimeNG
17→18, big PRDs) has scope and state that live **above** any single task. Today there's no home
for that, so every session reload / handoff bleeds project context and Chris loses the thread.

The ask: a first-class **project** with a persistent **manager** that owns it and spins up
ephemeral **sub-workers** that come and go. The project's data survives reloads; the manager
rehydrates from it instead of starting cold.

## What already exists (we EXTEND, not rebuild)

Roughly 60% of this is already in the hub — the vocabulary just isn't unified yet:

1. **Projects are already a durable concept.** A project (e.g. `jarvis`) is a durable board
   *column* in `worklist.json` (v3, `sessions.<name>`) that outlives its worker. A worker
   carrying `.project=<name>` binds its board + speech routing to that column instead of getting
   its own NATO card (`jarvis-core.mjs:567`, `registerSession` ~695, `projectWorkerUid` 570).
2. **The manager-as-role + rehydrate is already half-built.** When a project worker `/retire`s,
   the durable column **stays put** and the hub **auto-spawns a successor** that re-attaches to
   the project on register (`jarvis-core.mjs:765`). That successor is booted to `GET /handoff?cs=`
   and resume — i.e. a *role* any fresh session assumes. This is exactly model **B**. What's thin
   is *what* it rehydrates from: today just a one-line summary + freeform notes + a board
   snapshot.
3. **Missions are already durable, pinned, and phased.** `missions.json` (in `DATA`, outside the
   repo) holds long-running objectives with phases + doc links, survives restarts, renders in a
   pinned rail, and is voice-gated to close (`jarvis-core.mjs:401`). **"PrimeNG 17 → 18 upgrade"
   is already a seeded mission.**

So Chris's "PrimeNG" already exists twice — as a *mission* (the goal) and as a potential
*project* (the worker-hosting column). They're just not linked, and neither holds the rich,
rebuildable context the manager needs.

## The gaps (what's actually missing)

| # | Gap | Today | Needed |
|---|-----|-------|--------|
| G1 | Rich durable project context | thin handoff: 1 summary + notes | a structured, appendable project context store the manager rehydrates from |
| G2 | Sub-workers under a project | a project hosts exactly ONE worker; others get separate NATO cards | a manager + N ephemeral sub-workers nested under the project |
| G3 | Worker outcomes feed the context | a retired worker's summary is archived per-cwd | a sub-worker's outcome auto-appends to its project's context ("rebuild from recent work") |
| G4 | Mission ↔ project link | separate, unrelated | a project points at its mission; rail shows goal/phases + live context + workers together |
| G5 | Console nesting | flat cards | project as a top-level group: manager pinned, sub-worker tabs nested, context visible |

## Model B, concretely

**The project's data is the durable thing; "manager" is a role any session rehydrates into.**

### New durable store: `projects.json` (in `DATA`, like missions)
```
{ version, projects: [ {
    name,                 // 'primeng' — matches the .project tag + board column
    title,                // 'PrimeNG 17 → 18'
    status,               // active | paused | archived
    missionId,            // optional link to the missions.json objective
    managerUid,           // the currently-bound manager session, or null (idle)
    context: {
      summary,            // manager-curated "where this project stands" prose
      currentFocus,       // one line: what's being worked right now
      openThreads: [],    // unresolved decisions / TODO threads
      recentLog: [],      // append-only: {ts, from, note} — worker outcomes + manager checkpoints
      docs: []            // links (PRD, spec, notes doc)
    },
    workers: [ {callsign, purpose, status, startedAt, endedAt, outcome} ],  // roster incl. retired
    createdAt, updatedAt
} ] }
```
Same robustness pattern as missions: `atomicWrite`, `backupCorrupt` on bad parse (never silent
reset).

### The manager (role, not an immortal process)
- On register with `project=X`, boot prompt says: *you are the MANAGER of project X. `GET
  /project?name=X` to rehydrate your durable context (summary, current focus, open threads,
  recent log, sub-worker outcomes) — resume from there, don't start cold. Keep it current via
  `POST /project-context` as you work.*
- This replaces "start cold + read a thin handoff" with "rehydrate a living project brief." It is
  the highest-value piece and it directly answers "rebuild the context from what we've been
  working on recently."

### Sub-workers (ephemeral, nested)
- The manager (or Chris via the `+`) spawns a sub-worker with `parentProject=X`. It carries
  `.parentProject` (distinct from the manager's `.project`, so `projectWorkerUid` stays
  unambiguous — the manager is the single `.project=X`, sub-workers are `.parentProject=X`).
- A sub-worker gets its own transient NATO card, **rendered nested under project X** in the
  console, and comes/goes freely.
- On `/retire`, a sub-worker's summary is **auto-appended to X's `context.recentLog`** and its
  entry in `workers[]` is closed with the outcome — so the manager rebuilds from recent work with
  zero manual bookkeeping (G3).

### Mission ↔ project
A **mission** is the *objective* (PrimeNG 17→18 + phases + progress). A **project** is the durable
*operational container* (manager + sub-workers + rebuildable context). Link them 1:(0..1) via
`project.missionId`. The rail shows the mission's goal/phases up top and the project's live
context + workers below it. (Default proposal — see open questions.)

## Phasing

- **P1 — durability spine (highest value, smallest blast radius).** Add `projects.json` + the
  context store + `GET /project` / `POST /project-context`. Elevate the existing `jarvis` project
  to use it; manager rehydrates on boot and checkpoints as it works. Minimal console: show the
  project context on the existing project card. **This alone fixes "I lose big projects."**
- **P2 — sub-workers under a project.** `parentProject` on spawn + roster; auto-append retired
  sub-worker outcomes to the project log; console nests sub-worker tabs under the project group.
- **P3 — mission↔project + unified rail.** Link `missionId`; render goal/phases + context +
  workers as one project rail. Optional: manager auto-proposes the next sub-worker from open
  threads.

## Open questions for Chris

1. **Project ↔ mission cardinality.** 1 project ↔ 0-or-1 mission (my default), or can one project
   carry several missions / a mission span projects?
2. **Who spawns sub-workers** — the manager autonomously when it sees a task, or only Chris via
   the `+`? (Default: both — manager proposes, Chris can also spawn.)
3. **Context content** — auto-derived (from board + retired-worker outcomes) only, manager-curated
   prose only, or both? (Default: both — an auto append-only log + a manager-curated "current
   state" summary.)
4. **First project.** Stand up **PrimeNG** as the first real project (linked to its existing
   mission) to dogfood P1?
