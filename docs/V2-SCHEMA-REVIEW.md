# V2-SCHEMA.md — adversarial review

**What this is.** An independent review of `docs/V2-SCHEMA.md`, commissioned because that document
had never been read by anyone but its author. The brief was to **refute** oscar's six rulings rather
than confirm them, and to validate the DDL against the **real data in `JARVIS_DATA`** rather than
against `docs/V2-CURRENT-SYSTEM.md` — because both documents have the same author, so a wrong
assumption shared between them is invisible from inside either one.

**I did not edit V2-SCHEMA.md.** Everything below is a proposal. Each item is labelled **DEFECT**
(the schema is wrong and real data proves it), **OPINION** (a judgement call I would make
differently), or **SURVIVOR** (I attacked it and it held).

**Anchors, not line numbers** — same rule as the document under review.

---

## The instrument, and its own failure

A read-only auditor parsed the DDL **out of V2-SCHEMA.md itself** (not out of my transcription of
it), walked every file in `JARVIS_DATA`, and asserted each declared constraint against real rows.
Nothing was opened for write.

**Its first run reported five failures and four of them were mine, not the schema's.** I had guessed
v1's field names: the auditor looked for `registeredAt`/`endedAt` where sessions actually store
`started`/`ended`, and treated `projects.json`'s `projects` as a name-keyed map when it is an
**array**. Every session therefore looked live and unregistered, and every board column looked
unclassifiable. This is the under-fed-test failure mode this repo keeps paying for: the assertions
were fine, the accessors never reached the data.

The corrected pass opens with an accessor self-check that aborts before printing any verdict if the
data is not reachable and discriminating. **Do not trust an audit of this kind that cannot show its
accessors resolved.** Counts below are from the corrected pass: **464 sessions (4 live), 772 live
task cards, 5061 retained bus events, ~5960 + ~2002 transcript rows, 110 handoff records, 5
projects, 3 missions.**

---

## Scoreboard

| | |
| --- | --- |
| Rulings A1-A6 attacked | 6 — **five survive intact**, one survives with broken reasoning (A6) |
| Defects, proven against real rows | **7** |
| Defects, proven by reading the DDL | **3** |
| Opinions / judgement calls | 4 |
| Overall | The document is sound. Nothing below overturns a ruling or moves a foreign key. |

---

## DEFECTS — real data breaks the DDL

### D1. `task.priority INT` cannot hold the only real value. A straight migration throws.
`priority` is declared `INT NULL`. Exactly one live card populates it, and the value is the string
**`"high"`**. Not a number, and not on the list of columns the document calls "v1 placeholders, never
populated" — that note covers `start_date`/`due_date` only.
**Fix:** `priority VARCHAR(10) NULL` with a CHECK, or map `high|normal|low` to integers in the
migration and say so in an M-note. Either is fine; silently casting is not.

### D2. Calendar timestamps carry a UTC offset. The preamble's blanket claim is false, and M9 misses it.
Part B opens with "All timestamps **UTC**; v1 writes `toISOString()`, so this is a straight read."
That holds for sessions, tasks, the transcript and the bus — I checked, it does. It does **not** hold
for `schedule.events`: **8 of 8** real event timestamps look like `2026-07-30T09:30:00-05:00` —
Google Calendar's offset form, not `Z`.

`CAST` of that into `DATETIME2(3)` keeps the wall-clock digits and **discards the offset**, so every
meeting silently lands five hours off in a column the schema promises is UTC. This is user-visible:
the T-5 / T-0 / end announcements fire off these values. M9 lists exactly two exceptions —
`trust_until`/`away_until` (epoch ms) and `calendar_day.day_date` (a `toDateString`), both of which I
verified are correctly described. **This is a third exception and it is the dangerous one**, because
the other two fail loudly and this one does not.
**Fix:** `calendar_event.starts_at`/`ends_at` become `DATETIMEOFFSET(3)`, or the migration converts
to UTC explicitly. Prefer the former — a local wall-clock time is ambiguous across the DST boundary
(`-05:00` vs `-06:00`), so discarding the offset loses information that cannot be recovered.

