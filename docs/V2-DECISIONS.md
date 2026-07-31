# JARVIS v2 — the open decisions

Eight things nobody but Chris (or the coordinator) can settle. They are collected here so they get
answered **once**, in one sitting, instead of being rediscovered one at a time by whoever writes the
next piece of v2.

**ALL EIGHT ARE ANSWERED — Chris, by voice, 2026-07-31 10:10 CDT.** Each entry keeps the question,
the options and the original recommendation so the reasoning stays auditable, and now carries the
ruling. Where the ruling departs from the recommendation it says so and says why; **D1 does, and it
is the most consequential line in this file.**

Sources: `docs/V2-SCHEMA.md` part D, plus three added by `docs/V2-SCHEMA-REVIEW.md`.

---

## The answers

| # | Decision | Ruling |
| --- | --- | --- |
| **D1** | Node or .NET? | **.NET** — latest .NET, latest EF Core, latest Angular + PrimeNG. **Overrides the recommendation below.** |
| **D5** | Does the old reporting store survive? | **Backfill from it, then retire it.** Order is binding. |
| **D8** | How are calendar times stored? | **`DATETIMEOFFSET(3)`**, `calendar_event` only. Already applied. |
| **D7** | Where do reactions live? | **`reaction` table only**; drop `'react'` from `message.kind`. |
| **D2** | Event retention | **Keep everything**, partition later. |
| **D3** | Is `gap` durable? | **Yes**, make it a stored event. |
| **D4** | Broadcast `to:'all'` | **Drop it.** |
| **D6** | When can `text_raw` go? | **After a human audit** of the 28 ambiguous cards. |

### What D1 changes, and what it does not

It does **not** change the schema. `docs/V2-SCHEMA.md` was written to be stack-independent and it
survives this ruling unedited — the DDL is T-SQL either way.

It **does** change the shape of the project. Node would have been a restructure; .NET is a rebuild of
the hub and every worker-facing endpoint from `docs/V2-CURRENT-SYSTEM.md`. That document stops being
a reference and becomes the specification.

**One consequence needs naming, and it is smaller than it first looks.** The instinct is that .NET
costs us the voice path. Measured against the code, it does not:

| Piece | Where it actually lives | Cost under .NET |
| --- | --- | --- |
| Google STT | `webkitSpeechRecognition`, `console.js:2201` — **the browser** | **None.** Angular inherits it. |
| Text-to-speech | `speechSynthesis`, `console.js:2259` — **the browser** | **None.** |
| Mic capture, VAD, echo-drop, barge-in | `console.js:2289`–`2310` — **the browser** | **None.** |
| Local whisper | `stt.mjs`, 131 lines: spawn `whisper-server.exe`, POST a WAV to `127.0.0.1:8125` | **Low.** `Process.Start` + `HttpClient`. |

Nearly the whole voice *surface* is front-end JavaScript that survives the back-end swap untouched,
and the one Node piece is subprocess plumbing that .NET does as readily as Node.

The real rewrite is **`handleUtterance`** — 24 inline regex intent dispatches and 71 `enqueueSay`
sites in `jarvis-core.mjs` (find it with `grep -n "^function handleUtterance"`; the line number
drifts). That is server-side dispatch logic, not voice technology, and it is the same rewrite every
other endpoint faces. It is real work, but it is not a reason to reconsider .NET, and no separate
decision is needed. **D9 is therefore closed as answered rather than left open** — recorded because
the question was asked and the measured answer is worth not re-deriving.

---

## D1. Back-end language: Node or .NET?

The schema is settled and stack-independent. The **access layer** is not: `node:sqlite` has no SQL
Server driver, so a Node v2 needs `mssql`/Tedious, while .NET gets EF Core or Dapper. **This does not
fork the DDL.**

| Option | What it costs |
| --- | --- |
| **Node** | Keeps every line of v1 reusable — the hub, console, STT and voice-intent code are all already Node. Adds a driver dependency and hand-written SQL or a light query builder. No migration framework. |
| **.NET** | Best SQL Server story: EF Core migrations, real typing over 30-odd tables, LINQ. Costs a **full rewrite** of the hub and every worker-facing endpoint, and the voice/STT path has no .NET equivalent today. |
| **Split** | .NET for data + API, Node keeps voice and console. Costs a second process, a second deploy and an internal contract between them. |

**Recommendation: Node.** Not because it is the better data stack — it isn't — but because the
rewrite cost is the whole project and the data layer is the smaller half. The schema was written to
survive either choice, so this is reversible later in a way a rewrite is not.

---

## D5. Does `db.mjs` / `jarvis.db` survive? — **answer this before anything is deleted**

The new schema supersedes the SQLite reporting mirror entirely. But the review found the mirror is
**the only source** for three columns: `task.started_at`, `task.done_at` and `task.dropped_at`.
`worklist.json` stores only `id`, `text`, `addedAt`, `notes` and `priority` — no lifecycle
timestamps at all.

| Option | What it costs |
| --- | --- |
| **Backfill from it, then retire it** | One extra migration step reading `jarvis.db` (335 KB). Keeps every lifecycle timestamp JARVIS has ever recorded. |
| **Retire it without backfilling** | Free now. `started_at`/`done_at`/`dropped_at` are **empty forever** and v2's throughput reporting starts from zero history. Not recoverable. |
| **Keep it running alongside** | Two stores to keep in sync — the problem v2 exists to remove. |

