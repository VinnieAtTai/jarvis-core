# JARVIS Console + Hub Rebuild Plan

One coordinated pass that (1) splits the two monoliths into modules, (2) lands the Mission
Control UX on the new module seams, (3) folds hardening in as **visible telemetry**, and (4)
finishes portability so `git clone jarvis-core` + `JARVIS_DATA=<jarvis-brain checkout>` runs on any
machine. Written against the actual code as of this branch (11 commits ahead of `origin/main`;
`npm test` = **150 green**).

## Goal & one-pass rationale

Doing these as four separate efforts fights itself: the UX work wants clean component boundaries
that don't exist yet; the hardening items (voice-focus lock, per-station EKG, health strip) are
*new UI surfaces* that only make sense once the board/voice-strip/telemetry code is separable; and
portability touches the same route/boot-prompt code the split moves. So the order is fixed:

1. **Modular spine first** (the risky, supervised step) — behavior-preserving extraction, test
   suite green at every commit. This is the load-bearing step; everything else lands on it.
2. **Mission Control UX** — new rails/board/voice-strip built *as modules against the spine*, not
   bolted onto the monolith.
3. **Hardening as telemetry** — the two already-staged fixes ship as the first slice; the new
   guards (voice-focus LOCK, heartbeat EKG, 80% guard, health strip) are telemetry modules that
   read hub state the spine now exposes cleanly.
4. **Portable by construction** — the audit below; finish code/state separation.

The **test-green gate** (`npm test`, 150 tests, ~230ms, no server boot) is the invariant across all
four. Every extraction commit must keep it green; that is what makes the split *supervised* rather
than a rewrite.

## Current-state inventory

| File | Lines | Role | Testable today? |
|---|---|---|---|
| `jarvis-core.mjs` | **2902** | The hub: fs/state I/O, roster, worklist, missions, projects, schedule, spawn (ConPTY + wt), speech routing (`handleUtterance`), the entire HTTP route table (`handleRequest`), Playwright console host, say/cmd pump loop | No — truncates `say.txt` + binds the port on import |
| `console.js` | **1910** | Browser console: chat render, board render, missions rail, schedule/next panels, archive+hold panels, tabs, ASK tab, new-session composer, add-task bar, voice (webkitSpeechRecognition + local whisper capture/VAD/WAV) | No — DOM globals, `webkitSpeechRecognition` |
| `jarvis-text.mjs` | 595 | **Already-extracted** pure helpers (parsers, board/mission/project/perm/focus logic). 43 exports. The proven extraction template. | Yes — `test/text.test.mjs` + 9 others |
| `stt.mjs` | 132 | Local whisper-server lifecycle + transcribe bridge. Already a clean module. | `test/stt.test.mjs` |
| `screen.mjs`, `tokens.mjs`, `usage.mjs` | small | Screen capture, token-heat scan, real-usage fetch. Already modules. | `tokens` indirectly |
| `perm-hook.mjs` | ~110 | Claude Code permission hook (child-process, reads `JARVIS_PORT`). | — |
| `guardian.mjs`, `spawn-hub-detached.mjs` | 56 / 90 | OS guardian + console-less supervisor. | — |
| `test/` | 10 files, **150 tests** | Pure-logic coverage: `ai, body, focus, handoff, mission, projects, roster, stt, text, worklist`. | the gate |

### What's already staged / unstaged (do NOT re-derive these)

| Change | Git state | Files | What it does |
|---|---|---|---|
| **Console pane-lock** (view pin) | **staged** | `console.css`, `console.html`, `console.js` | Adds a `🔓 LOCK / 🔒 LOCKED` button (`#lockview`) + `viewLock` flag. While locked: chat won't auto-scroll to new posters, `renderTabs` won't bounce the tab to "all", `renderBoards` freezes the focus highlight (`focusCS`). Amber `.btn.locked` + `#chat.locked` frame. Session-local. |
| **Focus-steal guard** | **unstaged** | `jarvis-core.mjs`, `jarvis-text.mjs`, `test/focus.test.mjs` (untracked) | New pure helpers `focusHolderUid` + `focusHeldByLiveOther` in `jarvis-text.mjs`; `registerSession` now grabs focus only when idle (`!focusHeldByOther`), so a successor/sub-worker register can't yank the human off a live coordinator mid-walkthrough. 9 new tests already pass. |

