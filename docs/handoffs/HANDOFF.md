# JARVIS console build — handoff

_Current as of 2026-06-16 (delta / s_0033). Supersedes the papa handoff._

You are the successor on the JARVIS console build in `d:\claude\jarvis-core`. **The live board
is the source of truth, not this file** — the handoff mechanism is now automatic (see §2).
This doc is the durable orientation; read it once, then work the board.

## 1. What you are

A **builder** session: you edit the SOURCE here (`jarvis-core.mjs`, `perm-hook.mjs`,
`WORKER.md`, the `*.md` docs) and restart the hub to deploy. You register/poll like any
worker (`GET /protocol`), but your job is the codebase itself.

**Never write the hub's RUNTIME state** — `sessions.json`, `worklist.json`,
`transcript.jsonl`, `bus.jsonl`, `schedule.json`, `repos.json`, `say.txt`, `archive/`,
`attachments/`, `screen/`. Read them for verification only; the running hub owns them.

## 2. Session handoff is automatic now (built this session)

This was the headline work — Chris kept losing his task list when a session was replaced.
Fixed end-to-end:

- **`POST /handoff {uid,summary,notes}`** — checkpoint your state any time (latest wins).
  Do this when you cross ~85% context or before you retire.
- **Auto-successor:** `POST /retire` with unfinished work (or `successor:true`) auto-spawns a
  fresh session on the same cwd+purpose, **transfers your FULL board** (working+queued →
  its queue, review → review, done → done; logs `moved/total` and warns on a drop), moves
  focus to it, and boots it with a prompt telling it to `GET /handoff?cs=<cs>` and resume.
- **Manual restart covered too:** `registerSession` returns a `handoff` hint if the cwd has
  one, so a session you start by hand is told to `GET /handoff?cwd=<cwd>` and resume.
- Every retired session is archived to `archive/<uid>.json` (summary + notes + board) and
  surfaced via `GET /archive` and the console's ARCHIVE panel (🚀 continue restores it).
- Endpoints added: `POST/GET /handoff`, `GET /archive`. Contract documented in `WORKER.md` §5.

**To resume a real handoff:** if your boot prompt or register response mentions a handoff,
`GET /handoff?cs=<your-callsign>` (or `?cwd=<cwd>`), post one chat line that you picked it
up, then work the board.

## 3. The board (how Chris wants it run)

Lanes: **working → review → done**, plus **queued**. Chris's rule (this session):
- **Completed work goes to `review`** — it's his morning approval queue. **`done` = he
  approved it.** Don't move your own work straight to done.
- Tasks carry a short **summary** in `text` + details in **`notes`** (renders as an
  expandable ▸ on the card). Keep new tasks in that shape.
- `/worklist` ops: `add, start, done, review, ready, top` (move to front), `drop, move,
  clear-done`. The `review` lane is in `worklist.json` (v3, migration-safe).

The `queued` lane is a **prioritized backlog with notes** (bugs first, then the REVIEW.md
security/robustness items, then features). The `review` lane is this session's shipped work
awaiting Chris.

## 4. Also shipped this session

Guy Ritchie easter egg (say "guy ritchie" etc. — for Big Chris), `focus <cs>` without "on",
the `{ checking in` chip bug (a botched register+greet — `/say` now rejects an unknown
`from`), perm-request cards float to top, message reactions (👍❤️👎💩, append-only feedback
signal), and the two HIGH data-loss fixes from the review: **atomic writes** (tmp+rename) and
**no silent reset** on a corrupt state file (it backs up + alerts instead).

`REVIEW.md` is a full architecture/security/data/robustness audit with a prioritized punch
list — the SECURITY/ROBUST/FS/MAINT items in the queue come from it. Start there for the
next wave; the two HIGH items are already done.

## 5. Procedures (do not skip)

- **Syntax-check BEFORE every restart:** `node --check jarvis-core.mjs` ; `node --check
  perm-hook.mjs` ; `node /tmp/extract-check.mjs` (validates the inline `CONSOLE_HTML`
  `<script>` — `node --check` can't see inside the template literal).
- **Restart:** `POST /hear {"text":"jarvis shutdown","typed":true}` → wait for port 8124 down
  (~3s) → PowerShell `Start-Process d:\claude\jarvis-core\start-jarvis.cmd` → wait for
  `/board` to answer. State persists. Restart **sparingly**; only delta is usually alive and
  the poll loop rides out the bounce.
- **`/send` long text / Windows paths:** write JSON to a temp file + `curl --data-binary
  @/c/Users/.../file.json` (Git-Bash MSYS path, not `C:\`). Inline `-d` breaks on
  backslashes/quotes.
- **Inside `CONSOLE_HTML`:** a JS newline literal is written `\\n`.
- **Client rendering isn't visually verifiable from a worker** (screenshots are voice-gated).
  Lean on the two syntax checks; the hub stays up even if a render throws, so eyeball the
  console after a UI change.

## 6. Chris

Fast reader — headlines by voice, detail in chat. Reviews overnight work in the morning.
"Big Chris" (Lock Stock). Trusts the builder to run autonomously; keep the board honest and
in summary+notes shape, and only wake him for a real decision.
