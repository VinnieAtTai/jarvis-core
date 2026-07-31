# JARVIS v1 — the current system, as built

**Audience: the agents building v2.** This is a description of what EXISTS, not a design for what
comes next. It is deliberately stack-independent: the v2 back-end language (Node vs .NET) is still
open with Chris, so nothing here assumes one. Where v1 makes a choice that v2 will have to re-make,
this says so and stops.

> **Line numbers are pinned to `main` 43d5828.** They were re-derived against that tree, and 45
> spot-checks confirm each cited line still holds the thing claimed of it.
>
> **When they drift — and they will — grep the anchor, not the number.** Every citation names a
> function, a route key, or a distinctive comment alongside its line, and that anchor is what
> survives. A merge that touches `jarvis-core.mjs` above line 1808 or `jarvis-text.mjs` above 1347
> moves everything below it; the previous revision of this file was written against bfcedcf and
> needed a +42 / +117 correction one merge later. Re-pin by anchor and update this header, rather
> than letting the numbers rot into the confidently-wrong state §9 catches three other documents in.

Sizes, so you know what you are reading against (`main` 43d5828, measured 2026-07-31):

| File | Lines | Role |
| --- | --- | --- |
| `jarvis-core.mjs` | 5051 | the hub: HTTP server, voice dispatch, roster, spawn, TTS pump. All side effects live here. |
| `jarvis-text.mjs` | 2026 | pure helpers, no I/O. Predicates and shaping only — see §5 for the trap. |
| `console.js` | 2407 | the whole browser UI. Vanilla JS, no framework, no build step. |
| `console.html` | 33 | the region skeleton (§7). |
| `console.css` | ~1000 | styling. |
| `db.mjs` | 445 | SQLite reporting store (`node:sqlite`). Additive, best-effort, non-load-bearing. |
| `stt.mjs` | 131 | local whisper.cpp bridge for the offline STT backend. |
| `screen.mjs` | 39 | screenshot capture. |
| `pty-host.mjs` | 111 | ConPTY host process for a console-less worker. |
| `perm-hook.mjs` | 127 | Claude Code `PreToolUse` hook → `POST /permission`. |
| `tokens.mjs` / `usage.mjs` | 100 / 43 | token-burn estimate from local transcripts / real usage API. |
| `guardian.mjs`, `spawn-hub-detached.mjs`, `orphan-spawn.mjs` | 67 / 89 / 32 | watchdog + detached launch. |

---

## 0. The shape of the thing

One Node process (`jarvis-core.mjs`) is the hub. It:

1. Serves HTTP on `127.0.0.1:8124` (`main`, `jarvis-core.mjs:4917`; bind at 4881-4893).
2. Owns a Playwright-driven Chrome window that IS the console — and the microphone, and the
   text-to-speech voice (`openConsole`, `jarvis-core.mjs:4961-4982`).
3. Holds all state in memory and mirrors it to JSON files in `JARVIS_DATA` (§6). No external DB.
4. Spawns Claude Code worker sessions, each of which talks back over the same HTTP API (§4).

There is no auth, no user model, and no network exposure: it binds `127.0.0.1` explicitly
(`jarvis-core.mjs:4925`) and every mutating request must pass an origin/host check (§1.1).

The single event loop is load-bearing. `GET /poll` long-polls for up to 25s
(`POLL_HOLD_MS`, `jarvis-core.mjs:1080`) by parking the `res` object in an in-memory array
(`pollWaiters`, `jarvis-core.mjs:213`) — so a synchronous stall in any handler stalls every worker's
inbox. `GET /search` explicitly breaks its archive scan across `await`s for this reason
(`scanArchiveBackwards`, `jarvis-core.mjs:456`; rationale at 88-99).

### 0.1 Processes around the hub

- **The watchdog / supervisor** relaunches the hub on hard exit. `POST /restart` clears the `STOP`
  sentinel then sets `running = false` (`jarvis-core.mjs:4900-4906`); `POST /winddown` *writes*
  `STOP` so the watchdog stops instead of relaunching (`jarvis-core.mjs:4892`). The sentinel file is
  `join(DATA, 'STOP')` and is cleared on every boot (`jarvis-core.mjs:123`).
- **A worker host** (`pty-host.mjs`) owns a ConPTY per console-less worker and deliberately outlives
  the hub, which is why retire must kill it explicitly (`killWorkerHost`, `jarvis-core.mjs:2484`,
  called from `retireSession` at 1436).
- **The permission hook** runs inside each worker's Claude Code process and POSTs to `/permission`,
  blocking until the human answers (§2.20).

### 0.2 Environment variables

Complete list, from a grep of `process.env` across the hub and its helpers:

| Var | Default | Effect |
| --- | --- | --- |
| `JARVIS_DATA` | `%LOCALAPPDATA%\jarvis` | state dir (`jarvis-core.mjs:53`) |
| `JARVIS_PORT` | 8124 | listen port (`jarvis-core.mjs:77`) |
| `JARVIS_NO_UI` | unset | skip the Chrome console entirely (`jarvis-core.mjs:79`) |
| `JARVIS_POLL_HOLD_MS` | 25000 | long-poll hold (`jarvis-core.mjs:1080`) |
| `JARVIS_SPEECH_DEBOUNCE` | 4000 | speech batching window (`jarvis-core.mjs:1593`) |
| `JARVIS_WEDGE_SWEEP_MS` | 15000 | deaf-coordinator sweep (`jarvis-core.mjs:1267`) |
| `JARVIS_BATON_STALE_MS` | 300000 | merge-lane reclaim (`jarvis-core.mjs:2300`) |
| `JARVIS_WORKTREES` | on | `=0` disables worktree isolation (`jarvis-core.mjs:1794`) |
| `JARVIS_WT_ROOT` | `<repo>/../.jarvis-wt` | where worktrees are cut (`jarvis-core.mjs:1793`) |
| `JARVIS_CONSOLELESS` | on | `=0` reverts to visible `wt` tabs (`jarvis-core.mjs:2394`) |
| `JARVIS_AI_CAP` | 20 (USD) | monthly cap for the ASK tab (`jarvis-core.mjs:70`) |
| `JARVIS_ARCHIVE_SCAN_CAP` | 64 MiB | `/search` archive read bound (`jarvis-core.mjs:104`) |
| `JARVIS_SESSION_BUDGET`, `JARVIS_REAL_USAGE` | 0 / off | token-meter tuning (`jarvis-core.mjs:241,269`) |
| `JARVIS_PROJECTS` | `~/.claude/projects` | where `tokens.mjs` scans for burn (`jarvis-core.mjs:80`) |
| `CHROME_USER_DATA` | `<repo>/chrome-profile` | console profile dir (`jarvis-core.mjs:54`) |
| `ANTHROPIC_API_KEY` | — | ASK tab; a repo-root `anthropic-key.txt` wins (`jarvis-core.mjs:901-904`) |
| `JARVIS_SPAWN_TIMEOUT_MS`, `JARVIS_READOPT_GRACE_MS` | 90000 / — | spawn-death + boot-reconcile windows |
| `JARVIS_WHISPER_BIN`, `JARVIS_WHISPER_MODEL`, `JARVIS_STT_DIR`, `JARVIS_STT_PORT` | — | local STT (`stt.mjs`) |
| `JARVIS_CALLSIGN` | — | set INTO a spawned worker's env, not read by the hub |
| `JARVIS_CLAUDE_CONFIG`, `JARVIS_LINK_EMAIL`, `JARVIS_NTFY_URL`, `JARVIS_SUPERVISOR` | — | trust-mark path, work-Chrome account, push fallback, supervisor handshake |
| `JARVIS_INTEGRATION` | unset | **test gate only.** Without `=1`, `node --test` silently SKIPS every integration test. |

---

## 1. HTTP surface

### 1.1 Request handling, common to every route

- One function dispatches everything: `handleRequest` (`jarvis-core.mjs:3311`). Routing is a flat
  chain of `if (key === 'METHOD /path')` on `key = req.method + ' ' + u.pathname`
  (`jarvis-core.mjs:3313`). There is no router, no middleware, and **no path parameters anywhere** —
  every identifier travels as a query string or a JSON body field.
- **Mutation guard.** Any method other than GET/HEAD must satisfy `localRequestOk`
  (`jarvis-core.mjs:3303-3309`): `Host` must be exactly `127.0.0.1:<PORT>` or `localhost:<PORT>`,
  and `Origin`, *if present*, must match. Failure is `403 {error:'forbidden: request must originate
  from the local console'}` (3315-3317). Worker/`curl` traffic sends no `Origin`, so it passes
  untouched; this exists to stop a visited web page firing `fetch()` at the hub, and DNS rebinding.
- **Bodies** are collected as Buffers and decoded once (`readBody`, `jarvis-core.mjs:3286-3296`) —
  concatenating decoded chunks would corrupt a multibyte character split across a chunk boundary.
  Hard cap 30 MB, enforced by destroying the socket (3293). Parsing is *lenient*
  (`parseBodyLenient`, `jarvis-text.mjs:1163`), so a slightly malformed body may still be accepted.
- **Responses** are `application/json; charset=utf-8` via `json(res, code, obj)`
  (`jarvis-core.mjs:3282-3285`), except `/protocol` (text/plain), `/att` (image), and the three
  console assets.
- **Unmatched paths fall through to the console HTML** (`jarvis-core.mjs:4913-4914`) with
  `cache-control: no-store, no-cache, must-revalidate`. There is **no 404 for an unknown path** —
  a typo'd endpoint returns the console page with status 200. v2 should not inherit this.
- **Errors** are caught at the server callback and returned as `500 {error: message}`
  (`jarvis-core.mjs:4919-4921`).
- Console assets are read fresh from disk per request (`freshAsset`, `jarvis-core.mjs:202`;
  served at 4869-4870), so a console-only change is live after a browser **reload** — only
  server-side changes need a hub restart.

### 1.2 The complete route table

**71 route keys.** The brief that commissioned this doc listed 21; the other 50 are enumerated
below. Ordered as they appear in `handleRequest` so the file reads top-to-bottom against it.