Both are **behavior-additive and already green** — they are the *first slice* of Workstream 3, not
new work. First action of the rebuild: commit them (guard commit is a clean logical unit:
`jarvis-text.mjs` + `jarvis-core.mjs` + `test/focus.test.mjs`; pane-lock is its own console-only
commit).

---

## Workstream 1 — Modular spine (do first; supervised)

Behavior-preserving. `jarvis-text.mjs` is the template: pure logic already lives there and is
unit-tested. The split pushes **more logic out of the two monoliths into importable modules**, and
thins each monolith to a thin composition root (`jarvis-core.mjs` wires modules + owns `main()`;
`console.js` becomes an entry that imports render/voice modules).

Key constraint that shapes everything: `jarvis-core.mjs` **cannot be imported in a test** today
(side effects at module top: `writeFileSync(SAY,'')`, `server.listen`). The split's real prize is
moving state + route logic into modules that *can* be imported, widening the test gate over time.
`console.js` runs in the Playwright/browser context and uses ES-module-free globals; its split is
DOM-module decomposition loaded via `<script type="module">` (or concatenated), not node `import`.

### 1a. Hub split (`jarvis-core.mjs` → modules)

Proposed new files, and exactly what moves into each:

| New module | Moves in (functions / handlers / state) | Public exports | Depends on |
|---|---|---|---|
| `hub/paths.mjs` | The env-resolution block: `HERE`, `DATA`, `USER_DATA`, `PORT`, `ORIGIN`, `NO_UI`, `PROJECTS`, `AI_CAP`, `SESSION_BUDGET`, and all `join(DATA,…)` file constants (`TRANSCRIPT, SAY, CMD, WORKLIST, SESSIONS, BUS, BUSBASE, REPOS, SCHEDULE, MISSIONS, PROJECTS_FILE, AI_THREADS, AI_SPEND, ARCHIVE, WORKER_DOC, CRASHLOG`) | all the above as `const` exports | `node:path`, env |
| `hub/store.mjs` | `atomicWrite`, `backupCorrupt`, `loadJsonl`, `drainWholeFile`, `trimTranscript`, `trimBus`, plus the id gens (`newTaskId, newMissionId, newThreadId`) | those fns | `paths`, `record` (inject) |
| `hub/roster.mjs` | `loadRoster, saveRoster, saveRosterThrottled, registerSession, retireSession, setAway, assignCallsign, liveUidOf, projectWorkerUid, liveCallsigns, aliveNow, watchingNow, csFrom, voiceMutedFrom`, and the `roster`/`pendingPins`/`pendingTier` state | those fns + `roster` accessor | `paths, store, jarvis-text` (`focusHeldByLiveOther`, `pickProjectWorker`, `handoffKey`), `spawn` (inject `spawnWorker`) |
| `hub/worklist.mjs` | `loadWork, saveWork, ensureBoard, findTaskAll, makeTask` | those fns | `paths, store, jarvis-text` (`migrateWork, textOf, WORK_VERSION`) |
| `hub/missions.mjs` | `makeMission, seedMissions, loadMissions, saveMissions, activeMissionsView` | those fns | `paths, store, jarvis-text` (`normalizeMission, missionProgress`) |
| `hub/projects.mjs` | `makeProject, seedProjects, loadProjects, saveProjects, getProject, ensureProject, appendProjectLog, setProjectManager, updateProjectContext, projectsView, compactProjectContext, projectContextFor` | those fns | `paths, store, jarvis-text` (`normalizeProject, pushCapped, PROJECT_LOG_CAP`) |
| `hub/schedule.mjs` | `loadSchedule, saveSchedule, pruneReminders, createReminder` + the 15s reminder/meeting-fire interval body | those fns + `startScheduleTimer(deps)` | `paths, store, jarvis-text` (`parseScheduleText, parseReminder, clk`), inject `enqueueSay, setMute` |
| `hub/ai.mjs` | `loadThreads, saveThreads, loadSpend, saveSpend, anthropicKey, callAnthropic`, `AI_SYSTEM` | those fns | `paths, store, jarvis-text` (`AI_MODELS, aiCost, monthKey, rollSpend, capExceeded`) |
| `hub/spawn.mjs` | `resolveRepo, loadRepos, findRepo, chromeExe, workProfileDir, withWorkAccount, openInWorkChrome, resolveClaude, spawnWorkerConsoleless, spawnWorker, reviveMissionCoordinator, coordinatorBooting`, `workerPtys`, `getPty` | `spawnWorker` + repo helpers | `paths, roster (inject), jarvis-text` (`subworkerBrief, lastProjectCwd`) |
| `hub/tts.mjs` | `enqueueSay, voiceMutedFrom, setMute`, `sayQueue`, `muted/autoMutedBy`, phone push (`NOTIFY, saveNotify, pushPhone`), and the `pump()` closure factory | `enqueueSay, setMute, makePump(deps)` | `paths, store, roster (inject)` |
| `hub/bus.mjs` | `busAppend, eventsFor, releaseWaiters`, `bus/busBase/pollWaiters` state, `SPEECH_DEBOUNCE` | those fns + `bus` accessor | `paths, store` |
| `hub/tokens-view.mjs` | `refreshTokens, refreshRealUsage, tokenStats` + the two intervals | `getTokenStats(), startTokenTimers()` | `tokens.mjs, usage.mjs, paths` |
| `hub/utterance.mjs` | the whole `handleUtterance` + `routeTo` + `routeToMission` + `pendingMissionClose` gate | `handleUtterance(deps)` | nearly everything above (inject as a deps object) |
| `hub/routes.mjs` | `handleRequest` (the ~40-endpoint `if (key === …)` table), `json, readBody, localRequestOk` | `makeRouter(deps)` → `(req,res)` | all hub modules (deps object) |
| `hub/console-host.mjs` | `openConsole, consoleAlive`, `freshAsset`, the `CONSOLE_HTML/CSS/JS` reads, `consolePageRef` | `startConsole(deps)` | `paths`, Playwright |
| `jarvis-core.mjs` (thinned) | `main()`, server creation, the crash/signal handlers, the say/cmd pump `while(running)` loop, wiring the deps object and passing it to `makeRouter`/`handleUtterance`/`startConsole` | — (entry) | every `hub/*` |