### D3. M4's resolution rule resolves **0 of 45** real cases. A one-word change makes it 45 of 45.
M4 proposes attributing a `project_log` entry to a session by "matching on the log entry's `ts`
falling inside a session's `[registered_at, ended_at]` window".

Measured against the real log: **45 entries carry a from-label, and not one of them falls inside its
callsign's session window.** All 45 land *after* the nearest end, by **1 ms to 4.9 s (median 441
ms)**. The mechanism is obvious once measured — the retire path stamps `ended` and *then* appends the
project-log entry, so the log timestamp is always just past the window it is supposed to fall inside.
M4 as written would leave every single label unresolved.

**Fix:** attribute to *the session of that callsign whose `ended` is the latest one at or before the
log `ts`*. That rule resolves **45 of 45 uniquely, with zero ties**. Keep M4's fallback (leave
`from_actor_id` NULL, keep the label) for the genuinely unresolvable — it is the right instinct, it
just never fires today.

### D4. Three lifecycle columns have no source outside `jarvis.db`, which Part D proposes to delete.
`worklist.json`'s task rows carry exactly five fields: `id`, `text`, `addedAt`, `notes`, `priority`.
So of 18 declared `task` columns, **five have no source**: `start_date` and `due_date` (correctly
flagged as never-populated) and **`started_at`, `done_at`, `dropped_at` — which are not flagged at
all.**

This matters because B2's first "must survive into v2" argument is entirely *about* `done_at`:
"`op:ready` pulls a finished card back to `queued` and does not clear `done_at` (`db.mjs`
COALESCEs)". That behaviour is real, but it lives in the **SQLite mirror**, not in `worklist.json`.
`jarvis.db` is the only place those timestamps exist (335 KB, present in `JARVIS_DATA`).

**Therefore D6 — "does the reporting store survive?" — is not an independent question. It is an
ordering constraint on the migration.** If `db.mjs`/`jarvis.db` is retired before those columns are
backfilled from it, every lifecycle timestamp in JARVIS's history is gone and v2's throughput
reporting starts from zero. The document recommends retiring it. That recommendation is fine; doing
it in the wrong order is not.
**Fix:** an M-note stating that `started_at`/`done_at`/`dropped_at` are backfilled from `jarvis.db`
and that this must happen **before** any decision to retire it is executed.

### D5. The DDL cannot be run in the order it is written, and M1 asserts that it can.
`CREATE TABLE session` (B1) declares `fk_session_project` and `fk_session_parent_project` inline
against `project`. `CREATE TABLE board` (B2) declares `fk_board_project` the same way. `project` is
not created until B3. All three statements fail on a clean database.

The document already knows the fix and applies it once — `project.mission_id` is attached with a
trailing `ALTER TABLE project ADD CONSTRAINT fk_project_mission`. It just wasn't applied to the
other direction. M1 then says: "`session` and `project` are mutually referential, so create the FK on
`session.project_id` after both tables exist, **as the DDL above does**." It doesn't.
**Fix:** move those three constraints to `ALTER TABLE` statements after B3, matching the pattern the
document already uses. Cheap, and it makes M1 true.

### D6. `actor` permits two rows per session — the exact defect A1 exists to prevent.
`ux_actor_singleton` constrains the `human` and `hub` rows to one apiece. **Nothing constrains
`session_id`.** Two `actor` rows pointing at one session would split that session's messages across
two sender keys, and `v_message` resolves both to the same callsign, so the console would render it
correctly while every per-session count silently halved. A1's whole purpose is "every message has
exactly one sender key"; the DDL does not enforce it.
**Fix:** `CREATE UNIQUE INDEX ux_actor_session ON actor(session_id) WHERE session_id IS NOT NULL;`
Same filtered-unique idiom as `ux_session_live_callsign`.

Related, and smaller: M1's order is `actor` (seed) → `project` → `mission` → `session` → `board`. The
**seed** rows work at that point because their `session_id` is NULL, but the per-session `actor` rows
cannot be inserted until `session` exists. M1 should say so; as written it reads as though all of
`actor` is populated first.