| Line | Route | One-line purpose |
| --- | --- | --- |
| 3318 | `GET /worklist` | raw `worklist.json`, unprojected |
| 3319 | `GET /board` | **the console's main view.** Projected cards; see §1.3 |
| 3391 | `GET /missions` | raw `missions.json` |
| 3392 | `GET /projects` | projected project list (`projectsView`, 826) |
| 3393 | `GET /project?name=` | one project's compact context; 404 if unknown |
| 3400 | `POST /project-context` | manager checkpoints curated context + appends a log line |
| 3409 | `POST /project` | `op: rename \| bind` — structural project ops |
| 3480 | `POST /trust` | flip one live session's trust tier (`trusted`/`guarded`) |
| 3497 | `GET /roster` | live + last-20-retired sessions, plus `build` and `deadSpawns` |
| 3546 | `GET /archive` | retired-session epitaphs; `?uid=` for one full entry |
| 3574 | `GET /report` | SQLite reporting store read: `?view=work\|sessions\|tasks` |
| 3653 | `GET /baton` | merge-lane state (reaps stale holders first) |
| 3664 | `POST /baton` | `op: request \| release \| cancel \| force` |
| 3755 | `GET /repos` | registered repo list for the console's `+` composer |
| 3761 | `GET /hold` | parked projects (On Hold) |
| 3770 | `POST /hold` | park a live session or a bare cwd+purpose |
| 3798 | `POST /unhold` | pull a parked project back (respawns it) or `{drop:true}` |
| 3836 | `GET /att?n=` | serve a saved attachment by filename |
| 3846 | `GET /transcript?limit=` | chat feed projection. **Excludes `msg`** — see §3.5 |
| 3886 | `GET /search?q=` | full-history chat search across cache + archive |
| 3973 | `GET /mission-chat?missionId=` | durable mission-keyed conversation |
| 4002 | `GET /tokens` | token burn / heat / session % |
| 4005 | `GET /screen?uid=` | follow-up screenshot. **Voice-gated**, 403 otherwise |
| 4019 | `GET /protocol` | serves `WORKER.md` as text/plain — every worker's boot read |
| 4024 | `GET /poll?uid=&cursor=` | **the worker inbox.** Long-poll; see §3 |
| 4064 | `GET /heartbeat?uid=` | liveness only; never blocks, returns no events |
| 4080 | `POST /register` | create a session; see §4.1 |
| 4088 | `POST /away` | away mode on/off (auto-trusts live sessions) |
| 4093 | `POST /health` | `{context:0-100, doing}` — the board's context bar + doing line |
| 4110 | `POST /watch` | a watcher session reports it is watching a channel |
| 4122 | `GET /notify` | ntfy push URL + configured flag |
| 4125 | `POST /notify` | set the ntfy URL |
| 4131 | `POST /notify-test` | fire a test push |
| 4137 | `POST /describe` | change a session's `purpose` |
| 4147 | `POST /send` | worker→human (transcript) or worker→worker (bus). Receipt; see §2.5 |
| 4180 | `POST /say` | speak a line aloud |
| 4195 | `POST /react` | append a reaction to a message by its `ts` |
| 4206 | `POST /focus` | set the single global focus |
| 4227 | `POST /spawn` | launch a worker; the third of three spawn sites |
| 4277 | `POST /permission` | **blocking.** The hook asks; the human answers |
| 4301 | `POST /permission-answer` | answer one pending permission |
| 4322 | `POST /permission-answer-all` | answer every pending permission for one session |
| 4345 | `POST /attach` | base64 file → disk + a `screenshot` bus event |
| 4363 | `POST /forget` | delete a board column (guarded; see §2.9) |
| 4433 | `POST /worklist` | **the board mutation endpoint.** 8 ops; see §2.7 |
| 4530 | `POST /mission` | `op: add\|phase\|unphase\|title\|doc\|undoc\|archive\|reactivate` |
| 4576 | `POST /retire` | end a session, optionally spawning a successor |
| 4589 | `POST /handoff` | checkpoint a handoff while live (latest wins) |
| 4614 | `GET /handoff?cs=\|cwd=&purpose=` | read a predecessor's handoff |
| 4647 | `POST /repos` | register/amend a repo |
| 4662 | `POST /voices` | console reports which TTS voices exist (log only) |
| 4667 | `POST /mute` | global mute |
| 4672 | `POST /pause` | pause listening (discard speech) |
| 4678 | `POST /stt-backend` | switch google ↔ local whisper |
| 4685 | `POST /stt` | transcribe one base64 WAV via the local backend |
| 4701 | `POST /voicemute` | silence one session's spoken lines |
| 4712 | `POST /open` | open a URL/path in work Chrome |
| 4720 | `POST /reveal` | `explorer.exe /select,` a path |
| 4732 | `GET /ai/threads` | ASK tab: thread list + spend + models |
| 4743 | `GET /ai/thread?id=` | one ASK thread with messages |
| 4749 | `POST /ai/newthread` | create an ASK thread |
| 4758 | `POST /ai/deletethread` | delete an ASK thread |
| 4764 | `POST /ai/send` | call the Anthropic API directly; spend-capped |
| 4802 | `GET /schedule` | today's meetings + reminders + `next`/`current`/`stale` |
| 4818 | `POST /schedule` | load a schedule from an events array or pasted text |
| 4847 | `POST /remind` | create a reminder (`{title,start}` or NL `{text}`) |
| 4864 | `POST /hear` | **inject an utterance.** The typed-input path into §5 |
| 4869 | `POST /winddown` | retire everyone and stop the hub; `{dry:true}` to preview |
| 4900 | `POST /restart` | stop for the watchdog to relaunch |
| 4911 | `GET /console.css` | asset, no-store |
| 4912 | `GET /console.js` | asset, no-store |
| 4913 | *(fallthrough)* | `console.html` for **every** other path |

### 1.3 `GET /board` — the projection v2 has to reproduce

`jarvis-core.mjs:3319-3390`. This is the endpoint that matters most for a PrimeNG rebuild: the
console polls it every 1.5s and renders almost everything from it. It is a **join** across five
stores, done in-process, with a documented one-read-per-request discipline (3321, 3325) and **no git
calls** (3324).

Response envelope (3389):

```
{ focus, muted, paused, sttBackend, sttReady, awayUntil, missions:[...], boards:[ card, ... ] }
```

Card ordering (3340-3343): focus first, then live non-project callsigns, then `jarvis`, then any
remaining board column. Note the filter at 3298 — a session carrying `.project` is **excluded** from
the live list, because it renders as its project's card instead.

Per-card fields, with why each exists:

| Field | Source | Note |
| --- | --- | --- |
| `callsign` | board key | a NATO callsign **or** a project name |
| `uid` | `liveUidOf(cs) \|\| projectWorkerUid(cs)` | null for an idle project card |
| `worker` | 3310 | the NATO callsign driving a project card — a bound coordinator has **no card of its own** |
| `cwd` | 3322 | for an idle project card, falls back to `lastProjectCwd` so the restart button still works |
| `purpose` | 3323 | falls back to the project title |
| `alive` | 3324 | `lastSeen` within 120s (`aliveNow`, 967). `jarvis` is hardcoded true |
| `wedged` | 3328 | green-but-deaf: `{minutes, pending}` or null. §4.6 |
| `context` | 3329 | last `POST /health` value, or null — **never absent** |
| `doing` | 3330 | last `POST /health` phrase, `''` if never posted |
| `watching` | 3331 | channel label while `/watch` pings are fresh (TTL 5 min, 977) |
| `needsYou` | 3332 | set by a `Need you:` `/say` (4188) or a pending permission (4296) |
| `voiceMuted` | 3333 | per-session spoken-line mute |
| `pendingPerm`, `pendingPermCount` | 3334-3335 | the blocking permission request, if any |
| `projectContext` | 3338 | `compactProjectContext` — summary/currentFocus/openThreads/docs/recentLog tail |
| `parentProject` | 3341 | so the UI can nest a sub-worker's card under its project |
| `baton` | 3343 | merge-lane state, holder or queue position |
| `working`,`queued`,`done`,`review` | 3344 | the four lanes, full task objects |

`GET /roster` (3497) deliberately spells the same expressions the same way (rationale 3466-3471)
because the two endpoints disagreeing about one session has already produced a false defect report.
**If v2 splits these, keep one projection function.**

### 1.4 Failure modes, by pattern

Rather than repeat per route:

- **`400`** — missing/invalid required field. Notable: `/register` demands both `cwd` and `purpose`
  and says why (4082-4084); `/health` rejects a context outside 0-100 (4098); `/search` rejects a
  blank `q` **rather than returning `[]`** (3906) and rejects an unknown `kinds` value (3916), on the
  stated ground that a confident empty result is worse than an error.
- **`403`** — the origin/host guard (3315), and `/screen` when not voice-gated (4008).
- **`404`** — unknown uid (`/poll` 3986, `/heartbeat` 4032, `/health` 4054, `/baton` 3662), unknown
  recipient (`/send` 4114), unknown project (3397, 3426), no task matching a needle (`/worklist`
  4418, 4435, 4444), not on hold (3808), no pending permission (4304).
- **`409`** — `assignCallsign` exhausted, i.e. all 26 callsigns live (`/register` 4044 wrapping the
  throw at 1001); project rename onto an existing name (3456); `/baton op:cancel` while holding
  (3745); `/stt` when the backend is not local (4691); **`/forget` with work in flight** (4401).
- **`410`** — retired uid on `/poll` (4029), `/heartbeat` (4075), `/baton op:request` (3709). This is
  the signal that means *stop polling*, distinct from 404.
- **`402`** — ASK monthly spend cap reached (4772).
- **`500`** — unwritable `batons.json` (3692, 3719, 3734, 3748), unreadable archive entry (3556),
  spawn failure on unhold (3828), store read failure (3650), screenshot failure (4016).
- **`503`** — reporting store off (3598); no Anthropic key (4786-4790).
- **No response at all** — `POST /permission` (4299) parks the response and returns nothing until the
  human answers or a 300s timer fires `{decision:'timeout'}` (4293). `GET /poll` does the same for up
  to 25s. **Any v2 client library must tolerate a deliberately-hung request on these two routes.**

---

## 2. Endpoint detail where the shape is not obvious

### 2.1 `POST /register` → `registerSession` (4038 → 1277)

Body: `{cwd, purpose, pin?, project?, parentProject?}`. Both `cwd` and `purpose` are **required**
(4082).

Response: `{uid, callsign, build:{commit,short,dirty,bootedAt,pid}}` plus optionally
`handoff:{summary,from,ts,hint}` (1404) and `project:<context>` (1405).

What happens inside, in order (1277-1406):

1. `assignCallsign(pin)` (992-1006): honour the pin if it is a NATO name and not live; else prefer a
   never-used callsign, else the longest-retired one. Throws at 26 live.
2. **cwd is rewritten to the repo, not the worktree** (1286-1287). An isolated worker boots in
   `d:/claude/.jarvis-wt/jarvis-x`, which matches no configured repo — so the session records the
   *repo* as `cwd` and carries `worktree`/`branch`/`base` beside it. Four things key off `cwd`
   (tier, permissionMode, handoff key, auto-bind) and all four would break otherwise.
3. Trust tier resolves from the spawn stash, else the repo row, else `guarded` (1288-1290).
4. uid is minted as `s_` + a zero-padded incrementing counter (1291) — `roster.nextUid`.
5. **Binding.** `resolveBinding` (`jarvis-text.mjs:974`) merges what the worker sent with what the
   spawner stashed (`pendingBind`, 1016). `project` = coordinator, `parentProject` = sub-worker, and
   they are **mutually exclusive** (1295-1297).