**Dependency shape.** Leaf layer `paths → store`. Then the pure-adjacent state modules
(`roster, worklist, missions, projects, schedule, ai, bus, tts`) depend on `store` + `jarvis-text`
and on each other only through an **injected deps object**, never a static import cycle. `spawn` ↔
`roster` is the one genuine cycle (retire spawns a successor; register touches the board) — break
it by having `roster.retireSession` take `spawnWorker` as an injected param (it already reads like
this internally). `routes` and `utterance` are the top composition consumers; `jarvis-core.mjs`
builds one `deps = { roster, worklist, missions, projects, schedule, ai, spawn, tts, bus, tokens,
enqueueSay, record, … }` object and threads it down. This mirrors the existing pattern where
`migrateWork(raw, makeTask, newTaskId)` is already passed its collaborators.

**`record`** is the awkward global (used by nearly every module). Define it in `hub/store.mjs`
(needs `TRANSCRIPT` + `transcriptCache` + `trimTranscript`) and inject it — do NOT let each module
re-import a transcript writer.

### 1b. Console split (`console.js` → modules)

Loaded as `<script type="module">` from `console.html`, or kept as classic scripts concatenated in
load order. Because there is no console-side test harness today, the split's win is **isolation for
the UX work**, not test coverage — so keep it strictly mechanical.

