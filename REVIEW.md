# JARVIS core — architecture, security & robustness review

_By delta (s_0033), overnight 2026-06-16. Written for Chris's morning read._
_Scope: `jarvis-core.mjs` (~2050 lines) + `perm-hook.mjs`, `usage.mjs`, `screen.mjs`, `tokens.mjs`, `start-jarvis.cmd`, `perm-settings.json`. Lenses you asked for: data-loss, security/secrets-over-the-wire, voice-path security, file-system organization, robustness, and the lift to hand this to someone else._

---

## 0. Where we are (the honest summary)

A genuinely impressive single-machine voice hub: a no-AI node server that brokers a human (by voice) and N Claude Code sessions over HTTP, with a live browser console, boards, scheduling, screenshots, permission gating, token telemetry, and — as of tonight — seamless session handoff. It **works**, it's used daily, and the design is coherent. The risks below are the normal debts of something built fast and used in earnest; none are on fire, but two **data-loss** issues and two **security** issues deserve attention before this grows further or is handed to anyone else.

**Top priorities (do these first):**
1. **Atomic state writes** — full-file `writeFileSync` can corrupt `sessions.json`/`worklist.json` on a crash mid-write. (data-loss, HIGH)
2. **Stop silently zeroing state on a bad parse** — a corrupt `worklist.json` currently resets to empty with no backup or alert. (data-loss, HIGH)
3. **Origin/Host check on the hub** — a web page you visit can POST to `127.0.0.1:8124` (CSRF), and `/open` will launch arbitrary URLs in your *work* Chrome profile. (security, MED)
4. **The permission hook auto-allows ALL file writes** — spawned workers can Edit/Write any file with no approval. (security, MED)

---

## 1. Security ("the security guy")

**Good, keep it:**
- **Bound to `127.0.0.1` only** (`server.listen(PORT, '127.0.0.1')`, line ~1974) — not exposed to the network. This is the single most important control and it's correct.
- **The OAuth token is handled well.** `usage.mjs` reads `~/.claude/.credentials.json` locally and sends the bearer token **only** to `https://api.anthropic.com` over TLS. It is never written to disk by us, logged, or sent anywhere else. No passwords are handled anywhere in the system.
- `/open` validates `^https?://` and `openInWorkChrome` uses `spawn(exe, [args])` (no shell) — so no command injection through meeting URLs.