### D7. Reactions are modelled twice, and `reaction.message_id NOT NULL` can outlive its target.
`POST /react` is, by its own comment, **append-only**, and its only persistence is a **transcript
row**: `kind:'react'`, `from:'you'`, `target` = the target message's `ts`, `text` = the reaction.
There is no separate reaction store in v1.

The schema gives that one record two homes — `message.kind` includes `'react'` **and** there is a
`reaction` table — and never says which is authoritative. Three consequences, none resolved:

1. **Double-counting.** If the migration writes both, `v_message` emits a transcript message whose
   body is the literal string `"up"`. v1 does render it that way today, so this may well be intended
   — but it has to be *stated*, or the next reader normalizes one of them away.
2. **`ux_reaction_once` is stricter than v1.** UNIQUE `(message_id, actor_id, reaction)` forbids what
   an append-only endpoint permits: react `up` twice on one message and v1 writes two rows. Only 3
   react rows exist today and none collide, so the migration passes **by luck, not by design**.
3. **`message_id NOT NULL` is not always satisfiable.** `target` is a raw `ts` and the transcript is
   **trimmed**, so a reaction can outlive the message it points at. All 3 current reactions still
   resolve, but A5's own argument cuts here too: **12 distinct `ts` values are already shared by more
   than one transcript row.** A reaction landing on one of those has no unique target.

**Fix:** name the authoritative store; drop `ux_reaction_once` (or document it as a deliberate
behaviour change); and give M6 a rule for a react whose target does not resolve — a nullable
`target_ts` alongside `message_id` costs nothing and keeps the row.

### D8. `session.watching` has no column, and `GET /board` projects it.
One real session carries `watching: {channel: "#jarvis", ts: "..."}`. The string `watch` appears
nowhere in V2-SCHEMA.md. This is not a vestige like `to:'all'` — the board endpoint reads it, so the
console depends on it.
**Fix:** `watch_channel NVARCHAR(80) NULL, watch_since DATETIME2(3) NULL` on `session`.

### D9. `handoff.purpose_norm NOT NULL` cannot represent the 6 legacy records.
M10 correctly counts 6 handoff records on legacy cwd-only keys (I measure 6 of 110 — M10's other
figure has drifted, it is 110 records now, not 106). Those keys have **no purpose component at all**,
and `purpose_norm` is `NOT NULL`. Each needs a sentinel, and once they all share `''`, two legacy
records under one directory collide on `ux_handoff_job`. Today all 6 are under distinct directories,
so it happens to import — again, luck.
**Fix:** allow `purpose_norm NULL` and make the unique index tolerate it, or state the sentinel and
add the collision to M3's "inspect, do not auto-resolve" list.

### D10. `session.cwd NOT NULL` rejects the oldest row in the store.
`s_0001` — the first session JARVIS ever registered, alpha, 2026-06-12 — has no `cwd`. One row out of
464. It will fail the import.
**Fix:** one line in M3, or make the column nullable. Not worth more than that.

### D11. A6's decision is right; its stated reasoning is refutable, so the decision is at risk.
A6 chooses `SEQUENCE` over `IDENTITY` because "`IDENTITY` is not rollback-safe — a failed insert
consumes a value and leaves a permanent gap", implying a sequence does not. **A sequence behaves
identically.** SQL Server generates sequence values outside transaction scope and consumes them
whether the transaction commits or rolls back, and the default `CACHE` makes gaps *larger* on an
unclean shutdown, not smaller.