| New module | Moves in | Exposes |
|---|---|---|
| `ui/util.js` | `esc, escAttr, b64, unb64, fmtTok, fmtHM, fmtHMS, fmtCountdown, richText, inlineMd, linkify, selectionInside, doCopy, doCopyHtml, uiConfirm, uiToast, pathfly` | pure/DOM utils |
| `ui/voice-strip.js` | webkitSpeechRecognition (`rec, onresult, startRec, INSTANT, buf, flushBuf, armFlush, cancelUtterance`), `__speak/pickVoice/reportVoices`, `__setMute/__setPause/__setSttBackend`, the **entire local-STT block** (`startLocalCapture, finalizeUtterance, emitLocal, encodeWav16k, VAD`), status line | the voice state machine + `window.__jarvisHear` wiring |
| `ui/board.js` | `renderBoards` (the big one), `activityIndicator, watchIndicator, chipFor, TCHIPS, populateAddTaskCols, submitAddTask`, the `workEl.onclick` action table, next/schedule panel render | `renderBoards(d)` |
| `ui/missions-rail.js` | `renderMissions` + the `missionEl.onclick` phase toggle | `renderMissions(list, boards)` |
| `ui/chat.js` | `renderChat, renderTabs, pollChat, eventsForTab, missionChatSets, missionManagerCallsign, missionFilterBar, pinStripFor`, pins, reactions, the `chatEl` click handler, `viewLock`/pane-lock button | `renderChat, renderTabs` |
| `ui/session-drawer.js` | new-session composer (`toggleNewSession, nsSetMode, loadNsRepos, nsBuildMeetingOpts, spawnNewSession`), archive panel (`renderArchive, pollArchive`), hold panel (`renderHold, pollHold`), `sendTyped, populateSendTo` | composer + panels |
| `ui/ask-tab.js` | the whole ASK block (`aiState, applyTabMode, sendAi, loadAiThreads, openAiThread, renderAiMessages, renderModelSel, renderThreadSel, renderSpend`) | ASK tab |
| `ui/telemetry.js` | `pollHeat, renderHeat` today; **grows** to host the heartbeat EKG + health strip (Workstream 3) | `pollHeat` + new renderers |
| `console.js` (thinned) | shared DOM refs, wire modules, kick the polls (`pollChat/pollWork/pollHeat/pollArchive/pollHold`) | entry |

Shared mutable state that several modules read (`activeTab, focusCS, lastBoard, lastSched,
expanded, rawMode, pinned, viewLock`) becomes one small `ui/state.js` object all modules import,
rather than file-scope `let`s.

### 1c. Safe extraction order (least-risk first, gate green each step)

1. **Commit the two staged/unstaged fixes** (focus-guard, then pane-lock) so the working tree is
   clean before refactoring. — gate already green.
2. **`hub/paths.mjs`** — pure constants, zero logic. Import back into `jarvis-core.mjs`. `node
   --check` + `npm test`.
3. **`hub/store.mjs`** (+ move id gens) — leaf I/O, injected `record`. Lowest coupling after paths.
4. **`hub/ai.mjs`, `hub/tokens-view.mjs`** — self-contained, already lean on `jarvis-text`. Each is
   a standalone commit.
5. **`hub/missions.mjs`, `hub/projects.mjs`, `hub/worklist.mjs`, `hub/schedule.mjs`** — the
   state-file modules; each already leans on a `jarvis-text` pure core, so extraction is mostly
   moving the I/O wrapper. **New tests become possible here** (e.g. import `projects.mjs` with a
   temp `JARVIS_DATA` and assert `updateProjectContext`), widening the gate.
6. **`hub/bus.mjs`, `hub/tts.mjs`** — event + speech plumbing.
7. **`hub/roster.mjs` + `hub/spawn.mjs` together** (the one cycle) — inject `spawnWorker` into
   `retireSession`. Highest risk; do it as its own reviewed commit.