**Findings:**
- **[MED] No auth / Origin check → CSRF & DNS-rebinding.** Every endpoint is unauthenticated; localhost-only stops the network but **not the browser**. Any web page you visit can fire `fetch('http://127.0.0.1:8124/...', {method:'POST', mode:'no-cors'})`. The dangerous ones: `/open` (opens an attacker URL **in your work Google profile** — phishing/SSO abuse), `/spawn` (launches terminals), `/hear` with `{"text":"jarvis shutdown"}` (kills the hub). _Fix:_ reject requests whose `Origin`/`Host` isn't the console's own; or require a per-session token (set at launch, sent by the console JS). Cheap and high-value.
- **[MED] perm-hook auto-allows every file write.** `perm-hook.mjs:23` returns `allow` for `Edit|Write|MultiEdit` unconditionally — only `Bash` is actually gated through the hub. A spawned worker can overwrite **any file on disk** (including this hub's source, or files outside its repo) with no prompt. _Fix:_ route writes through `/permission` too, or at least auto-allow only writes **inside the worker's own cwd** and gate the rest.
- **[LOW, but you asked] Voice recognition leaves the machine.** The console uses the browser Web Speech API (`webkitSpeechRecognition`). In Chrome that **streams your microphone audio to Google's servers** for transcription — the mic path is only as private as Chrome's speech service. If "voice recognition being secure" means audio-stays-on-box, this is the gap. _Fix (if it matters):_ a local recognizer (whisper.cpp / Vosk) feeding `/hear`. Otherwise, document that audio transits Google.
- **[LOW] `cwd` is not sanitized in `spawnWorker`** (purpose is, via `replace(/["'^&<>|%]/g,'')`). `cwd` is interpolated into the generated `.cmd` (`cd /d "<cwd>"`). It's operator-controlled (from `repos.json`/board), so low risk, but worth the same scrub.
- **[INFO] Data at rest, local.** Screenshots persist (last 20) in `DATA/screen/`; `tokens.mjs` reads **all** projects' transcripts under `~/.claude/projects` (usage fields only) for the burn gauge; chat/attachments persist unencrypted. All local, single-user — fine to know, not urgent.

---

## 2. Data integrity ("the data guy who hates losing data")

This is where I'd spend the first hour.

- **[HIGH] Non-atomic writes.** `saveRoster`, `saveWork`, `saveSchedule` do `writeFileSync(FILE, JSON.stringify(...))` — a full truncate-and-rewrite. A crash, power loss, or `Ctrl-C` **mid-write** leaves a truncated/empty/half file. _Fix:_ write to `FILE.tmp` then `renameSync(FILE.tmp, FILE)` (atomic on the same volume). ~5 lines, removes the whole class of corruption.
- **[HIGH] Corrupt-parse silently resets to empty.** `loadWork()`/`loadRoster()` wrap `JSON.parse` in `try/catch` and on failure return a **fresh empty default**. Combined with the non-atomic write above: one bad write → next load silently discards **every task / every session record**, then the next save persists the empty state. No backup, no alert. _Fix:_ on parse failure, **rename the bad file to `*.corrupt-<ts>`**, log/announce loudly, and refuse to overwrite with empty — fail safe, not silent.
- **[MED] No backups / no rotation** of `sessions.json` / `worklist.json` / `schedule.json`. A periodic snapshot (even a daily copy into `archive/`) would make the two HIGH items recoverable rather than fatal.
- **[LOW] Very high write frequency.** `lastSeen` is updated and `saveRoster()` called on **every poll** of **every session** (~one full rewrite of `sessions.json` per poll). That's a lot of churn and it widens the corruption window. _Fix:_ throttle `lastSeen` persistence (e.g. flush at most every few seconds), or keep `lastSeen` in memory and persist only meaningful changes.
- **[GOOD] Append-only logs.** `transcript.jsonl` and `bus.jsonl` use `appendFileSync` (durable, no rewrite), and each retired session is its own `archive/<uid>.json`. The session-to-session **handoff** added tonight also means a dying session's work is captured (summary + notes + unfinished board) rather than lost.

---

## 3. Robustness & failure modes

- **[MED] No supervisor.** If the node process crashes, the hub is **down until a human relaunches it**. Worker poll loops retry forever (good) but nothing brings node back. _Fix:_ run under a supervisor that auto-restarts (pm2 / nssm as a Windows service / a Scheduled Task with restart, or a tiny watchdog `.cmd`).
- **[MED] Unbounded in-memory + on-disk growth.** At startup `transcriptCache = loadJsonl(TRANSCRIPT)` and `bus = loadJsonl(BUS)` load the **entire** files into RAM, and both arrays `.push` forever; the `.jsonl` files never rotate. Over a long-lived hub: growing memory, and `/transcript` re-`filter().map()`s the whole history **every 1.5s per open console**. _Fix:_ cap the in-memory arrays (keep last N), and rotate/truncate the `.jsonl` files (or compact on startup).
- **[LOW] In-memory-only state resets on restart:** pause/mute/meeting-mode/`screenGrant`/`pendingPerms`/`pollWaiters`. Held-open permission requests are dropped on a bounce (the worker's hook then falls back to a terminal prompt — acceptable). Worth documenting; persisting pause/mute is a known nice-to-have.
- **[GOOD]** Persistent state survives restarts; `handleRequest` is wrapped in a `try/catch → 500`; the long-poll has a 25s timeout + cleanup on socket close.

---

## 4. File-system organization

- **[MED] Runtime state lives inside the repo.** `DATA` defaults to `HERE` (the source dir), so `sessions.json`, `worklist.json`, `transcript.jsonl`, `bus.jsonl`, `schedule.json`, `archive/`, `attachments/`, `screen/`, and the `spawn-*.cmd` scripts all get written **into the git working tree**. `.gitignore` correctly keeps them out of git, but mixing live data with code makes the working dir noisy and risks an accidental `git clean -x` wiping state. _Fix:_ point `JARVIS_DATA` at a dir **outside** the repo (e.g. `%LOCALAPPDATA%\jarvis`).
- **[LOW] `spawn-*.cmd` clutter.** 21 of them on disk now, one per callsign ever spawned, never cleaned. _Fix:_ delete on retire, or sweep on startup.
- **[MED] Monolith + inline UI.** The entire console (HTML + CSS + a few hundred lines of JS) is a single template literal inside `jarvis-core.mjs`, which is why a custom `extract-check.mjs` exists just to lint the inline JS (`node --check` can't see inside the string). It works but it's the hardest part to maintain. _Fix (longer-term):_ move the console to static files (`console.html` / `.css` / `.js`) served by the hub, and split the server into a few modules (routes, roster, worklist, schedule). The inline-`\\n` escaping rule disappears for free.

---

## 5. The lift to hand this to someone else

**Verdict: moderate. A capable dev could run it day one and be productive in ~1–2 days — but several things are tacit.**

What helps a new owner today: `npm start` just works; `DESIGN.md` / `README.md` / `CLAUDE.md` / `WORKER.md` exist; the protocol is self-describing (`GET /protocol`); and **session-to-session handoff is now solid** (tonight: auto-successor on retire, register-time handoff hint, archive of every retired session).

What raises the lift:
- **Windows-coupled:** `wt.exe`, `powershell.exe`, `cmd /k`, hard chrome-profile resolution, `.cmd` spawn scripts. Not portable; not documented as a hard requirement.
- **No tests.** Nothing guards the worklist migration, the handoff logic, the schedule parser, or the command regexes. The `node --check` + `extract-check` ritual is the only safety net and it's only syntax-deep.
- **Tribal restart ritual:** "shutdown via `/hear`, wait for the port, `start-jarvis.cmd`, and always run both syntax checks first" lives in handoff docs, not in tooling. A `npm run restart` / `npm run check` would encode it.
- **The monolith + inline UI** (see §4) is the steepest part of the learning curve.

**Highest-leverage lift-reducers:** (1) a one-page `ARCHITECTURE.md` — the endpoint list, the data files and who owns them, the session lifecycle, and the spawn/handoff flow; (2) a handful of tests around worklist migration + handoff + schedule parsing; (3) split the console out of the template literal; (4) state the platform assumptions (or abstract the 3–4 Windows calls).

---

## 6. Prioritized punch list

| # | Severity | Area | Fix | Effort |
|---|----------|------|-----|--------|
| 1 | HIGH | data | Atomic writes (`tmp`+`rename`) for all `save*` | ~15 min |
| 2 | HIGH | data | Don't reset to empty on bad parse — back up + alert | ~20 min |
| 3 | MED | sec | Origin/Host (or token) check on mutating endpoints | ~30 min |
| 4 | MED | sec | Gate or cwd-scope Edit/Write in `perm-hook.mjs` | ~20 min |
| 5 | MED | robust | Run under a supervisor (auto-restart) | ~30 min |
| 6 | MED | robust | Cap in-memory `transcriptCache`/`bus` + rotate `.jsonl` | ~45 min |
| 7 | MED | fs | `JARVIS_DATA` outside the repo | ~10 min |
| 8 | MED | maint | Split console out of the template literal | ~2 h |
| 9 | LOW | data | Throttle `lastSeen` persistence | ~15 min |
| 10 | LOW | sec | Note/replace browser speech (audio → Google) | varies |
| 11 | LOW | fs | Clean up `spawn-*.cmd` on retire | ~10 min |
| — | — | lift | `ARCHITECTURE.md` + a few tests | ~half day |

None of these block daily use. #1 and #2 are the ones that can actually lose your data; I'd start there.