I am not asking to change the decision — `SEQUENCE` is the right call, for a reason the document
doesn't give: **you can obtain the value before the insert**, which is exactly what makes a `POST
/send` receipt able to return the landed `seq` without `SCOPE_IDENTITY()` plumbing. And `NO CACHE`
makes the gap behaviour bounded and explicit, which is the half of the current argument that is true.
This matters *because* the document's own rule is "argue with the reasoning rather than the choice" —
leave the reasoning as it stands and the next reviewer refutes it and rips out the sequence.

---

## OPINIONS — I would decide these differently

### O1. One handoff row per job means each handoff erases its predecessor.
`ux_handoff_job` is UNIQUE on `(cwd_key, purpose_norm)`, so the table holds the latest handoff per
job and nothing else. That is faithful to v1 — and v1's behaviour is the reason **354 of 464 sessions
left no retrievable handoff at all**.

It also sits awkwardly beside B2, which argues at length that `dropped` must become a real lane
because "abandoned work is invisible to any reconstruction" and "do not hard-delete tasks". The
handoff chain is exactly the audit trail the successor protocol runs on, and this design hard-deletes
it on every write.
**Suggestion:** add `superseded_at DATETIME2(3) NULL` and make the index
`WHERE superseded_at IS NULL` — the same idiom already used for `ux_session_live_callsign`. Current
behaviour is unchanged; history stops being destroyed.

### O2. Three unsourced vestiges are omitted silently, where `to:'all'` got a paragraph.
`project.workers` (present on all 5 projects, **always an empty array**), `task_subtask` (**0 of 772**
cards have a `subtasks` array), and `transcript.command` (1 row, value `shutdown`) have no home or no
source. Omitting them is very likely right — it is the same call the document makes explicitly for
broadcast: "Modelling it now would be building a feature nobody requested off a vestige."

The problem is that the reasoning was written down once and applied silently three more times. The
next session cannot tell "considered and rejected" from "missed".
**Suggestion:** one short "deliberately not modelled, and why" list.

### O3. Do not put a CHECK constraint on `task.tag`.
The DDL declares `tag VARCHAR(10) NULL` with no CHECK. Correct, and it should stay that way: the
protocol documents 10 tags, and the real board carries **14** — `RESEARCH`, `NEXT`, `DEV` and `MERGE`
are all in live use and all fit the width. Flagging it because a CHECK is the obvious "improvement"
for someone to add later, and it would reject real data.

### O4. `DECIMAL(18,9)` for `position` is fine, and the stated risk is smaller than it sounds.
Nine fractional digits exhaust after roughly 30 successive midpoint inserts at the same spot — but
v1 has **no insert-between operation at all**. `add` appends, `top` unshifts to the head (integer
part, no precision cost), and the lane ops move between lanes. The renormalize-on-a-schedule note
already covers the case if one is ever added. No change wanted; recording it so nobody re-derives it.

---

## SURVIVORS — attacked and held

**A1 (`to` means a session; callsign is never a key) — holds, and the evidence is stronger than the
document claims.** 26 distinct callsigns over **464** sessions: mean reuse **17.8x**, max **20x**
(alpha, papa, quebec), and a callsign FK would collide on **438** of them. The document cites
oscar x19; the sharper number is the one it doesn't use — **26 of 26 callsigns have served more than
one `cwd`**, so a callsign FK crosses *project boundaries* as well as time. A1 is the load-bearing
ruling and it is the best-supported one in the document.

**A2 (ordering is a column; array index is never identity) — holds.** All 3 real missions store
phases as `{text, done}` objects with **no id of any kind**, so v1's `op:phase`/`op:unphase` *can*
only address them by index. The lost-update argument is not hypothetical.

**A3 (the spoken ordinal is a view) — holds.** Lane concatenation yields a unique ordinal per card on
all 5 real boards; no card id appears in two lanes. `v_task_ordinal` reproduces `orderedTasks`
faithfully.

**A4 (one string becomes three columns plus the original) — holds, with the lossy case measured.**
765 of 772 cards are tagged; **28** contain ` -- `, and **2 contain it more than once** — the exact
ambiguity `text_raw` is retained for, present in real data today. Keep `text_raw`.

**A5 (a message's identity is a surrogate key) — holds, and it is no longer hypothetical.** The
document argues a `ts` collision is "a question of load, not of possibility". **12 distinct `ts`
values are already shared by more than one transcript row** (worst case two rows). It has happened.
Targeting a message by `ts` is already unsound.

**A6's cursor decision — holds.** Real bus kinds are **exactly** the six the CHECK declares
(`speech` 3643, `msg` 782, `retired` 350, `screenshot` 247, `retire-request` 39). Every real `to` is
a uid. The exclusive-cursor unification is right and the receipt/poll convention split is real. Only
the SEQUENCE *reasoning* fails (D11).

**`event.to_actor_id NOT NULL` — holds. `to:'all'` is genuinely dead: 0 of 5061 real events.**

**`event.from_actor_id` nullable — holds, and I expected it not to.** Every `busAppend` call site
passes a `from`, so I predicted the column was nullable for an impossible case. **3 of 5061 real
events lack `from`** (all `kind:'msg'`), presumably predating the field. The document is right and my
objection was wrong.

**`ck_board_kind` — holds.** I flagged `jarvis` and `primeng` as board columns that were neither a
session nor a project; that was my broken accessor. **Both are real projects**, and no board column is
simultaneously a callsign and a project name, so `board_kind` is derivable from the v1 key without
ambiguity. `hub_state.focus_board_id` as an FK also works — the live focus is `primeng`, which has a
board row.

**M3's stated risk — holds and is currently clean.** Exactly one live session per callsign;
`ux_session_live_callsign` imports without violation. Worth keeping the pre-check anyway, for the
reason M3 gives.

**Everything else asserted and passing:** `ck_session_binding`, `ck_session_tier`,
`ck_session_launch`, `ck_session_ctx`, `ck_task_lane` (real lanes are a subset),
`ck_message_kind` (all 7 real transcript kinds covered), `ck_project_status`, `ck_calann`,
`ck_ai_role`, `ux_lq_once`, `ux_handoff_job` after normalization, `task.ext_id` unique and present on
all 772 cards, and every declared string width against its longest real value — including
`session.doing NVARCHAR(80)` against a real 80-character `doing` line, which fits exactly because v1
truncates there.

**One count to refresh:** M10 says 106 handoff records; it is now **110** (12 with an `auto` block,
81 with written notes, 6 legacy keys, 464 sessions not 461). M10's instruction to re-validate against
live counts is the right instruction — it just needs doing again at switchover, not trusting.

---

## What this review adds to Part D

Part D asks six questions. The review leaves all six open, sharpens one, and adds two.

- **D6 (does `db.mjs`/`jarvis.db` survive?) is now an ordering constraint, not just a preference.**
  See D4 above: three `task` columns can only be sourced from it.
- **NEW — do reactions live in `message`, in `reaction`, or both?** See D7. Cheap to decide, and
  undecided it double-counts.
- **NEW — are calendar times stored as `DATETIMEOFFSET` or converted to UTC on import?** See D2.
  Recommend `DATETIMEOFFSET(3)`; converting throws away DST information.

These are carried into `docs/V2-DECISIONS.md` with options and costs, per quebec's brief.

---

## Re-running the audit

The auditor is throwaway; the method is not. It lived in the review session's scratchpad and is
deliberately not committed — a file-mutating or data-reading harness in the repo is a hazard, and
the shape is quick to rebuild:

1. Parse `CREATE TABLE`/`CREATE VIEW` blocks **out of V2-SCHEMA.md itself**, so the column inventory
   cannot drift from the document.
2. Assert the accessors reach live, discriminating data **and abort if they do not**. Four of five
   first-run failures were bad accessors; without this gate they would have been reported as schema
   defects.
3. Walk `JARVIS_DATA` read-only, collect every field path with counts and max string length, and
   report fields with no matching column.
4. Assert every declared CHECK, UNIQUE, NOT NULL and string width against real rows.
5. Print `checks run / ok / FAIL` and exit non-zero on zero checks. A harness that can report a
   confident verdict having asserted nothing is the trap this repo keeps re-paying for.

Field names that cost me a pass, recorded so the next one is free: sessions use **`started`** and
**`ended`** (not `registeredAt`/`endedAt`), health is **`ctx` / `ctxTs` / `ctxWarned`**, isolation is
**`worktree`** and **`base`**, and `projects.json` holds **`projects` as an array**, not a name-keyed
map. `sessions.json` also carries `callsigns`, `nextUid`, `handoffs`, `held` and `awayUntil` at the
top level.