6. **Auto-bind** (1299-1317): if neither was given, infer from repo identity via
   `projectOwningCwd`. Coordinator if the project has no live one, else sub-worker. Explicit flags
   always win. This is recorded as a `sys` line saying it was inferred (1371).
7. `launch` is stamped `'pty'` or `'wt'` by whether a pidfile exists (1324) — after a hub restart
   this is the difference between a corpse and a survivor.
8. Board column created for `project || callsign` (1340) — a coordinator gets **no separate card**.
9. Focus is taken only if idle (`focusHeldByLiveOther`, 1352) — never stolen from a live conversation.
10. A stale schedule triggers a `msg` event asking this worker to pull the calendar (1377-1394),
    stamped once per day before queueing so a delivery failure cannot double-ask.

### 2.2 `POST /worklist` (4433) — the board's only mutation path

Body: `{op, callsign?, text, to?}` plus optional task fields on `add`.

`callsign` resolves through `boardKey` (4439) so a bound coordinator posting as itself lands on its
**project** column — without this it minted a second tracker for one session.

| op | From lanes | To | Notes |
| --- | --- | --- | --- |
| `add` | — | `queued` | `makeTask` (584) mints id + `addedAt` |
| `start` | queued, done, review | `working` | stamps `startedAt` in the store |
| `done` | working, queued, review | `done` | stamps `doneAt` |
| `ready` | working, done, review | `queued` | the undo |
| `review` | working, queued, done | `review` | done-but-awaiting-eyeball |
| `top` | queued, working, review, done | *same lane, index 0* | reorder only |
| `drop` | all four | *gone* | lane `'dropped'` exists only in the SQLite store |
| `move` | working, queued, done | `<to>`.queued | crosses boards |
| `clear-done` | — | — | empties `done`; writes **nothing** to the store |

