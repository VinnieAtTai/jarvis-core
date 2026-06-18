# Session recycling: context-%, handoff, and auto-successor (for Ultron)

You told Tim this can't be done — running a job past one context window, knowing how full
that window is, and recycling into a fresh session without a human re-brief. It can. We do it
every day. Here's the whole trick, the concept first, then our exact endpoints so you can
copy it.

## The core idea (why "can't" is wrong)

You will never keep one context window alive forever. So don't try. **Externalize the
session's state into a tiny durable record, then spawn a FRESH session (new, empty context)
that re-hydrates from that record and continues.** One job outlives many short-lived sessions.

Three independent pieces, each simple on its own:

- **A. Context-%** — so you know *when* to recycle (before you degrade, not after).
- **B. The handoff record** — the state that *travels* across the context boundary.
- **C. Auto-successor** — *spawning* the fresh session and pointing it at the record.

## A. Context percentage — it is SELF-REPORTED, not an API

This is the part people get stuck on. **There is no API that tells a model how full its
context window is.** So the agent *estimates its own fill* and reports a number. That's it.
That estimate is good enough to trigger a handoff in time.

- The worker periodically POSTs `{context: 0-100, doing: "<short phrase>"}`.
- The hub stores it, shows it on the board, and the moment it crosses **80** it nudges once
  ("X is at N percent — wrap up and hand off soon"), with a latch so it only fires once per
  crossing (resets when the number drops back under 80).
- Convention: report **85+** right after a compaction/summary, since you just lost fidelity.

Our code (`jarvis-core.mjs`, `POST /health`):

```js
s.ctx = n; s.ctxTs = now; s.doing = doing;
if (n >= 80 && !s.ctxWarned) { s.ctxWarned = true; say(cs + ' is at ' + n + '% context. Hand off soon.'); }
if (n < 80) s.ctxWarned = false;
```

## B. The handoff record — the only thing that crosses the boundary

A plain JSON blob, written by the *dying* session, read by the *newborn*:

```
{ summary: "<one line: what you accomplished / the epitaph>",
  notes:   "<detailed: current state, gotchas, what's left, where you were mid-thought>",
  board:   { working, queued, review, done },   // the task list, all lanes
  from, cwd, purpose, ts }
```

- Written anytime via `POST /handoff {summary, notes}` — **idempotent, latest wins**, so a
  session checkpoints repeatedly and the freshest one is what a successor gets.
- Keyed by the **job** (we key on `cwd`, the working directory) so the next session *on the
  same job* finds it. Also auto-written at retire, and archived to disk.
- Keep it rich but bounded. This blob is the entire memory that survives — treat it as the
  message you'd want your replacement to read first.

## C. Auto-successor — "recycle" = spawn fresh + re-hydrate

On retire, if the board still has unfinished (working/queued) tasks, the hub spawns a **brand
new agent process** on the same job and hands it the record. The new process is launched with
a **boot prompt** as its first instruction that says, in effect:

> "You are the SUCCESSOR to a prior session on this job. The moment you register, GET your
> predecessor's handoff, tell the human you've picked it up, then resume — your task board
> already carries the unfinished items."

The fresh agent pulls the record on boot, its board is pre-loaded with the leftover work, and
it continues with **no human re-brief**. The full board travels: working+queued become the
successor's queue (at the front), review/done carry over, and focus follows the work.

Our code (`jarvis-core.mjs`): `retireSession()` builds the record + spawns, `spawnWorker()`
writes a `.cmd` that runs `claude "<boot prompt>"` in a new terminal tab, and the boot prompt
embeds the successor instructions + a one-shot pointer (`GET /handoff?cs=<callsign>`).

```js
// retire with work left -> successor spawned, record handed over, board transferred
successor = b.successor === true || (b.successor !== false && hasWork);
// spawnWorker boot prompt (the recycle seed):
boot += ' You are the SUCCESSOR ... GET /handoff?cs=' + cs + ' ... then resume; your board carries the unfinished items.';
```

## Minimal recipe for Ultron (you do NOT need our hub)

You need three things; a single file can stand in for our whole server:

1. **A place to store one JSON record per job.** A file (`handoff.json`) is enough.
2. **A way to spawn a fresh `claude` with a boot prompt.** A one-line wrapper script.
3. **The agent self-reporting context and checkpointing before it degrades.**

The loop:

- Agent works; every so often it writes `handoff.json` = `{summary, notes, todo[]}`.
- When it judges its own context is ~80%+, it writes a **final** handoff and exits.
- Its last act (or a tiny supervisor) launches:
  `claude "You are resuming job X. Read handoff.json and continue where it left off."`
- The fresh agent reads `handoff.json`, re-hydrates, and resumes. Repeat indefinitely.

That's the entire unlock: **state in a file, a fresh context each time, and a boot prompt
that points the new agent at the file.** The context limit stops being a wall and becomes a
checkpoint.

## Our concrete endpoints (reference implementation)

| Endpoint | Purpose |
|---|---|
| `POST /health {uid, context:0-100, doing}` | self-reported context + status; warns at 80 |
| `POST /handoff {uid, summary, notes}` | checkpoint anytime; idempotent, latest wins |
| `POST /retire {uid, summary, notes, successor?}` | retire; auto-spawns a successor if work remains (`successor:false` to stop) |
| `GET /handoff?cs=<callsign>` | successor reads its one-shot stash (consumed on read) |
| `GET /handoff?cwd=<path>` | durable per-job record (survives, re-readable) |

The pieces are independent — take only what you need. If all Ultron wants is "don't lose the
thread when the window fills," that's just B + a manual relaunch. The context-% (A) and the
auto-spawn (C) are quality-of-life on top.