8. **`hub/utterance.mjs`** — move `handleUtterance` wholesale, pass a deps object.
9. **`hub/routes.mjs` + `hub/console-host.mjs`** — last, because they consume everything.
10. **Console split** — mechanical, after the hub is modular. `ui/util.js` first, then leaf
    renderers (`missions-rail, telemetry`), then `board`, then `chat`, then `session-drawer`,
    `ask-tab`, and `voice-strip` (voice last — most globals). Verify by loading the console
    (it's the only test for this half).

Each numbered step is one commit; each must pass `node --check jarvis-core.mjs` and `npm test`
before the next. If a step reddens the gate, it reverts cleanly (one commit).

---

## Workstream 2 — Mission Control UX (lands on the spine)

**Pixel-level visual spec lives in 4 external claude.ai artifacts not available here.** This section
is deliberately **structural only**: component boundaries, the data each rail needs from the hub,
and the DOM/module seams. Defer all sizing/color/spacing/typography to those artifacts.

Three shells, one console. A top-level `ui/shell.js` chooses the mode:

| Shell | Component boundary | Data it needs from the hub | Module seam |
|---|---|---|---|
| **Expanded (3-rail command console)** | Left rail = chat/tabs (`ui/chat.js`); center rail = Board (`ui/board.js`); right rail = mission tracker + schedule + telemetry (`ui/missions-rail.js` + `ui/telemetry.js` + schedule panel) | Everything already on `GET /board` (focus, boards[], missions[], muted/paused/stt) + `GET /schedule` + `GET /tokens` | The 3 rails are already the `#left` / `#right` split in `console.html`; the rebuild formalizes a 3rd rail out of `#right`'s stacked panels |
| **Legible Board (swim-lanes, WIP limits, nesting)** | `ui/board.js` re-rendered as lanes with elbow connectors for sub-worker nesting | `parentProject` (already on each card — commit `597d16f`/`eca1395` thread it), `projectContext.missionId`, per-lane task counts (already present: `working/queued/review/done`) | **Nesting data already exists**: `card.parentProject` + `card.projectContext?.missionId` are what `missionChatSets()` and `renderMissions` already group on. The board just needs to render the elbow connector instead of a flat card list. **WIP limits** are new: a per-lane cap is a *client-side* render concern (no hub change needed) unless persisted — if persisted, add a `wipLimits` field to the worklist board object |
| **Compact voice strip / now-playing bar** | `ui/voice-strip.js` collapsed shell: status + interim + mute/pause/STT + a "now-playing" line (who's speaking, last TTS) | `GET /board` (muted/paused/sttBackend/sttReady) + the local `speaking`/`sayQueue` state already in the voice strip | The status line (`#status`) + interim (`#interim`) already exist; compact mode is a CSS/layout state of `ui/voice-strip.js`, driven by `ui/state.js.shellMode` |

**What is genuinely new vs. re-skin:**
- *Re-skin only* (data already flows): 3-rail layout, mission nesting on the board, compact voice
  bar. The hub already emits `parentProject`, `missionId`, per-card context, and the mission view.
- *Small hub additions* if WIP limits are to be persisted: one field on the board object + one
  `/worklist` op. Otherwise client-only.

Guardrail: build each shell against the **module seams from Workstream 1**, never against the
monolith. If a rail needs data the hub doesn't emit, add it as a field on the existing `/board`
payload (it is already the single fan-in), not a new endpoint.

---

## Workstream 3 — Hardening as visible telemetry

Two already-staged fixes ship as the first slice; four new items follow. Each new item is *both* a
guard *and* a visible surface (Chris's framing: hardening the human can see).

| # | Item | Staged? | Hub side | Console side (telemetry) |
|---|---|---|---|---|
| H1 | **Focus-steal guard** | **unstaged, tested** | `focusHeldByLiveOther` in `registerSession` (done) | none needed; effect is "focus doesn't jump" |
| H2 | **Console pane-lock** | **staged** | none | `#lockview` LOCK button + `viewLock` (done) |
| H3 | **Voice-focus LOCK** | new | A latched "voice stays on <target> regardless of who registers/retires" flag on the hub, honored by `routeTo`/register focus logic (extends H1 from *don't steal on register* to *never re-target while locked*). Persist on the roster so it survives restart. | A lock control in the voice strip / on the focused card; amber like H2. Distinct from H2 (H2 = view pin, client-only; H3 = routing pin, hub-side) |
| H4 | **Per-station heartbeat EKG + gone-quiet alerts** | new | Data exists: `aliveNow` (lastSeen < 2min), `GET /heartbeat`, `s.lastSeen`. Add a small rolling lastSeen history (or expose `secondsSinceSeen`) on the `/board` card. Gone-quiet **alert** = the hub already nags on stale routed speech (`routeTo` nag); generalize to a proactive `enqueueSay`/phone push when a *working* station crosses a quiet threshold | `ui/telemetry.js` renders a per-card EKG sparkline from the heartbeat cadence; `activityIndicator` already computes stuck/idle/quiet — feed the EKG from the same signal |
| H5 | **80% context / handoff guard** | **partially exists** | `POST /health` already warns once at `ctx >= 80` (`ctxWarned`) via `enqueueSay`. Harden into a *guard*: at ≥80% auto-nudge the worker to checkpoint `/handoff` + suggest successor; escalate phone push | Health strip shows each station's ctx% with the existing color ramp (green/amber/red at 60/80) already in `renderBoards`; add an explicit "handoff advised" badge at ≥80 |
| H6 | **System-health strip** | new | Aggregate: hub uptime, worker count, any stale/quiet stations, AI spend vs cap, STT backend/ready, token heat. Almost all already on `/board` + `/tokens` + `/ai/threads`; add hub `uptime`/`startedAt` to `/board` | New `ui/telemetry.js` strip across the top/bottom of a rail; single source = existing polls, no new endpoint except the uptime field |

Sequencing within W3: **H1 + H2 first** (already done — just commit). H4/H6 are the same
`ui/telemetry.js` module, so build them together once the console is split. H3 and H5 are hub-side
guards that extend logic that already exists (`registerSession` focus, `POST /health` warn), so they
land right after `hub/roster.mjs` + `hub/routes.mjs` are extracted — cleaner to touch there.

---

## Workstream 4 — Portable by construction

The hub is **already substantially portable**: `JARVIS_DATA` (line 17), `JARVIS_PORT` (line 37),
`JARVIS_PROJECTS` (40), `CHROME_USER_DATA` (18), `JARVIS_STT_DIR`/`_PORT`/`_BIN`/`_MODEL`
(`stt.mjs`), `JARVIS_LINK_EMAIL` all resolve from env with sensible Windows fallbacks, and runtime
state defaults **outside the repo** (`%LOCALAPPDATA%\jarvis`). The finish line: `git clone
jarvis-core` + point `JARVIS_DATA` at a `jarvis-brain` state checkout and it runs with **zero
hardcoded paths**.

### Portability audit — findings (7)

| # | File:line | Finding | Severity | Portable replacement |
|---|---|---|---|---|
| P1 | `console.js:708` | `cwd: 'd:/claude/jarvis-core'` hardcoded in `spinUpMorning()` `/spawn` body | **High** — breaks spin-up on any other machine/checkout | Serve the hub's own repo root to the client (e.g. a `selfRepo` field on `/board` from `HERE`), or resolve via the registered repos list; never a literal |
| P2 | `console.js:963` | `cwd: 'd:/claude/jarvis-core'` hardcoded in the `spawnjarvis` board action | **High** — same as P1 | Same as P1 — both should read one client-side `SELF_REPO` seeded from the hub |
| P3 | `guardian.mjs:14` | `const PORT = 8124;` literal (not `process.env.JARVIS_PORT`) | **Medium** — guardian probes the wrong port if `JARVIS_PORT` is overridden | `Number(process.env.JARVIS_PORT || 8124)` — match the hub |
| P4 | `spawn-hub-detached.mjs:25` | `JARVIS_LINK_EMAIL: 'chris.vinciguerra@tai-software.com'` baked into the supervisor env | **Medium** — machine/user-specific; a public clone ships Chris's email | Read from env with fallback: `process.env.JARVIS_LINK_EMAIL || ''`; document in a `.env`/config that lives in `jarvis-brain`, not the public repo |
| P5 | `console.js:833` | `/jarvis-core/i.test(x.cwd)` heuristic to find the jarvis worker's ctx | **Low** — a differently-named clone dir wouldn't match | Match on `card.project === 'jarvis'` (already available) instead of a cwd regex |
| P6 | `stt.mjs` / `paths` | Non-Windows fallback for `DATA` is the repo dir (`HERE`) when `LOCALAPPDATA` is unset | **Low** — on Linux/Mac state would land in the repo, which `git clean -x` wipes | Fall back to `~/.jarvis` (or `$XDG_DATA_HOME/jarvis`) rather than `HERE` when `LOCALAPPDATA` is unset |
| P7 | `console.js` `/spawn` bodies use `d:/claude/jarvis-core` | (same literals as P1/P2; noting the *pattern*) — any future hardcoded cwd in a client `/spawn` is a portability regression | **Process** | Add a lint/grep check in CI-equivalent: no `[A-Za-z]:[\\/]` literals in `console.js`/`*.mjs` outside tests |

**Note:** the `d:\claude\jarvis-core` strings in `test/*.mjs` and `jarvis-text.mjs:550` (a comment
example) are **not** findings — they are test fixtures / illustrative comments, correctly isolated
from runtime.

### Code/state separation to finish

- The split's `hub/paths.mjs` becomes the **single place** any path is resolved — makes the audit a
  one-file review forever after.
- Fix P1/P2/P5 by having the hub emit its own repo root (`HERE`) once on `/board` as `selfRepo`, and
  the console referencing that instead of a literal.
- Document the two-repo model (public `jarvis-core` code + private `jarvis-brain` state via
  `JARVIS_DATA`, per the memory note "Transfer prefers git repos") in a short README section.

---

## Risks & the test-green gate

| Risk | Mitigation |
|---|---|
| Hub monolith isn't test-importable (top-level side effects) | The extraction *creates* importability incrementally (step 5 onward). Until then the gate = `node --check` + the 150 pure tests; the untested I/O paths are covered by keeping extraction mechanical (move, don't rewrite) |
| `roster ↔ spawn` cycle | Break by dependency injection (`retireSession(uid, summary, { successor, spawnWorker })`) — the code already reads this way internally |
| Console has no test harness | Console split stays strictly mechanical; verify by loading the console after each step. UX (W2) waits until the split is done so it isn't debugging layout + refactor at once |
| A deps-object refactor silently drops a collaborator | One module per commit; `node --check` catches missing imports; the 150 tests catch pure-logic breakage; smoke-boot the hub (`JARVIS_PORT=8199 JARVIS_DATA=<scratch> JARVIS_NO_UI=1 node jarvis-core.mjs`, per the scratch-verify memory) after risky steps |
| Behavior drift in `handleUtterance` (huge, regex-heavy) | Move it *verbatim* into `hub/utterance.mjs`; do not "clean it up" in the same commit |
| Merge conflict with the live hub (Chris runs it) | The scratch-port verify recipe isolates test boots on port 8199 + a scratch `JARVIS_DATA`, so refactor verification never touches the live hub |

**The gate, stated once:** every commit in W1 and every hub-side change in W3/W4 must pass
`node --check jarvis-core.mjs && node --check console.js` **and** `npm test` (150 green) before the
next commit. That is non-negotiable and is what makes the spine split supervised rather than a
rewrite.

---

## Suggested sequencing & delegation

**Serial (one owner, supervised — the spine):**
- Commit staged fixes → `hub/paths` → `hub/store` → the state modules → `roster`+`spawn` →
  `utterance` → `routes`+`console-host`. This is the critical path; parallelizing it invites
  merge pain because every step touches `jarvis-core.mjs`'s import list + wiring.

**Parallelizable once the spine exists (delegate to sub-workers):**

| Parallel track | Depends on | Good sub-worker boundary |
|---|---|---|
| Console module split (`ui/*`) | Hub split done (so route/data shapes are final) | One worker; mechanical; verify by loading console |
| W2 shells (3-rail, board nesting, voice bar) | `ui/board.js` + `ui/chat.js` + `ui/voice-strip.js` extracted; the 4 external artifacts | Can split into board-worker vs voice-strip-worker vs shell-layout-worker once modules exist |
| W3 telemetry (H4 EKG + H6 health strip) | `ui/telemetry.js` extracted + hub emits `uptime`/`secondsSinceSeen` on `/board` | One worker owns `ui/telemetry.js` end-to-end |
| W3 hub guards (H3 voice-lock, H5 handoff guard) | `hub/roster.mjs` + `hub/routes.mjs` extracted | One worker; small, hub-side; each has an existing seam to extend |
| W4 portability fixes (P1–P7) | `hub/paths.mjs` exists (single path source); hub emits `selfRepo` | One worker; independent of UX; can start right after `hub/paths` lands |

**Must be serial:** the hub extraction chain (shared file), and W2 cannot begin before its
`ui/*` modules exist. **Can be concurrent:** W4 portability + W3 hub guards (different files) once
`hub/paths` + `hub/roster`/`routes` are out; all four `ui/*`-based tracks after the console split.