**Matching is by case-insensitive substring, first hit wins, across EVERY board**
(`findTaskAll`, 613-625, with the poster's board preferred). A short needle silently moves someone
else's card. A needle matching nothing is `404 no task matching <text>` (4460).

Two subtleties v2 must preserve or deliberately drop:

- **Credit the board holding the task, not the poster** (4499-4510). `record({kind:'task', board:
  owner})` — `db.mjs`'s `taskTimesFromTranscript` keys on `(board, text)`, so crediting the poster
  produced a key matching nothing and the timestamp was *lost*, not misplaced.
- **Lane is current truth; `startedAt`/`doneAt` are history, and they are allowed to disagree**
  (4511-4516). `db.mjs` COALESCEs, so a timestamp once written can never be cleared — `ready` on a
  finished task leaves `doneAt` standing beside `lane='queued'`. **"What is finished" means
  `lane='done'`, never `doneAt IS NOT NULL`.**

### 2.3 `POST /baton` (3664) — the serialized merge lane

One lane per repo key (`batonRepoKey`, 2213), so another repo never blocks yours. Pure lane
transitions live in `jarvis-text.mjs` (`batonRequest` 1482, `batonRelease` 1501, `batonCancel` 1520,
`batonForce` 1539, `batonReap` 1575); the hub supplies the I/O and the announcements.

- `request` → `{granted, position, holder, already, repo, base, waiting}`. `granted:false` means
  queued — **the caller must go back to its poll loop**, and a `baton` event wakes it when its turn
  comes (`notifyBatonGrant`, 2227-2237). The lane's `base` is re-resolved on every request (3714)
  because Chris moves the integration branch.
- `release` → hands to the next in queue and announces it.
- `cancel` while **holding** is `409` (3745) — doing nothing quietly would leave the lane shut by a
  worker that believes it let go.
- `force` is the console's override: no uid, because Chris is not a session (3671-3673). Always
  announced, spoken and recorded.
- **Reap-on-read**: both `GET` and `POST /baton` call `reapBatons()` first (3658, 3667) so a lane
  whose holder died is never *served* as busy. Stale threshold 300s (`BATON_STALE`, 2258).
- Retiring releases for you (`releaseBatonsFor`, 2302, called at 1449) — **before** the successor
  spawn, and the successor does **not** inherit: it re-requests.

### 2.4 `GET /search` (3886) — the one endpoint that reads history

Params: `q` (required, terms ANDed, case-insensitive substring), `kinds` (default
`speech,chat,tts,msg`; `all` for all seven), `from`, `missionId`, `limit` (default 50, max 200).

It reads the in-memory cache backwards, then the archive backwards (3936-3952) — every archived line
is older than every cached one by construction, so the two walks concatenated are already newest-first
and nothing sorts. `total` keeps counting past `limit` so a caller can say "50 of 347" (3930-3932).

The archive scan is bounded at 64 MiB and **says so** in the response (`archive.capped`,
`archive.oldestScannedTs`, 3917-3925) — a bounded read that does not report its bound is
indistinguishable from a complete one. A raw-substring prefilter avoids `JSON.parse` on ~99% of
lines, but terms containing `"` or `\` are excluded from the prefilter because they appear escaped in
the line (3939-3945).

### 2.5 `POST /send` (4147) — two completely different behaviours

- `to === 'human'`: `record({kind:'chat'})` and return `{ok:true}` — **no `cursor`**, because it never
  touches the bus (4175-4177).
- `to === <uid or callsign>`: `busAppend` a `msg` event **and** `record({kind:'msg'})`, returning a
  receipt `{ok:true, cursor, to, uid}` (4178). `cursor` is the absolute bus index the message landed
  at — re-readable via `GET /poll?uid=<uid>&cursor=<it>`.

**The `to` field means different things in the two records.** On the bus it is a **uid** (4159); in
the transcript it is a **callsign** (4170). Same field name, two key spaces. This is the single most
likely v2 schema landmine in the whole system.

### 2.6 `GET /handoff` (4614) — three lookup paths

1. `?cs=<callsign>` and a `cs:<callsign>` stash exists → return it and **delete it** (4621-4624).
   One-shot, written by `spawnWorker` at 2600.
2. `?cwd=<path>[&purpose=<p>]` → the durable per-job record keyed by
   `handoffKey(cwd, purpose)` = `cwdKey(cwd) + "\n" + normalized purpose`
   (`jarvis-text.mjs:266-269`). Without `purpose`, falls back to the most recent record on that cwd
   (4631-4637) — legacy support.
3. `?cs=` with no stash → most recent durable record authored by that callsign (4638-4642).

Miss returns `200 {none:true}`, **not** a 404 (4644).

### 2.7 `POST /permission` (4277) — the blocking one

Called by `perm-hook.mjs` inside a worker. Auto-allow paths, in order: a stored `autoAllow` signature
(4284), then — for non-`danger` classes only — an active `trustUntil` window or `tier === 'trusted'`
(4287-4290). Otherwise it registers a pending record, sets `needsYou`, records a `sys` line, speaks
`"Need you: …"`, and **returns nothing** (4299). A 300s timer answers `{decision:'timeout'}` (4293).

`POST /permission-answer` with `decision:'always'` stores the signature on the session so the same
call auto-allows thereafter (4308-4314). `permSig`/`permLabel` (`jarvis-text.mjs:639,648`) collapse a
command to a stable signature, with `PERM_MULTIWORD` (636) keeping `git commit` distinct from
`git status`.

### 2.8 `POST /forget` (4363) — guarded destruction

Deletes a whole board column. **The guard runs before the retire** (4367-4369) — a check bolted on
afterwards would kill the session and only then refuse. It counts `working + queued` only (4398);
`done`/`review` are deliberately excluded because they are recoverable from the transcript and a
guard that cries wolf gets forced past by reflex (4382-4385). With work in flight and no
`force:true`, `409` with a body naming the alternatives (4401-4409). A forced call names the cost in
its `sys` line (4426-4430).

### 2.9 `POST /retire` (4576) → `retireSession` (1411)

Body `{uid, summary, notes?, successor?}`. `notes` is stored as the session's handoff before
retiring (4579). Successor decision: `shouldSpawnSuccessor(requested, hasWork)`
(`jarvis-text.mjs:352`) — `true` always spawns, `false` never, omitted spawns iff `working+queued`
is non-empty.

`retireSession` order matters and is commented as such:

1. Stamp `ended`, write the SQLite row **first** (1425-1428) so the record does not hinge on teardown.
2. Delete the spawn script, kill the pty host (1429-1436).
3. `teardownWorktree` (1443 → 1912): commit in-flight WIP to the worker's branch, drop the directory,
   **keep the branch** — the branch is the deliverable. Verdict is `'committed' | 'stranded' |
   'none' | unknown`.
4. Release/dequeue any merge lane (1449).
5. Build the handoff record (1462-1469) — `summary`, `notes` (what the session WROTE, may be empty),
   `auto` (what the hub OBSERVED), full four-lane board snapshot, `from`/`fromUid`/`cwd`/`purpose`/`ts`.
6. Write the archive epitaph `archive/<uid>.json` (1472-1476).
7. **Sub-worker feedback** (1482-1505): append `sub-worker retired: <summary>` to the parent
   project's log AND push a `msg` to the live coordinator, so a manager learns its delegate finished
   without polling.
8. Branch on role: a `.project` coordinator keeps the durable column and may spawn a successor unless
   somebody already holds the slot (1507-1548); a plain/sub worker transfers its **entire** board to
   the successor via `transferBoard` (1570) and focus follows the work (1572).
9. Bus a `retired` event to the retiring uid (1546/1579/1590) — the worker's stop signal.

### 2.10 `POST /spawn` (4227) — one of three spawn sites

The other two are the retire auto-successor (1519, 1561) and the mission auto-revive
(`reviveMissionCoordinator`, 1690). All three now ask `coordinatorHeld` before minting a coordinator;
`/spawn` was the last door left open to two brains on one project (4235-4240). An explicit human ask
is **not refused** — the new session nests as a sub-worker instead (4246).

`from` is accepted as a uid *or* a callsign (4253-4255) so a spawn that dies before registering can
be reported back to whoever asked (`spawnDispatch`, `jarvis-text.mjs:1913`; death detection at
`sweepDeadSpawns`, 2543, timeout 90s at `SPAWN_REGISTER_TIMEOUT_MS`, 1777).

---

## 3. The event bus

### 3.1 What it is

A single append-only array `bus` (`jarvis-core.mjs:209`) mirrored to `bus.jsonl`. Every event is
`{from, to, kind, text, ts}` plus optional extras (`missionId` on mission speech, 1658).

**`to` is always a single uid.** There is no topic, no channel, no fan-out. `eventsFor` (1155-1163)
also accepts `to === 'all'` (1160), as do `pendingFor` (1174) and `gapNotice` (1106) — but **no code
path anywhere writes `to:'all'`**. It is a dead broadcast capability, read by three functions and
written by none.

### 3.2 Cursor semantics — the part that has cost real work

- A cursor is an **absolute event index**, monotonic across the whole bus, never per-session.
- `busBase` (`jarvis-core.mjs:208`) is the absolute index of `bus[0]`, persisted to `bus.base`, so
  cursors stay valid across restarts **and** across front-trimming. Logical total is always
  `busBase + bus.length`.
- `trimBus` (557-564) drops the front once the bus exceeds `CACHE_CAP + CACHE_SLACK` (5000 + 1000,
  lines 85-86), bumping `busBase` by the same count so `busBase + bus.length` is invariant. Trimmed
  events are **rewritten out of `bus.jsonl`** and are gone for good.
- `?cursor=i` starts **at** `i`. The cursor a poll **returns** is one **past** its last event
  (`eventsFor` returns `busBase + bus.length`, 1162). `POST /send`'s receipt `cursor` is the **index
  the event landed at** (`busAppend` returns `busBase + bus.length - 1`, 1145) — so a receipt cursor
  and a poll cursor are *not* the same kind of number. Passing a receipt cursor back as a poll cursor
  works only because `?cursor=i` is inclusive.
- **Advancing past an event makes it unreachable through `/poll` forever.** No error; both ends read
  healthy. Recovery is `GET /poll?uid=<uid>&cursor=<the missed index>`, and **the uid is not
  optional** — `/poll` reads it first and 404s without it (4028).
- The hub watches for this. `gapNotice` (1099-1122) compares the cursor you polled with the one it
  last handed you (`lastPollCursor`, stamped in `pollRespond`, 1086) via `cursorGap`
  (`jarvis-text.mjs:1141`). It is **silent unless something addressed to you was inside the jumped
  window** (1108) — an absolute-index gap alone is meaningless on a shared bus.
- **An idle timeout answers with the waiter's OWN cursor, never the bus head** (4050-4055). Speech is
  bused with a 4s debounce, so an event addressed to that very waiter can be sitting at the head
  un-released when the hold expires; handing back the head would tell the worker to skip the human's
  own words, and the gap detector could not see it because the baseline it compares against *is* that
  number. Same rule on shutdown (5037-5044).

### 3.3 The six bus event kinds

Verified by enumerating every `busAppend` call site. There are exactly six:

| Kind | Written at | Meaning / trigger |
| --- | --- | --- |
| `speech` | 1612 (`routeTo`), 1658 (`routeToMission`), 3093 (voice "work on item N") | the human talking to you — **your prompt**. Bused with a 4s debounce so consecutive sentences arrive as one batch |
| `msg` | 4117 (`POST /send`), 1385 (schedule nudge), 1502 (sub-worker retired → coordinator), 1529 (orphaned handoff pointer), 2535 (dead-spawn report) | another session or the hub, out of band |
| `screenshot` | 2867 (voice), 4316 (`POST /attach`) | `text` is a **filesystem path** to a PNG. Read it as an image |
| `baton` | 2229 (`notifyBatonGrant`) | the merge lane is yours |
| `retire-request` | 3015 (voice "retire X"), 4845 (`POST /winddown`) | wrap up and retire |
| `retired` | 1546, 1579, 1590 (`retireSession`) | you are done; stop polling |

### 3.4 `gap` is NOT a bus event

`gapNotice` returns a fully-formed event object — `{from:'jarvis', to:uid, kind:'gap', text, ts}`
(1121) — but it is **never bused**. `GET /poll` unshifts it onto the response array (4040-4042).
Consequences a v2 implementation must know:

- It has no bus index, so it cannot be re-read.
- It is synthesized per-poll from in-memory state (`lastPollCursor`), so it **does not survive a hub
  restart**.
- It is delivered as an event rather than a side field precisely because the documented wrapper loop
  only exits on a non-empty `events` array (4037-4039).

**`sys` is also not a bus kind.** It is a transcript kind only (§6.7). Measured on the live bus —
5029 retained events, `busBase` 2002 — the kind histogram is `speech 3639, msg 758, retired 346,
screenshot 247, retire-request 39`. Zero `sys`, zero `gap`, and zero `baton` (the newest kind, not
yet exercised on this bus).

### 3.5 Delivery mechanics

- `busAppend(ev, debounceMs)` (1135-1154) appends, persists, trims, then releases parked waiters.
  With a `debounceMs` it sets a single shared timer instead (1151) — this is the speech batching.
  A non-debounced append **cancels** any pending speech release (1147) and flushes immediately.
- `releaseWaiters` (1123-1132) walks the parked responses and answers any whose cursor now has
  events.
- `pendingFor(uid)` (1168-1177) counts events past the session's last-polled cursor. Zero for a
  session that has never polled — we cannot claim it is ignoring anything until it says where it is.
- `GET /transcript` and `GET /mission-chat` both **exclude `msg`** (3852, 3988). The reasons differ
  and both are load-bearing: the console routes a line by its `who`, so a worker-authored message
  would render in the *sender's* tab as if said to Chris (3848-3851); and a booting coordinator is
  told to treat the newest mission-chat as its live prompt, so admitting delegation briefs would feed
  a sub-worker's own instructions back to the coordinator as though the human had said them
  (3984-3987). Net effect: **worker-to-worker traffic is recorded and searchable but invisible in
  every chat view.**

---

## 4. Worker lifecycle

### 4.1 The happy path

```
POST /register  ->  {uid, callsign, build}
  |
  +-- GET /poll?uid=&cursor=N   (long-poll, 25s, relaunch with the EXACT N it printed)
  +-- GET /heartbeat?uid=       (fixed 30s background timer, never blocks)
  |
  work: POST /send, POST /say, POST /worklist, POST /health
  |
  +-- POST /baton op:request  ->  granted? merge. queued? go back to polling, a `baton` event wakes you
  |
POST /retire {uid, summary, notes}  ->  archive + handoff + maybe a successor
```

The two loops are **separate on purpose** (`jarvis-core.mjs:4065-4071`). Both `/poll` and
`/heartbeat` bump `lastSeen`, but only `/poll` bumps `lastPoll` (4034) and only `/heartbeat` bumps
`lastBeat` (4076). Keeping them apart *is* the wedge detector: the heartbeat proves a timer is alive,
`/poll` proves the worker's ears are. Without the heartbeat, one long agent turn leaves the poll loop
un-relaunched, `lastSeen` goes stale, and at 120s (`aliveNow`, 969) the hub marks the session gone.

### 4.2 Identity

- `uid` = `s_0001`-style, from `roster.nextUid` (1291). Permanent, never reused.
- `callsign` = one of 26 NATO words (`NATO`, 81). **Reused across sessions.** `roster.callsigns[cs]`
  is an array with **index 0 = the current holder** (1318), older uids behind it. `liveUidOf`
  (939-944) returns `[0]` only if that session is not ended. This is array-position-as-structure —
  see §8.
- `boardKey(cs)` (949 → `boardKeyFor`, `jarvis-text.mjs:1022`) maps a callsign to the board it writes
  to: the project column for a bound coordinator, else the callsign. **Never use it for a roster
  lookup** — roster lookups need the NATO name.

### 4.3 Roles

A session is exactly one of three, and `registerSession` enforces mutual exclusion (1295-1297):

| Role | Marker | Board | Behaviour |
| --- | --- | --- | --- |
| standalone | neither field | own NATO column | plain worker |
| **coordinator** | `.project` | the **project** column, no card of its own | rehydrates `GET /project` on boot, claims `managerUid` (1344), delegates |
| **sub-worker** | `.parentProject` | own NATO column, nested under the project in the UI | retire summary auto-appends to the project log (1483) |

Only one coordinator per project. `coordinatorSlotHolder` (`jarvis-text.mjs:740`) treats a *booting*
spawn as holding the slot for 120s, so the three spawn sites cannot race.

### 4.4 Handoff and the auto-successor

Two ways a handoff is created:

- **`POST /handoff`** (4589) while live — a checkpoint, safe to repeat, latest wins. Stores
  `summary`, `notes`, an `auto` block, and a `{working, queued}` board snapshot (4604-4610).
- **`POST /retire`** (4576) — stores the same plus **all four lanes** (1466) and the WIP verdict.

`roster.handoffs` is keyed by `handoffKey(cwd, purpose)` (§2.6). A coarser cwd-only key was wrong: one
directory hosts many unrelated jobs, so whoever retired last overwrote the single slot and the next
worker inherited a **different job's** notes (`jarvis-text.mjs:256-265`).

**The `auto` half.** `reconstructHandoff` (`jarvis-text.mjs:303-344`) assembles, from **observed
state only**, in this order:

1. A first line stating *who wrote this* — and whether the predecessor left notes at all (311-313).
   The reader is a model; a successor that mistakes reconstructed facts for judgement will trust them
   further than they deserve.
2. `predecessor: <cs> (<uid>), on the job 1h 17m (start -> end)` (315).
3. `its purpose:` (316).
4. The `doing` line from `POST /health`, with the context percentage — **or an explicit line saying
   none exists**, so the successor does not go hunting (321-323).
5. If isolated: the branch, that you continue ON it, and the WIP verdict — `committed` / `stranded` /
   `none` / **`UNKNOWN`, stated positively** (326-336). Silence here would read as "there was no
   in-flight work" when the truth is "the worktree was gone before anyone looked".
6. Board counts carried over (338).
7. `FIRST MOVE:` — `git log --oneline <base>..<branch>` on an inherited branch, else
   `git log --oneline -20 && git status` in the shared cwd (340-342). On an inherited branch **that
   diff IS the handoff nobody wrote**.

**A live-data caveat the code comment does not cover.** `jarvis-core.mjs:4600` says "every handoff
record carries an `auto` block" is an invariant a reader can rely on. Measured on the live store:
**7 of 106 records have one.** It is an invariant for records written from now on, not a property of
the store — a successor inheriting an older job gets `auto: undefined`. Likewise 6 of 106 keys are
legacy bare-cwd keys with no purpose component, reachable only through the fallback at 4589-4595.

**The auto-successor path.** When a session retires with work remaining (or `successor:true`), the
hub spawns a fresh session on the same job, hands it summary + notes + auto + the unfinished board,
and moves focus to it (1550-1581). The successor **continues the predecessor's branch**
(`inheritBranch`, 1561) rather than forking from base — forking would strand every commit the
predecessor made, including the WIP commit, on a branch nobody is working on.

Console "relaunch" is `POST /retire {successor:true}` with a fixed summary and **no notes**
(`jarvis-text.mjs:283-287`), which is exactly why the `auto` block exists.

### 4.5 Spawning a worker (`spawnWorker`, 2570-2742)

1. Pin the callsign (`pendingPins`, 2573) with a 300s TTL (994).
2. Strip shell/`wt` specials from the purpose (2621) — a `;` chopped the `wt` command in half.
3. Stash the intended binding (`pendingBind`, 2587) so nesting is deterministic even if the worker
   drops the field.
4. **Cut a worktree** if `shouldIsolate` says so (2591 → `jarvis-text.mjs:1306`). Best-effort: any
   git failure leaves `wt` null and the worker shares the repo cwd, with a `sys` line saying which
   (1875-1904).
5. **Compose the boot prompt** (2637-2710) — a single string, assembled from up to eight paragraphs:
   base, successor-handoff, project-coordinator, delegation, mission-link, sub-worker story,
   meeting, worktree, permissions.
6. **Cap it** (`capBootPrompt`, 2682 → `jarvis-text.mjs:1857`). `BOOT_PROMPT_MAX` is 24000 chars
   against `CMD_LINE_MAX` 32767 (`jarvis-text.mjs:1826,1723`), because the prompt is re-parsed as a
   `cmd.exe` command line and `CreateProcess` refuses anything longer — silently, as a worker that
   never registers with an empty log. A cut prompt gets a `sys` line naming both lengths and a spoken
   headline (2725-2731).
7. Launch: console-less via `pty-host.mjs` (2745) if `CONSOLELESS`, else a `wt new-tab` running a
   generated `.cmd` (2753-2763) with a `cmd /c start` fallback (2765).
8. `watchSpawn` (2511) arms death detection; `sweepDeadSpawns` (2585) reports it to whoever asked.

**No angle brackets in the boot prompt** (2666-2671): `cmd.exe` reads `<` and `>` as redirection, and
an angle-bracketed placeholder made cmd answer "The system cannot find the file specified" with the
worker never registering.

### 4.6 Liveness, wedging, and death

| Signal | Threshold | Where |
| --- | --- | --- |
| `alive` | `lastSeen` within 120s | `aliveNow`, 967-970 |
| `wedged` | heartbeat fresh but no `/poll` read within grace | `wedgedNow`, 1188-1199 → `wedgeState`, `jarvis-text.mjs:1091` |
| wedge grace | worker 300s (`WEDGE_GRACE_WORKER`); a coordinator **with traffic queued** gets `3.6 × pollHold` — the multiple, not a hardcoded 90s, so it survives someone tuning the hold | `jarvis-text.mjs:1035-1062` |
| wedge, no grace at all | `pendingPerms > 0` **AND** `pending > 0` — both required. A permission prompt with nothing queued behind it is ordinary operation | `jarvis-text.mjs:1108` |
| wedge escalation | 0, 60s, 180s, 420s, 900s | `WEDGE_ESCALATE_MS`, `jarvis-text.mjs:1064` |
| watching light | `/watch` ping within 5 min AND alive | `watchingNow`, 978-984 |
| spawn death | no register within 90s | `jarvis-text.mjs:1894` |
| baton stale | holder unseen 300s | 2258 |

`announceWedge` (1234-1260) answers four questions the human used to have to ask: **who** is deaf,
**why** (permission prompt vs dead poll loop), **what is queued** behind it, and **what the lever
is** — `POST /retire {successor:true}`, explicitly **never `/forget`**, which calls `retireSession`
with no opts and then deletes the board outright. A separate 15s sweep (`sweepWedged`, 1268-1276)
chases deaf **coordinators** even when the human has stopped talking to them.

### 4.7 Boot reconciliation (`reconcileWorkersOnBoot`, 2066-2122)

After a hub restart, run **after** `listen` so a slow git call never delays the port:

1. `liveWorkerHosts` (1987) reads `worker-<cs>.pid` files and checks each pid.
2. `reconcileRoster` (`jarvis-text.mjs:1332`) classifies: re-adopt survivors, bury ghosts.
   `launch:'wt'` sessions get a grace window — they outlive the hub on their own.
3. `buryGhosts` (2036) retires them `{quiet:true}` so the human hears one summary, not a casualty list.
4. `restoreBootingState` (2056) puts in-flight spawns back into `pendingPins`/`pendingBind`.
5. **`sweepWorktrees` is deferred** (2145-2198) until survivors have had a chance to check in —
   calling it directly used to delete live workers' directories.

**The sweep hazard, still live:** it collects every directory under `WT_ROOT` that no live session
claims (`orphanWorktrees`, `jarvis-text.mjs:1413`). A manager's ad-hoc worktree under
`d:/claude/.jarvis-wt` is claimable by nothing and gets eaten. Put scratch trees elsewhere.

---

## 5. Voice intents

### 5.1 Read this before you look for them

**Every spoken intent is dispatched by inline regex inside `handleUtterance`.** The pure helpers in
`jarvis-text.mjs` are only **predicates** — `isMissionCloseIntent`, `isBatonQuestion`,
`parseReminder`, `matchMissionByPhrase` — and the hub still owns the `if`, the state mutation, and the
`enqueueSay`. Shipping a helper without wiring it into `handleUtterance` ships nothing.

**Two corrections to the map every session has been using.** The project's own open-threads note says
"handleSpeech in jarvis-core.mjs (~2462-2790)". At `main` 43d5828:

- The function is named **`handleUtterance`**, not `handleSpeech` (`jarvis-core.mjs:2788`).
- Its range is **2746-3238**, not 2462-2790.

`handleUtterance(rawText, typed)` is reached from exactly two places: the Playwright bridge
`__jarvisHear` (4973), and `POST /hear` (4864-4868) which the console's type box uses. The `typed`
flag matters: a typed line bypasses mute (2791), pause (2834), and meeting-mode gating (2809).

Text is canonicalized once via `canon` (`jarvis-text.mjs:658`) and lowercased into `lower` (2790).
Most patterns go through `after(re)` (2914), which prepends an optional `jarvis[,.! ]+` prefix —
so nearly every command works with or without the wake word.

### 5.2 Modal gates, in evaluation order (2791-2839)

| Order | Pattern | Effect |
| --- | --- | --- |
| 1 | *muted* + `unmute` / `resume listening` / `start listening` | unmute; **everything else while muted is dropped** (2791-2797) |
| 2 | `^(jarvis )?mute( yourself\|listening\|the mic)?$` | global mute (2798) |
| 3 | *meeting mode* + `end meeting( mode)` / `jarvis … back` | leave meeting mode (2803) |
| 4 | *meeting mode* + no `^jarvis` prefix | **dropped** (2809) |
| 5 | `meeting mode` (without `end`) | enter meeting mode (2810) |
| 6 | `jarvis … shut ?down` / `end (the )?session` | `running = false` — stops the hub (2816) |
| 7 | `(pause\|stop) listening` | discard mode on (2822) |
| 8 | `(resume\|start) listening` | discard mode off (2828) |
| 9 | *discard* + not typed | **dropped** (2834) |

### 5.3 The intent table

Everything below is inside `handleUtterance`. `after(…)` = optional `jarvis` prefix.

| Line | Phrase pattern | What it does |
| --- | --- | --- |
| 2844 | *(armed gate)* `yes` / `no` | confirm or cancel a pending mission close; 60s window, anything else drops the gate |
| 2864 | `isMissionCloseIntent` ("mission accomplished") | arms the two-step close; names the mission or asks which |
| 2875 | `parseNewMissionTitle` ("new mission …") | creates a mission, pinned to the rail |
| 2891 | `do you know what nemesis means`, `it's been emotional`, `guns for show`, `all bets are off` / `five minutes turkish`, `guy ritchie` | Guy Ritchie easter egg |
| 2901 | `screen ?shot` / `look at (my\|the\|this) screen` | capture now, grant `/screen` for 120s, bus a `screenshot` to the focused session. `all\|both\|every monitors` for every display |
| 2919 | `remind me …` / `set a timer …` / `timer for …` | `parseReminder` → a calendar reminder that announces once |
| 2932 | `focus( on)? X` / `switch to X` / `talk to X` | set focus (via `boardKey`, so a coordinator lands on its project card) |
| 2949 | `who's running/up/alive/online` | read the live roster aloud |
| 2962 | `isBatonQuestion` ("who holds the merge lane") | speak lane state (`speakBaton`) |
| 2966 | `what's next` / `when's my next meeting` | now + next from today's schedule |
| 2979 | `context check/health/report` / `how's the context` | each session's last reported context % |
| 2988 | `what did the old/previous/last X do` | that callsign's most recent retired summary; arms "one before that" |
| 2997 | `(and) (the) one before that` | walk back through that callsign's history |
| 3005 | `who's X` | X's purpose, live or retired |
| 3017 | `call this one/this session/it X` | rename the focused session's callsign (NATO only, must be free) |
| 3038 | `describe X as …` | rewrite X's purpose |
| 3047 | `retire X( anyway)` | ask X to wrap up; refuses if it has working tasks unless `anyway`; retires it outright if not alive |
| 3064 | `start/spin up/launch (a\|a new\|new) [cheap\|haiku\|fast\|trusted\|guarded\|autonomous] session in/on/at/for <repo> [for <purpose>]` | spawn a worker; adjectives pick model + tier |
| 3080 | `stop trusting X` / `untrust X` / `distrust X` / `don't trust X` | clear `trustUntil` |
| 3087 | `trust X [for N min\|hour]` | temporary auto-approve (default 30 min) |
| 3098 | `stepping away` / `step away` / `going away` / `away mode on` / `I'm heading out` | away mode on — sessions auto-trusted except destructive |
| 3104 | `I'm back` / `away mode off` / `back at my desk` | away mode off |
| 3110 | `(let's) start (working on) [cs] (item\|number\|#) N` | move board item N to `working` **and bus a speech event telling the session to start it**. A `review` item is bumped to the top instead, agent not pinged |
| 3139 | `(complete\|finish\|done\|approve\|drop\|scratch\|top\|bump\|prioritise) [cs] (item) N` | lane move by ordinal |
| 3162 | `(give\|move\|send) (the) <text> task to X` | move a task across boards by substring |
| 3175 | `read (everyone's\|all) (the) list(s)/tasks` | summarize every board |
| 3183 | `(add\|new) task[,:] <text> [for <cs>]` | add to the focused board, or to `<cs>` |
| 3197 | `(start\|begin) task[,:] <text>` | substring-match → `working` |
| 3209 | `(done with\|finish task\|complete task\|finish\|complete)[,:] <text>` | substring-match → `done`, and speak the remaining count |
| 3222 | `(scratch\|drop) task[,:] <text>` | delete by substring |
| 3233 | `clear done` | empty the focused board's done lane |
| 3243 | `(read\|what is\|what's) (the\|on\|my) (list\|worklist\|tasks)` | read the focused board |
| 3254 | `on mission <id-or-title>, <text>` | route to a mission thread. **Must precede the generic `on X`** below |
| 3263 | `on <callsign>, <text>` | route to that session |
| 3268 | `^jarvis[,.! ] <text>` | route to the jarvis brain; if nothing is bound, record as plain speech |
| 3273 | *(fallthrough)* | route to whatever holds focus; if nothing does, `record({kind:'speech'})` and log `HEARD "…"` |

Ordinals accept digits or the words one–ten (`NUMWORDS`, 937) and tolerate filler words
(`IDX_FILLER`, 938). Board ordinals index `orderedTasks` (`jarvis-text.mjs:664`), which is
**review → working → queued → done** — so "item 3" depends on lane order, not on any stored index.

### 5.4 Output side: speech

`enqueueSay(text, from)` (1030-1036) pushes to `sayQueue`. The `pump` in `main` (4987-4999) shifts one
at a time, always `record({kind:'tts'})` **even when muted** (4991), and speaks via
`consolePage.evaluate(t => window.__speak(t))` only if not muted (or `force`) and the sender is not
voice-muted (`voiceMutedFrom`, 1062). So the transcript is a complete record of what the hub *would*
have said.

There is also a **file interface** the solo brain uses (5017-5030): the loop drains `say.txt` every
250ms and speaks each line, and drains `commands.txt` looking for `stop`. Both files are truncated on
boot (113-114). This is how a hub-driver Claude session speaks without going through HTTP.

---

## 6. Persistence

Everything lives in `JARVIS_DATA` — `%LOCALAPPDATA%\jarvis` by default, **outside the repo** so a
`git clean -x` cannot wipe live state (`jarvis-core.mjs:50-53`).

### 6.0 The stale duplicate that has fooled people

There is a **`repos.json` in the repo directory** at `d:/claude/jarvis-core/repos.json` — 293 bytes,
dated 2026-06-13. **The hub does not read it.** `REPOS` is `join(DATA, 'repos.json')`
(`jarvis-core.mjs:62`), i.e. `%LOCALAPPDATA%\jarvis\repos.json` (314 bytes, 2026-07-29). The repo-dir
copy is an untracked leftover from before `DATA` moved out of the tree — it is not in git, so it does
not appear in a worktree, which is exactly why it keeps surprising people who find it in the live
checkout and edit it. **v2 should delete it, not migrate it.**

### 6.1 Common write discipline

- `atomicWrite` (342-348): write a temp file, `renameSync` over the target. Used for every JSON store.
- `backupCorrupt` (349-357): on a parse failure, preserve the bad file, record a `sys` line naming it,
  and reset in memory — never silently zero the only copy. Applied by `loadRoster` (336),
  `loadWork` (599), `loadRepos` (629), `loadSchedule` (651), `loadMissions` (692), `loadProjects`
  (749), `loadThreads` (880), `loadSpend` (892).
- `saveRosterThrottled` (381) exists because `/poll` and `/heartbeat` write on every request.
- Two `.jsonl` files (`bus`, `transcript`) are **append-only** with periodic front-trims.

### 6.2 `worklist.json` — the board (v3)

```
{ version: 3,
  focus: "primeng",
  sessions: { "<boardKey>": { working: [Task], queued: [Task], done: [Task], review: [Task] } } }
```

- `version` is `WORK_VERSION` = 3 (`jarvis-text.mjs:122`). `migrateWork`
  (`jarvis-text.mjs:212-243`) upgrades in place and idempotently: v1 flat board → v2 sessions keyed
  by callsign → v3 task **objects** instead of bare strings. It backfills missing `id`/`addedAt` and
  adds a missing `review` lane. Existing ids are preserved so they are stable across reloads.
- **`focus` is a single global string.** One focus for the entire hub, not per-project, not per-user.
  It holds `'jarvis'`, a NATO callsign, or a **project name** (`POST /focus` accepts all three, 4173).
- A board key is a NATO callsign **or** a project name. Live: `jarvis, primeng, november, bravo,
  alpha, oscar` — 6 columns.
- **Task object** (`makeTask`, 584-594):
  `{ id: "t_<base36>", text, addedAt }` plus optional `notes`, `subtasks:[{text,done}]`, `startDate`,
  `dueDate`, `priority`. Only the first three are populated by anything today; the rest are
  placeholders. Measured on the live board: `{id,text,addedAt}` universally, with `notes` present on
  some cards.
- **Category tags live inside `text`**, not as a field: a leading `BUG:`/`SECURITY:`/`ROBUST:`/
  `FEATURE:`/`REVIEW:`/`WORK:`/`FS:`/`MAINT:`/`POLISH:`/`NOTE:` is parsed out for display
  (`db.mjs:tagOf`, 97-99; `^[A-Z]{2,10}:`). **v2 should make this a column.**
- **Headline/detail is also inside `text`**: the first ` -- ` splits a card into a rendered headline
  and a click-to-open detail (`splitHeadline`, `jarvis-text.mjs:156`; console 762).

### 6.3 `sessions.json` — the roster

```
{ callsigns: { "<nato>": ["<uid newest>", "<older>", ...] },
  sessions:  { "<uid>": SessionRow },
  nextUid:   462,
  handoffs:  { "<handoffKey>" | "cs:<callsign>": HandoffRecord },
  held:      [HeldProject],
  awayUntil: 0 }
```

Live scale: 461 sessions, 26 callsigns, 106 handoff records, 1 held project. **1.29 MB and growing
monotonically** — nothing prunes `sessions`. This is the file most in need of becoming tables.

`SessionRow` fields, with live frequency out of 461 rows — the sparseness is the point, because it
tells you which columns are nullable:

| Field | Freq | Meaning |
| --- | --- | --- |
| `callsign`, `cwd`, `purpose`, `started`, `ended`, `lastSeen` | 461 | always present; `ended` is `null` while live |
| `summary` | 456 | the epitaph from `/retire` |
| `ctx`, `ctxTs`, `ctxWarned` | 435 | `POST /health` context %, when, and whether the 80% warning fired |
| `doing` | 425 | `POST /health` phrase, truncated to 80 chars (4101) |
| `tier` | 402 | `trusted` \| `guarded` |
| `needsYou` | 290 | set by `Need you:` or a pending permission |
| `autoAllow` | 224 | array of permission signatures answered with "always" |
| `handoff` | 217 | the notes string a session wrote |
| `project` | 203 | coordinator binding |
| `lastPoll`, `pollCursor`, `lastBeat` | 119 | **only 119** — the split-signal fields are recent |
| `launch` | 98 | `pty` \| `wt` |
| `parentProject` | 69 | sub-worker binding |
| `worktree`, `branch`, `base` | 41 | isolation |
| `trustUntil` | 38 | temporary trust expiry (epoch ms) |
| `voiceMuted` | 2 | per-session spoken mute |
| `watching` | 1 | `{channel, ts}` |

A live row, verbatim:

```json
{"callsign":"bravo","cwd":"d:/claude/jarvis-core","purpose":"JARVIS punchlist",
 "started":"2026-07-30T22:11:29.471Z","ended":null,"lastSeen":"2026-07-30T22:30:42.534Z",
 "tier":"guarded","launch":"pty","parentProject":"jarvis",
 "worktree":"d:/claude/.jarvis-wt/jarvis-bravo-2","branch":"jarvis/bravo-2","base":"main",
 "lastPoll":"2026-07-30T22:30:40.908Z","pollCursor":7022,"lastBeat":"2026-07-30T22:30:42.534Z",
 "ctx":32,"ctxTs":"2026-07-30T22:20:33.457Z","doing":"working: foxtrot worktree-sweep fix, gate + probes",
 "ctxWarned":false}
```

`HandoffRecord`: `{summary, notes, auto, board:{working,queued,review,done}, from, fromUid, cwd,
purpose, ts}` (1462-1469). `HeldProject`: `{key, callsign, cwd, purpose, summary, parkedAt}` (3793).

### 6.4 `projects.json` — durable project context

```
{ version: 1,
  projects: [ { name, title, status, missionId, managerUid,
                context: { summary, currentFocus, openThreads:[string],
                           recentLog:[{ts,from,note}], docs:[{label,url}] },
                workers: [], createdAt, updatedAt } ] }
```

`makeProject` 715-729, `normalizeProject` (`jarvis-text.mjs:454`), `updateProjectContext` 805-824.

Live: 5 projects (`jarvis, primeng, waterfall, macropoint, mycarrierpackets`), **151 KB total**.
The `jarvis` row alone: 21 `openThreads` with the longest at **1619 chars**, `recentLog` at its cap
of 50, `summary` 467 chars, `currentFocus` 228 chars.

Two facts v2 must not lose:

- **`recentLog` is capped at 50** (`PROJECT_LOG_CAP`, `jarvis-text.mjs:449`, applied by `pushCapped`
  486). Entries beyond that are **discarded, not archived**.
- **`openThreads` is uncapped at write** (813). The only cap is at *read* time when the array is
  embedded into a sub-worker's boot prompt: `BRIEF_THREADS_MAX` 16 and `BRIEF_THREADS_CHARS` 10000
  (`jarvis-text.mjs:507-508`, applied by `subworkerBrief` 545). So the store grows freely and the
  briefing silently truncates. This is exactly the mechanism that bricked sub-worker dispatch on
  2026-07-30 — 46 threads made the boot prompt 31822 chars against the 32767 `CreateProcess` limit,
  and spawns died before registering with an empty log.
- **`workers` is always `[]`.** It is written by `makeProject` and never populated by anything.
- `managerUid` is a compare-and-set slot: `setProjectManager(name, uid, expectUid)` (791-801) so a
  ghost being retired cannot null a live coordinator's claim.

### 6.5 `missions.json`

```
{ version: 1,
  missions: [ { id: "m_<base36>", title, phases: [{text, done}], docs: [{label,url}],
                status: "active"|"archived", createdAt, archivedAt } ] }
```

`makeMission` 668-674, `normalizeMission` (`jarvis-text.mjs:575`). Live: 3 missions, 2 active,
1 archived. **`seedMissions` (676-686) writes a hardcoded first mission** when the file is absent —
"PrimeNG 17 → 18 upgrade" with five phases. Same for `seedProjects` (732-743). v2 will want that seed
to be data, not code.

`progress` on `GET /board` is **derived, not stored** (`activeMissionsView` 703-707 →
`missionProgress`, `jarvis-text.mjs:596`).

A mission is **closed only via the two-step voice gate**; there is no console close button
(comment at 4489-4492). `POST /mission op:archive` exists for programmatic recovery, and archive is
a status flip, never a delete (4565-4567).

### 6.6 `schedule.json`

```
{ date: "Thu Jul 30 2026",
  events: [{title, start, end, link?, join?, joinKind?}],
  announced: { "<title>:5" | "<title>:0" | "<title>:end": true },
  reminders: [{id, title, start, kind:"reminder", firedAt?}] }
```

- **`date` is a `Date.toDateString()` string, and it gates everything.** `GET /schedule` blanks
  `events` when `date !== today` and reports `stale:true` (4805-4816) so the console can flag a missed
  morning pull rather than hiding the panel.
- **`announced` is keyed by title + suffix** — a title change re-announces, and two same-titled
  meetings share one key. The 15s ticker (276-322) fires T-5min, T-0 (auto-**mute**, 306), and end.
- **Chris is never auto-unmuted** (311-317): the meeting-over line is pushed with `force:true` so it
  speaks through the mute, then the hub drops its claim. Encode that rule in v2.
- Reminders survive a schedule re-paste (4836-4839) and self-clean 6h past due (`pruneReminders`, 855).

### 6.7 `transcript.jsonl` — the append-only conversation record

`record(entry)` (565-570) stamps `ts`, pushes to the in-memory `transcriptCache` (205), and appends.
`trimTranscript` (405) **archives** the front to `transcript-archive.jsonl` rather than deleting it
(75, 72-74) — the earlier delete-on-trim is why a search sold as covering months could only see the
last week.

Seven kinds. Live counts (5960 lines in the cache, 2002 in the archive):

| Kind | Live | Shape | Written by |
| --- | --- | --- | --- |
| `sys` | 1637 | `{kind,text,ts}` | ~90 sites — every register, retire, board move, spawn, worktree op |
| `tts` | 1521 | `{kind,text,from,ts}` | the say pump (4991), **even when muted** |
| `task` | 1134 | `{kind,op,board,task,from?,count?,ts}` | `/worklist` (4510) + every voice board op |
| `speech` | 728 | `{kind,text,to?,missionId?,img?,command?,ts}` | the human. `to` is a **callsign** or `m:<missionId>` |
| `chat` | 707 | `{kind,from,text,ts}` | `/send to:human`, and hub-authored chat (1252, 300) |
| `msg` | 232 | `{kind,from,to,text,ts}` | `/send` worker→worker. **`from`/`to` are callsigns** |
| `react` | 1 | `{kind,target,reaction,from:'you',text,ts}` | `/react`; `target` is the **`ts`** of the reacted message |

`GET /transcript` projects these into a uniform `{ts, kind, who, to, missionId, img, text}` (3853-3862)
where `kind` collapses to `sys` \| `react` \| `msg` and `who` becomes `'you'` for speech, `'sys'` for
sys, else `from`. `GET /search` adds `srcKind` to preserve the distinction (3876-3879).

**A message's identity is its `ts`.** `POST /react` targets by timestamp (4198), and the console keys
pins by `who|ts` (`msgKey`, console 363). There are no message ids. v2 needs them.

### 6.8 `bus.jsonl` + `bus.base`

Events as in §3. `bus.base` is a single integer — the count dropped off the front. Live: 5029
retained, `busBase` 2002, so 7031 events total. **1.83 MB.**

One shape warning: a live `msg` event has **no `from` field** —
`{"to":"s_0114","kind":"msg","text":"Chris's answer is B…"}`. `POST /send` always sets it (4159), so
this predates the current writer. Anything consuming the bus must treat `from` as optional.

### 6.9 `batons.json`

```
{ "<repoKey>": { base, holder: {uid,cs,branch,note,takenAt} | null,
                 queue: [entry], lastHandoff } }
```

`normalizeLane` (`jarvis-text.mjs:1572`). Live, verbatim:

```json
{"jarvis":{"base":"main","holder":null,"queue":[],"lastHandoff":"2026-07-30T22:18:46.468Z"},
 "broker":{"base":"NewBeta2","holder":null,"queue":[],"lastHandoff":"2026-07-30T22:16:26.721Z"}}
```

### 6.10 `repos.json`

`{ "<key>": { cwd, defaultPurpose, tier?, model?, permissionMode?, isolate? } }` — `repoRow`
(`jarvis-text.mjs:822`) merges an amendment onto an existing row so `tier` can be set without
re-sending `cwd`. Live: `broker → d:/code/tms (trusted)`, `scratch`, `jarvis`.

`matchRepo` (`jarvis-text.mjs:799`) matches on **`cwdKey`**, and that is load-bearing rather than
cosmetic: `repos.json` is written by hand with forward slashes while a session's `cwd` is the Windows
path it booted in. A case-only comparison missed every backslash caller, so a spawn in a *configured*
repo fell through to `adhoc` and silently lost `permissionMode` and `tier` (comment 638-644).

### 6.11 `ai-threads.json`, `ai-spend.json`, `notify.json`

- `{ threads: { "th_<id>": {title, model, messages:[{role,content,ts,model?}]} } }` — the ASK tab.
  **Deliberately outside `/search`'s reach** (3881-3883): a separate chat surface.
- `{ month: "2026-06", usd: 0.00327 }` — `rollSpend` (`jarvis-text.mjs:429`) zeroes on a month change
  at read time, so a stale file reads as $0 with no separate reset step. Cap check at 4729.
- `{ url: "<ntfy topic>" }` — phone push (`pushPhone`, 1050).

Hardcoded model ids live in `jarvis-text.mjs:400-405` (`AI_MODELS`, `AI_DEFAULT_MODEL =
'claude-sonnet-4-6'`) and `jarvis-core.mjs:913` tests `model === 'claude-opus-4-8'` to enable
adaptive thinking. v2 should externalize these.

### 6.12 `archive/<uid>.json` — one epitaph per retired session

`{uid, callsign, cwd, purpose, started, ended, summary, handoff, board}` (1472-1476). **456 files
live.** `GET /archive` lists them, hiding any whose cwd is currently On Hold (3558-3571).

### 6.13 `jarvis.db` — the SQLite reporting store (`db.mjs`)

Two tables (`db.mjs:40-66`):

```sql
sessions( uid PK, callsign, cwd, purpose, project, parentProject,
          registeredAt, retiredAt, summary )
tasks   ( id PK, callsign, text, tag, lane, addedAt, startedAt, doneAt )
+ idx on sessions(project), sessions(parentProject), tasks(callsign), tasks(lane)
```

Three rules keep it non-load-bearing (`jarvis-core.mjs:161-168`): the import is **dynamic and
guarded** (a static `node:sqlite` import would stop the hub booting on a runtime without it); every
write is best-effort inside `store()` (187-195), which turns the store **off for the process after
three consecutive failures**; and nothing in the hub's decision logic reads it. `GET /report` (3574)
is the one read, and it is a pure serializer that answers **503 when the store is off** rather than an
empty 200 (3597-3599) — "history is switched off" and "nothing was ever worked on" must not look alike.

Two modelling notes v2 inherits:

- **`tasks` links to a session only by `callsign`**, and callsigns are reused, so a task row can
  straddle successive sessions (`db.mjs:36-39`). This is the join v2 should fix with a real FK.
- **`lane='dropped'` exists only in the store** (4469-4471) — a dropped task is gone from
  `worklist.json`, so a backfill can never produce one. It is the only place abandoned work is visible.

---

## 7. Console surfaces

`console.html` (33 lines) is the entire region skeleton; `console.js` fills it. No framework, no
build, no components — all rendering is string concatenation into `innerHTML`.

### 7.1 Polling model

Five independent recursive-`setTimeout` loops, started at `console.js:2133-2137`:

| Loop | Cadence | Endpoint | Renders |
| --- | --- | --- | --- |
| `pollChat` (555) | 1500 ms | `GET /transcript?limit=60` (or 0 when expanded) | chat feed, tabs |
| `pollWork` (1816) | 1500 ms | `GET /schedule` **then** `GET /board` | schedule + next panels, every card, missions |
| `pollHeat` (53) | 30 s | `GET /tokens` | the burn/heat readout in the status bar |
| `pollArchive` (1861) | 8 s | `GET /archive` | Archive panel |
| `pollHold` (1905) | 8 s | `GET /hold` | On Hold panel |

Two anti-jank rules worth keeping: a payload-signature compare skips re-render when nothing changed
(`lastChatPayload`, 622), and `selectionInside(el)` (289) suppresses a re-render while the human has
text selected in that panel (1819, 1863, 1907).

### 7.2 Region → data map

| Region (`console.html:line`) | Fed by | Content |
| --- | --- | --- |
| `#status` (3) | `/board` + `/tokens` | mute/pause state, heat, PAUSE / MUTE / STT buttons, the JARVIS menu (Restart → `POST /restart`, Wind down → `POST /winddown`) |
| `#interim` (4) | browser STT, local | live interim transcript + muted cue + CANCEL |
| `#stabs` (8) | `/board` + `/transcript` | tab strip: `ALL GENERAL JARVIS ASK`, then one tab **per active mission** (aggregating its workers), then one per live session, then up to 4 greyed retired tabs, then `+`. `renderTabs` 1986 |
| `#newsessbox` (9) | `GET /repos`, `/schedule` | the `+` composer: Repo or Meeting mode → `POST /spawn` (`spawnNewSession` 2107) |
| `#chat` (10) | `GET /transcript` / `GET /search` | message bubbles, markdown-rendered (`richText` 230), pin strip (localStorage), reactions → `POST /react` |
| `#rawlog` (11) | same | RAW mode: unformatted feed |
| `#aibar`/`#aichat` (12-13) | `/ai/*` | ASK tab: thread select, model select, spend chip |
| `#chatinput` (14) | — | type box → `POST /hear`; `#sendto` picks the target independently of the open tab |
| `#bar` (15) | — | EXPAND, RAW, **LOCK** (`renderLock` 638 — pins the view so the console stops auto-following the last poster), jump-to-latest, and the search box → `GET /search` |
| `#mission` (19) | `/board.missions` | mission rail: title, phase checklist, derived progress, doc links. `renderMissions` 1004 |
| `#nextpanel` (20) | `/schedule` | NOW / NEXT banner with a countdown and a progress bar |
| `#addtask` (21) | `/board` | quick-add → `POST /worklist op:add`, or `POST /remind` if it parses as a reminder. Column select populated from the board (`populateAddTaskCols` 1483) |
| `#work` (22) | **`GET /board`** | the card column. `renderBoards` 1142 — the biggest renderer |
| `#holdpanel` (23) | `GET /hold` | parked projects → `POST /unhold` |
| `#archpanel` (24) | `GET /archive` | retired sessions, continue button → `POST /spawn` |
| `#calcard` / `#schedpanel` (25-26) | `GET /schedule` | today's agenda; per-event join/invite/add-as-task icons |
| `#notifybar` (28) | `/notify` | ntfy URL + TEST |
| `#calbox` (29) | — | paste-agenda textarea → `POST /schedule {text}` |

### 7.3 What one card contains (`renderBoards`, 1142-1483)

A PrimeNG rebuild needs all of this from `/board` alone:

- **Header**: focus star, callsign (uppercased), activity dot (`activityIndicator` 826), the
  `worker:<callsign>` chip for a project card (`coordTip` 925), context percentage, watching light
  (`watchIndicator` 850), wedge warning (`wedgeIndicator` 866), merge-lane chip (`batonRole` 952,
  `batonLabel` 962, `batonTip` 979), the cwd chip, and the action buttons.
- **Buttons** → endpoints: focus ★ → `POST /focus`; continue 🚀 → `POST /spawn`; hold 💤 →
  `POST /hold`; close ✕ → `POST /forget`.
- **Lane-queue strip**: who is waiting behind this holder, in service order (`batonQueue` 969).
- **Counts row**: `N working / N queued / N in review / N done`.
- **Four lanes rendered in order `review, working, queued, done`** with a running ordinal offset
  (`_laneOff`, 1188) — **that ordinal is what the voice commands in §5.3 address.** Per-item actions
  map to `POST /worklist` ops: `top ▲`, `done ✓`, `start ↻`, `review ◎`.
- **Headline/detail**: the first ` -- ` in a task's text splits it; the headline renders, the detail
  opens on click (`headlineHtml` 804).
- **Pending permission**: the request and its allow/deny/always controls →
  `POST /permission-answer` / `POST /permission-answer-all`.
- **`projectContext`**: summary, currentFocus, openThreads, docs, recentLog tail.

### 7.4 Console-only conventions v2 must decide about

- **Markdown is the house style** and the console renders it (`inlineMd` 170, `richText` 230,
  `linkify` 149) — with a `fixEscapedBreaks` pass (212) that exists because a literal backslash in a
  `/send` body destroys every line break on the wire.
- **Copy buttons** produce both plain and HTML flavours (`doCopy` 65, `doCopyHtml` 88).
- **Pins** live in `localStorage` (`PIN_LS_KEY`, 359-362), not on the server — they do not survive a
  different browser and are invisible to any other client.
- Confirms and toasts are custom (`uiConfirm` 303, `uiToast` 337), because a native `confirm()` would
  block the poll loops.
- The local-STT path encodes 16 kHz mono PCM16 WAV in the browser and POSTs base64 to `/stt`
  (`encodeWav16k`, tail of `console.js`).

---

## 8. Where structure is encoded as array position

This is the section step 2 needs most: these are the places v1 stores meaning in an index, and every
one of them has to become a column, an id, or an explicit order field.

| Where | Position means | Read by |
| --- | --- | --- |
| `roster.callsigns[cs][0]` | **the current holder** of that callsign; the rest is history, newest-first | `liveUidOf` 939-944, written at 1318 and re-spliced on voice rename (3025-3027) |
| `worklist.sessions[cs][lane][i]` | priority within the lane. `op:top` means `unshift` | 4438, voice 3082/3114 |
| `orderedTasks(board)` | the **spoken ordinal**: review → working → queued → done, concatenated | `jarvis-text.mjs:664`; voice 3074, 3104; console offsets 1188 |
| `mission.phases[i]` | the phase's identity — `POST /mission op:phase/unphase` addresses it by **`index`** | 4508-4515 |
| `mission.docs[i]` / `project.context.docs[i]` | the doc's identity — `op:undoc` takes an `index` | 4521 |
| `context.recentLog` | append-only, newest at the end, capped at 50 by dropping the **front** | `pushCapped`, `jarvis-text.mjs:486` |
| `context.openThreads[i]` | nothing formally — but `subworkerBrief` takes the **first 16** | `jarvis-text.mjs:507-545` |
| bus index | the cursor. `busBase + offset`, and the offset is the array position | §3.2 |
| `transcript` order | chronology, relied on by `db.mjs`'s reconstruction | `sessionsFromTranscript` 252, `taskTimesFromTranscript` 299 |

Two more that are not array position but are the same class of problem:

- **Task category and headline both live inside `text`** (§6.2) — one string carrying three fields.
- **A message's identity is its `ts`** (§6.7) — no ids anywhere in the transcript.

---

## 9. Deltas: things the code does that nothing had written down, and things the docs claim it no longer does

Kept as a list because it is the part with the shortest shelf life.

**Undocumented behaviour**

1. **71 route keys, not 21.** Full table at §1.2. The 50 unlisted ones include the whole `/ai/*` tab,
   `/permission*`, `/hold`/`/unhold`, `/report`, `/search`, `/mission-chat`, `/attach`, `/react`,
   `/watch`, `/away`, `/trust`, `/notify*`, `/open`, `/reveal`, `/hear`, `/winddown`, `/restart`.
2. **There is no 404 for an unknown path.** Anything unmatched returns `console.html` with status 200
   (4913). A typo'd endpoint looks like a successful fetch of an HTML page.
3. **`sys` is not a bus event kind** — transcript only. The bus has exactly six kinds (§3.3).
4. **`gap` is never bused** (§3.4): synthesized per-poll, no index, does not survive a restart.
5. **`to:'all'` is read by three functions and written by none** — a dead broadcast capability
   (1106, 1160, 1174).
6. **`from` is optional on a bus event.** A live `msg` has none (§6.8).
7. **`to` is a uid on the bus and a callsign in the transcript** (§2.5). Same name, two key spaces.
8. **`POST /permission` and `GET /poll` deliberately never respond** until an external event or a
   timer. Any generated client will need per-route timeout policy.
9. **`/protocol` never mentions `/spawn`.** The delegation contract reaches a coordinator only
   through its boot prompt (2654-2672), so a worker reading `WORKER.md` learns nothing about
   dispatching sub-workers — which is why the capability existed and went unused for months.
10. **`openThreads` is uncapped at write and truncated at read** (§6.4) — the mechanism that bricked
    dispatch on 2026-07-30.
11. **`project.workers` is always `[]`** — written once by `makeProject`, never populated.
12. **Two different definitions of "dirty".** `BUILD` uses `git diff --name-only HEAD` +
    `git ls-files --others` and explicitly **not** `git status --porcelain` (38-47), because porcelain
    reported a phantom modification off cached stat data. But `POST /winddown`'s dry run uses
    `git status --porcelain` (4880). The same word answers differently in the same process.
13. **`GET /report` is a read of a store the code calls write-only.** The rule at 167-168 is qualified
    at 3540-3544: rows go straight out and no hub decision is taken on them. Worth stating because the
    invariant as written no longer holds literally.
14. **Seed data is hardcoded in the hub** — `seedMissions` 676 and `seedProjects` 732 write specific
    missions and projects when the files are absent.
15. **`/forget` guards on `working + queued` only** (4398). `review` and `done` are destroyed without
    a prompt.
16. **`say.txt` / `commands.txt`** are a live file-based control interface drained every 250 ms
    (5017-5030), truncated on boot (113-114). Not part of the HTTP surface at all.
17. **`GET /board` never calls git** (3324) but `POST /winddown` shells out to `git status` per live
    session with an 8s timeout each (4880) — a slow synchronous stall on the shared event loop.
18. **The register response's `cwd` is not the directory the worker booted in** for an isolated
    session (§2.1 step 2) — it is the repo. The worktree path is a separate field.

**Claims that no longer hold**

19. **`handleSpeech` does not exist.** The function is `handleUtterance` at `jarvis-core.mjs:2788`,
    spanning **2746-3238**, not "~2462-2790". Both the name and the range in the project's open
    threads are wrong, and that note is the map every session uses to find voice intents.
20. **"Every handoff record carries an `auto` block" is not true of the store.** The comment at 4558
    presents it as a reliable invariant; **7 of 106 live records have one** (§4.4). It holds for
    records written from now on only.
21. **6 of 106 handoff keys are legacy bare-cwd keys** with no purpose component (§4.4), reachable
    only via the fallback at 4589-4595. The `handoffKey` doc comment
    (`jarvis-text.mjs:256-269`) reads as though every record uses the two-part key.
22. **The repo-directory `repos.json` is dead** (§6.0) — untracked, 6 weeks stale, and not read by
    anything.

**Two of the project's own open threads are now stale**

These are recorded here because the threads are the map every session navigates by, and a stale map
costs more than no map.

23. **`diagnoseSpawnLog` HAS been fixed.** The open thread says it matches only `/trust the files/i`
    — the pre-2026-07 folder-trust wording that appears zero times in a real log — and so returns
    null for the exact death it exists to name. The predicate is now
    `/trust the files|is this a project you created|trust this folder/i`
    (`jarvis-text.mjs:1978`), and the comment above it (1969-1975) explicitly documents keeping the
    old wording so an older Claude Code still reads correctly. **The thread should be moved to
    history.** The general lesson it carries — a fixture and the code sharing an assumption about the
    outside world only prove they agree — is still worth keeping; the specific defect is closed.
24. **The line-ending map is wrong, and the whole repo is CRLF.** The thread says "each FILE here is
    internally pure and the REPO is mixed across files: jarvis-core.mjs, jarvis-text.mjs, console.js,
    console.css and package.json are CRLF; db.mjs and docs/\*.md are LF." Measured by
    counting `0x0a` bytes and checking the preceding byte, which is the only method the thread itself
    trusts: **every file is pure CRLF** -- re-measured at 43d5828 after a merge changed two of them, and still uniform. All 14 pre-existing `docs/*.md`, `db.mjs`, `WORKER.md`,
    `README.md`, `CLAUDE.md`, and all five files the thread lists — CRLF throughout, LF count exactly
    equal to CRLF count in each. There is **no `.gitattributes`**, so nothing normalizes on checkout;
    the uniformity is real, not a working-tree artifact. **This file is CRLF to match.** The thread's
    method is right and its conclusion is out of date — re-measure rather than inherit it.

---

## 10. Reading list

In the repo, worth reading before touching the matching area:

- `WORKER.md` — the worker contract, served verbatim by `GET /protocol`.
- `docs/PROJECT-THREADS.md` — 46 verbatim incident threads, each written by the session that got
  burned. The single highest-value document here.
- `docs/ARCHITECTURE.md`, `docs/DESIGN.md` — v1's own overviews.
- `docs/COMMIT-BATON-DESIGN.md`, `docs/WORKTREE-ISOLATION-DESIGN.md`,
  `docs/PROJECT-MANAGER-DESIGN.md`, `docs/AUTO-BIND-ON-REGISTER.md`,
  `docs/MEETING-WORKER-DESIGN.md`, `docs/TYPE-TO-MISSION-DESIGN.md`,
  `docs/CONVERSATIONAL-TAB.md`, `docs/CHAT-NEXT-DESIGN.md` — one per subsystem.
- `docs/CONSOLE-REBUILD-PLAN.md` — the closest existing thing to a v2 UI plan.
- `test/` — 53 test files. `node --test` **silently skips every integration test** without
  `JARVIS_INTEGRATION=1`; the gate is `npm run test:integration` and you must read the pass count,
  not the fail count.

### 10.1 Two ways a gate harness lies, measured while writing this doc

The known trap is that the summary lines are `ℹ tests 607` with a multibyte information glyph, so a
`^#` regex reads every count as null. `^\W*tests (\d+)\s*$` with the `m` flag is the working form.
Two additions from building one here:

1. **Write the parser from regex LITERALS, not `new RegExp('...')`.** Backslashes do not always
   survive the trip through a shell heredoc into a script file: `new RegExp('^\\W*tests (\\d+)')`
   silently became `^W*tests (d+)`, which matches nothing, and **every count parsed as null** while
   the harness printed a confident verdict. A literal `/^\W*tests (\d+)\s*$/m` cannot be corrupted
   this way.
2. **Make the parser prove it parsed.** Assert `pass + fail === tests` before printing anything. That
   one line is what caught the failure above — nulls otherwise read as zeros, and "fail: 0" from a
   parser that read nothing looks exactly like a green run. This is the same class of error as the
   `JARVIS_INTEGRATION` skip: an instrument reporting silence as success.