**Recommendation: backfill, then retire.** The order is the whole decision. It also has a CLI with
users, so retiring it needs a note to them, not just a delete.

---

## D8. Calendar times: `DATETIMEOFFSET` or converted to UTC?

The schema promises every timestamp is UTC. Real `schedule.events` timestamps are not — all 8 look
like `2026-07-30T09:30:00-05:00`. Casting that to `DATETIME2` keeps the digits and drops the offset,
so meetings land five hours off, silently, in the column that drives the T-5 / T-0 announcements.

| Option | What it costs |
| --- | --- |
| **`DATETIMEOFFSET(3)`** | One column type change on `calendar_event`. Keeps the offset, so DST is unambiguous. Slightly wider rows. |
| **Convert to UTC on import** | Keeps the schema uniform. Loses the original offset, so a time near a DST boundary can't be reproduced exactly. |
| **Store local, ignore offset** | Free, and wrong. This is the current behaviour of a straight `CAST`. |

**Recommendation: `DATETIMEOFFSET(3)`, for `calendar_event` only.** Everything else in v1 genuinely
is `toISOString()` UTC and should stay `DATETIME2(3)`.

---

## D7. Where do reactions live: `message`, `reaction`, or both?

`POST /react` is append-only and writes exactly one thing — a **transcript row** of `kind:'react'`
carrying the target's `ts` and the reaction. The schema gives that record two homes and never says
which wins.

| Option | What it costs |
| --- | --- |
| **`reaction` table only** | Clean, queryable, one row per reaction. Changes what the console renders — v1 currently shows a transcript line whose body is the word `up`. |
| **`message` rows only** | Zero behaviour change. Every "who liked what" query goes back to matching on `ts`, which A5 exists to stop. |
| **Both** | Matches v1 exactly and keeps A5's clean FK. Costs double-counting risk in every report that counts messages. |

**Recommendation: `reaction` table only, and drop the `'react'` value from `message.kind`.** Only 3
reactions exist in the entire store, so the migration is trivial and the console change is small. Two
loose ends go with it: drop `ux_reaction_once` (v1 permits reacting twice; the index forbids it), and
decide what happens to a reaction whose target has been trimmed out of the transcript.

---

## D2. Does `event` keep everything forever?

v1 trims the bus and the trimmed events are gone. 5061 of ~7031 are retained today.

| Option | What it costs |
| --- | --- |
| **Keep everything** | Full history, and the cursor is absolute either way so nothing else changes. Table grows without bound; wants partitioning eventually. |
| **Archive on a schedule** | Bounded hot table. Needs a partition scheme and a job that can fail quietly. |
| **Trim, like v1** | Simplest. Throws away the same history v1 throws away. |

**Recommendation: keep everything, partition later.** ~7000 events over six weeks is not a volume
problem, and this is the cheapest decision on the list to revisit.

---

## D3. Does `gap` become a durable event?

Today `gap` is synthesized onto a poll response and never stored, so a session that misses it has no
way back. Making it real would be a genuine improvement — and a **behaviour change**, which is why it
needs an explicit yes rather than a quiet extra CHECK value.

| Option | What it costs |
| --- | --- |
| **Make it durable** | A missed `gap` becomes re-readable, which is the whole point of the warning. Adds a CHECK value and a writer; a stored `gap` can now itself be missed, so it needs its own read-marker. |
| **Leave it synthesized** | No work. The one warning designed to recover a lost event is itself unrecoverable. |

**Recommendation: make it durable.** The bug it warns about has already cost a delegate's whole
report, and a warning you can miss is not a safety net.

---

## D4. Broadcast (`to: 'all'`) — build it or drop it?

v1's read paths accept it. **Nothing writes it: 0 of 5061 real events.** It is a vestige.

| Option | What it costs |
| --- | --- |
| **Drop it** | `event.to_actor_id` stays `NOT NULL` and simple. No way to address every session at once. |
| **Build it properly** | An `event_recipient` child table. Real fan-out; a schema change and a delivery-tracking question nobody has asked for yet. |
| **Carry the vestige** | Nullable `to` forever, for a case that never occurs. Worst of both. |

**Recommendation: drop it.** The wind-down path already loops over sessions and sends each one an
event, so the capability exists where it is actually needed.

---

## D6. When can `task.text_raw` be dropped?

`text_raw` keeps the original card string so the tag/headline/detail parse can be re-run and audited
rather than restored. It is the migration's safety net.

Real numbers: **765 of 772** cards are tagged, **28** contain ` -- `, and **2** contain it more than
once — the genuinely lossy case, and it exists today.

| Option | What it costs |
| --- | --- |
| **Keep it indefinitely** | A duplicated string per card. 772 cards; the cost is noise. |
| **Drop after an audit** | Someone eyeballs the 28 split cards and the 7 untagged ones and signs off. Half an hour, once. |
| **Drop with the migration** | Saves nothing measurable and makes a re-parse a restore. |

**Recommendation: drop after an audit, and treat the audit as the deliverable rather than the
deletion.** 28 rows is a small enough set to check by hand, and it wants an owner.

---

## Not on this list

Two things that look like open decisions and are not:

- **The `dropped` task lane** is settled in the schema and should stay — v1's `op:drop` deletes the
  card, so abandoned work is invisible to any reconstruction.
- **A1 (`to` means a session, never a callsign)** is settled and was independently re-verified: 26
  callsigns over 464 sessions, mean reuse 17.8x, and all 26 have served more than one directory. If
  anyone reopens it, every foreign key in the schema moves.
