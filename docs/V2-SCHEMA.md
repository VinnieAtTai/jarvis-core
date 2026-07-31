# JARVIS v2 — the relational schema

**Step 2 of the v2 rebuild.** This turns every JSON file in `JARVIS_DATA` into SQL Server tables.
Its input is `docs/V2-CURRENT-SYSTEM.md` — particularly §6 (real field shapes, measured off the live
store) and §8 (where v1 encodes structure as array position). Read §8 before this; the decisions in
part A are all answers to it.

**Scope.** Schema, DDL, and migration *notes*. **No migration code** — deliberately, and the
boundary is a hard one, not a running-out-of-time one. The shape of the conversion depends on
decisions that are not mine (part D), and code written ahead of those is code someone has to unpick.

**Stack-independent.** SQL Server is settled; the back-end language is **not** — Chris has not picked
Node vs .NET and it is his call. Nothing below assumes either. Where something genuinely forks on
that choice, it is called out as a fork rather than decided.

**Anchors, not line numbers.** Per the lesson this repo just paid for: every reference below names a
*function, table, or field*, never a line in `jarvis-core.mjs`. Those drift; names do not.

---

## A. The decisions

Six of these. Each is a ruling on something v1 left ambiguous, and each is written as **decision +
reasoning**, because a column choice without its reasoning is re-litigated by the next session.

### A1. `to` means a SESSION, always. Callsign is a label, never a key.

**The ambiguity.** One `POST /send` handler writes the same logical fact two ways:

- to the bus: `{from: <uid>, to: <uid>, kind:'msg'}` — **uids**
- to the transcript: `{kind:'msg', from: <callsign>, to: <callsign>}` — **callsigns**

Same field names, two key spaces, one writer. In v1 this is survivable because both are loose JSON.
In a relational store it becomes two incompatible foreign keys on what a reader thinks is one column.

**Decision: the session is the identity. `session_id` is the FK everywhere. Callsign is a display
label resolved by join, and is never itself a key.**

**Reasoning, and this is the part that settles it:** a callsign is **not unique over time**. There
are 26 NATO names and the live roster has 461 sessions — `oscar` alone has been 19 different
sessions. v1 already encodes this: `roster.callsigns[cs]` is an *array*, newest first, and
`liveUidOf` returns element 0 only if it has not ended. So a callsign identifies a session **only
when qualified by "currently live"**, which is a runtime predicate, not a key. Any FK built on
callsign is a bug with a delay on it: it resolves correctly until the callsign is recycled, and then
silently re-points historical rows at a stranger. `db.mjs` already carries this defect and documents
it — its `tasks` table links to a session by callsign alone, so "a reused callsign can straddle
successive sessions". v2 does not inherit that.

**Consequence for non-session actors.** Some `from` values are not sessions: `'human'` and `'you'`
(Chris), and `'jarvis'` (the hub itself). So the FK cannot point at `session` directly. An `actor`
table absorbs all three kinds and gives every message exactly one sender key.

**Consequence for the console.** Rendering by callsign is a *projection* concern, not a storage one.
`v_message` (part C) does the join, so the UI keeps the shape it has.

### A2. Ordering is an explicit column. Array index is never identity.

v1 stores four different meanings in an array position (§8). All four become data:

| v1 | v2 |
| --- | --- |
| `callsigns[cs][0]` = the current holder | `session.callsign` + a **filtered unique index** allowing one live session per callsign |
| `worklist.sessions[cs][lane][i]` = priority | `task.lane` + `task.position` |
| `mission.phases[i]` = the phase's identity | `mission_phase.phase_id` PK; `position` is ordinary data |
| `mission.docs[i]` / `project.context.docs[i]` | `mission_doc` / `project_doc`, each with a PK |

**Reasoning.** v1's `POST /mission op:phase` and `op:unphase` address a phase **by `index`**. That
means a concurrent insert renumbers somebody else's target between read and write — the classic
lost-update, and the reason "delete phase 3" is unsafe the moment two clients exist. A surrogate key
makes the operation addressable and idempotent; `position` then only has to answer "what order do I
render these in", which is a much weaker requirement.

**On `position` type.** Use `DECIMAL(18,9)`, not `INT`. Reordering with integers rewrites every row
after the insertion point; with a fractional rank you insert between `1.0` and `2.0` at `1.5` and
touch one row. v1's `op:top` is a whole-array `unshift` on every call — that is fine for 20 cards and
not fine as a table. Renormalize on a schedule, not per write.

### A3. The spoken ordinal is a VIEW, never a stored number.

v1's "work on item 3" resolves through `orderedTasks`, which concatenates lanes
**review → working → queued → done** and counts. Nothing stores a 3.

**Decision: keep it derived.** `v_task_ordinal` computes it. Do not add `task.ordinal`.

**Reasoning.** It is a function of (lane order, position, and which board you are looking at). Stored,
it becomes a fourth thing to keep in sync with the three that already determine it, and it is wrong
the instant a card moves lane. The voice path and the console must agree on it, and the only way to
guarantee that is one definition — a view both read.

### A4. One string carrying three fields becomes three columns, plus the original.

`task.text` in v1 carries, in one `NVARCHAR`:

1. a category tag — a leading `BUG:` / `SECURITY:` / `NOTE:` etc., parsed by `^[A-Z]{2,10}:` (`tagOf`)
2. a headline and a detail, split on the **first ` -- `** (`splitHeadline`)
3. the remaining human text

**Decision:** columns `tag`, `headline`, `detail` — **and keep `text_raw` verbatim**.

**Reasoning for keeping the raw string:** it is the migration's own safety net. The two parsers are
lossy in edge cases (a task whose body legitimately contains ` -- `, a tag-shaped prefix that is not a
tag), and a migration that only writes the parsed columns cannot be audited or re-run. With
`text_raw` retained, re-parsing is a `UPDATE ... FROM` rather than a restore. Drop the column later,
deliberately, once the parse has been checked against the real board — not as part of the migration.

### A5. A message's identity is a surrogate key, not its timestamp.

v1 has **no message ids**. `POST /react` targets a message **by its `ts`**, and the console keys pins
on `who|ts`.

**Decision:** `message.message_id BIGINT IDENTITY` PK. `ts` stays as ordinary data. `reaction` FKs to
`message_id`.

**Reasoning.** Timestamps collide — v1 stamps `new Date().toISOString()` at millisecond resolution
and appends in a tight loop, so two records sharing a millisecond is a question of load, not of
possibility. A reaction attached to a colliding `ts` today lands on whichever row the reader finds
first. It is also not a *stable* identity: nothing stops a re-import changing it.

### A6. The event cursor becomes a monotonic sequence, and the comparison becomes exclusive.

v1's cursor is an absolute index into a shared append-only array, with `busBase` tracking how many
were trimmed off the front so indices stay valid forever.

**Decision:** `event.seq BIGINT` from a **`SEQUENCE`**, not `IDENTITY`. Poll reads
`WHERE seq > @cursor` — **exclusive**, where v1's `?cursor=i` is **inclusive**.

**Reasoning, two parts.**

*Why a sequence, not IDENTITY:* the cursor's whole contract is monotonicity. `IDENTITY` is not
rollback-safe — a failed insert consumes a value and leaves a permanent gap. Gaps do not break
`seq > @cursor`, but they do break anything that treats the cursor as a **count** of events, and v1's
`busBase + bus.length` arithmetic is exactly that. A `SEQUENCE` makes the gap behaviour explicit and
configurable rather than an engine detail.

*Why flip to exclusive:* v1 is inclusive, which is why a `POST /send` receipt cursor (the index the
event **landed at**) can be handed straight back to `/poll` and re-read. But the cursor a poll
**returns** is one *past* its last event. So the same field name carries two different conventions
depending on which endpoint produced it — and per `docs/V2-CURRENT-SYSTEM.md` §3.2, mixing them up
has already destroyed a delegate's whole report. **One convention: a cursor is always "the last seq I
have seen", and reads are always `> cursor`.** A receipt then returns the landed `seq`, and
`cursor = seq - 1` re-reads it — one rule, no second meaning.

**Retention.** v1 trims the bus and the trimmed events are gone. Keep `event` whole and archive by
partition; the cursor never needs a `busBase` analogue because `seq` is already absolute.

---

## B. The DDL

SQL Server. `DATETIME2(3)` throughout (v1 timestamps are ISO-8601 with millisecond precision — do not
use `DATETIME`, whose 3.33 ms rounding would silently move them). All timestamps **UTC**; v1 writes
`toISOString()`, so this is a straight read. `NVARCHAR` throughout — the transcript contains emoji and
non-ASCII, so `VARCHAR` would mangle it.

### B1. Actors and sessions

```sql
CREATE TABLE actor (
    actor_id     INT IDENTITY(1,1) PRIMARY KEY,
    actor_kind   VARCHAR(10)  NOT NULL,           -- 'human' | 'hub' | 'session'
    session_id   INT          NULL,               -- set iff actor_kind='session'
    CONSTRAINT ck_actor_kind CHECK (actor_kind IN ('human','hub','session')),
    CONSTRAINT ck_actor_session CHECK (
        (actor_kind = 'session' AND session_id IS NOT NULL) OR
        (actor_kind <> 'session' AND session_id IS NULL))
);
-- Exactly one 'human' and one 'hub' row, seeded by the migration.
CREATE UNIQUE INDEX ux_actor_singleton ON actor(actor_kind)
    WHERE actor_kind IN ('human','hub');

CREATE TABLE session (
    session_id      INT IDENTITY(1,1) PRIMARY KEY,
    uid             VARCHAR(16)   NOT NULL UNIQUE,   -- v1 's_0461'; kept as the migration join key
    callsign        VARCHAR(16)   NOT NULL,          -- NATO label. NOT a key -- see A1
    cwd             NVARCHAR(400) NOT NULL,
    cwd_key         AS (LOWER(REPLACE(cwd, '\', '/'))) PERSISTED,   -- mirrors cwdKey()
    purpose         NVARCHAR(400) NOT NULL,
    registered_at   DATETIME2(3)  NOT NULL,
    ended_at        DATETIME2(3)  NULL,              -- NULL = live
    summary         NVARCHAR(MAX) NULL,              -- the epitaph
    -- binding: mutually exclusive by construction (registerSession enforces it)
    project_id      INT           NULL,              -- coordinator
    parent_project_id INT         NULL,              -- sub-worker
    -- health, from POST /health
    context_pct     TINYINT       NULL,
    context_at      DATETIME2(3)  NULL,
    context_warned  BIT           NOT NULL DEFAULT 0,
    doing           NVARCHAR(80)  NULL,              -- v1 truncates to 80
    -- liveness. lastPoll and lastBeat MUST stay separate -- that split IS the wedge detector
    last_seen       DATETIME2(3)  NULL,
    last_poll       DATETIME2(3)  NULL,
    last_beat       DATETIME2(3)  NULL,
    poll_cursor     BIGINT        NULL,
    -- isolation
    worktree_path   NVARCHAR(400) NULL,
    branch          NVARCHAR(200) NULL,
    base_branch     NVARCHAR(200) NULL,
    -- trust / launch
    tier            VARCHAR(10)   NOT NULL DEFAULT 'guarded',
    trust_until     DATETIME2(3)  NULL,
    launch          VARCHAR(4)    NULL,              -- 'pty' | 'wt'
    needs_you       BIT           NOT NULL DEFAULT 0,
    voice_muted     BIT           NOT NULL DEFAULT 0,
    handoff_notes   NVARCHAR(MAX) NULL,
    row_version     ROWVERSION,
    CONSTRAINT ck_session_tier    CHECK (tier IN ('trusted','guarded')),
    CONSTRAINT ck_session_launch  CHECK (launch IS NULL OR launch IN ('pty','wt')),
    CONSTRAINT ck_session_ctx     CHECK (context_pct IS NULL OR context_pct BETWEEN 0 AND 100),
    CONSTRAINT ck_session_binding CHECK (project_id IS NULL OR parent_project_id IS NULL),
    CONSTRAINT fk_session_project        FOREIGN KEY (project_id)        REFERENCES project(project_id),
    CONSTRAINT fk_session_parent_project FOREIGN KEY (parent_project_id) REFERENCES project(project_id)
);
ALTER TABLE actor ADD CONSTRAINT fk_actor_session
    FOREIGN KEY (session_id) REFERENCES session(session_id);

-- A1 + A2: at most ONE live session per callsign. This is the constraint that replaces
-- callsigns[cs][0], and it is the whole reason liveUidOf can stop being a lookup convention.
CREATE UNIQUE INDEX ux_session_live_callsign ON session(callsign) WHERE ended_at IS NULL;
CREATE INDEX ix_session_project ON session(project_id) WHERE ended_at IS NULL;
CREATE INDEX ix_session_cwdkey  ON session(cwd_key);
```

`autoAllow` (permission signatures answered "always") is a per-session set, so it is its own table
rather than a JSON column — it is queried by exact signature match on every permission check:

```sql
CREATE TABLE session_auto_allow (
    session_id  INT           NOT NULL,
    perm_sig    NVARCHAR(400) NOT NULL,
    granted_at  DATETIME2(3)  NOT NULL,
    CONSTRAINT pk_session_auto_allow PRIMARY KEY (session_id, perm_sig),
    CONSTRAINT fk_saa_session FOREIGN KEY (session_id) REFERENCES session(session_id)
);
```

### B2. Boards and tasks

```sql
-- A board column. v1 keys these by a STRING that is either a NATO callsign or a project name,
-- which is why a bound coordinator silently minted a second board before boardKey() existed.
-- Making the two cases explicit removes that whole class of bug.
CREATE TABLE board (
    board_id    INT IDENTITY(1,1) PRIMARY KEY,
    board_kind  VARCHAR(10) NOT NULL,             -- 'session' | 'project'
    session_id  INT NULL,
    project_id  INT NULL,
    CONSTRAINT ck_board_kind CHECK (board_kind IN ('session','project')),
    CONSTRAINT ck_board_target CHECK (
        (board_kind='session' AND session_id IS NOT NULL AND project_id IS NULL) OR
        (board_kind='project' AND project_id IS NOT NULL AND session_id IS NULL)),
    CONSTRAINT fk_board_session FOREIGN KEY (session_id) REFERENCES session(session_id),
    CONSTRAINT fk_board_project FOREIGN KEY (project_id) REFERENCES project(project_id)
);
CREATE UNIQUE INDEX ux_board_session ON board(session_id) WHERE session_id IS NOT NULL;
CREATE UNIQUE INDEX ux_board_project ON board(project_id) WHERE project_id IS NOT NULL;

CREATE TABLE task (
    task_id     BIGINT IDENTITY(1,1) PRIMARY KEY,
    ext_id      VARCHAR(32)    NULL UNIQUE,        -- v1 't_<base36>'; migration idempotency key
    board_id    INT            NOT NULL,
    lane        VARCHAR(10)    NOT NULL,           -- review|working|queued|done  (+ 'dropped', see below)
    position    DECIMAL(18,9)  NOT NULL,           -- A2: explicit order, fractional for cheap reorder
    -- A4: the parsed facets, plus the original
    text_raw    NVARCHAR(MAX)  NOT NULL,
    tag         VARCHAR(10)    NULL,               -- BUG | SECURITY | ROBUST | ... (no colon)
    headline    NVARCHAR(400)  NULL,
    detail      NVARCHAR(MAX)  NULL,
    notes       NVARCHAR(MAX)  NULL,
    -- lifecycle. LANE IS CURRENT TRUTH; these are HISTORY and may disagree -- see the note below
    added_at    DATETIME2(3)   NOT NULL,
    started_at  DATETIME2(3)   NULL,
    done_at     DATETIME2(3)   NULL,
    dropped_at  DATETIME2(3)   NULL,
    start_date  DATE           NULL,               -- v1 placeholders, never populated
    due_date    DATE           NULL,
    priority    INT            NULL,
    row_version ROWVERSION,
    CONSTRAINT ck_task_lane CHECK (lane IN ('review','working','queued','done','dropped')),
    CONSTRAINT fk_task_board FOREIGN KEY (board_id) REFERENCES board(board_id)
);
CREATE INDEX ix_task_board_lane ON task(board_id, lane, position);
CREATE INDEX ix_task_tag ON task(tag) WHERE tag IS NOT NULL;

CREATE TABLE task_subtask (
    subtask_id  BIGINT IDENTITY(1,1) PRIMARY KEY,
    task_id     BIGINT        NOT NULL,
    position    DECIMAL(18,9) NOT NULL,
    text        NVARCHAR(400) NOT NULL,
    done        BIT           NOT NULL DEFAULT 0,
    CONSTRAINT fk_subtask_task FOREIGN KEY (task_id) REFERENCES task(task_id) ON DELETE CASCADE
);
```

**Two v1 semantics that must survive into v2, or reports will lie.**

1. **`lane` is current truth; `started_at`/`done_at` are history, and they are allowed to disagree.**
   v1's `op:ready` pulls a finished card back to `queued` and does **not** clear `done_at`
   (`db.mjs` COALESCEs, so a written timestamp can never be cleared). That is deliberate — it *was*
   done at that moment. **"What is finished" therefore means `lane='done'`, never
   `done_at IS NOT NULL`.** Any v2 report must respect this or it over-counts throughput.
2. **`dropped` is a real lane here, where in v1 it exists only in the SQLite mirror.** v1's `op:drop`
   deletes the card from `worklist.json`, so abandoned work is invisible to any reconstruction. Making
   it a lane means a report can exclude it **knowingly** rather than never seeing it. Do not
   hard-delete tasks.

### B3. Projects and missions

```sql
CREATE TABLE project (
    project_id     INT IDENTITY(1,1) PRIMARY KEY,
    name           VARCHAR(64)   NOT NULL UNIQUE,   -- lowercase slug; v1's key
    title          NVARCHAR(200) NOT NULL,
    status         VARCHAR(10)   NOT NULL DEFAULT 'active',
    mission_id     INT           NULL,
    manager_session_id INT       NULL,              -- compare-and-set slot; see note
    summary        NVARCHAR(MAX) NULL,
    current_focus  NVARCHAR(MAX) NULL,
    created_at     DATETIME2(3)  NOT NULL,
    updated_at     DATETIME2(3)  NOT NULL,
    row_version    ROWVERSION,
    CONSTRAINT ck_project_status CHECK (status IN ('active','paused','archived'))
);

-- openThreads. v1 stores these as a bare string array, UNCAPPED at write, and truncates only when
-- embedding into a boot prompt -- the mechanism that bricked sub-worker dispatch outright.
CREATE TABLE project_thread (
    thread_id   BIGINT IDENTITY(1,1) PRIMARY KEY,
    project_id  INT           NOT NULL,
    position    DECIMAL(18,9) NOT NULL,
    body        NVARCHAR(MAX) NOT NULL,
    body_len    AS (LEN(body)) PERSISTED,           -- so the brief-budget query is an index seek
    created_at  DATETIME2(3)  NOT NULL,
    CONSTRAINT fk_pthread_project FOREIGN KEY (project_id) REFERENCES project(project_id)
);
CREATE INDEX ix_pthread_project ON project_thread(project_id, position);

CREATE TABLE project_log (
    log_id      BIGINT IDENTITY(1,1) PRIMARY KEY,
    project_id  INT           NOT NULL,
    ts          DATETIME2(3)  NOT NULL,
    from_label  NVARCHAR(64)  NULL,                 -- v1 stores a callsign string, often of a dead session
    from_actor_id INT         NULL,                 -- resolved where possible; see migration note M4
    note        NVARCHAR(MAX) NOT NULL,
    CONSTRAINT fk_plog_project FOREIGN KEY (project_id) REFERENCES project(project_id),
    CONSTRAINT fk_plog_actor   FOREIGN KEY (from_actor_id) REFERENCES actor(actor_id)
);
CREATE INDEX ix_plog_project_ts ON project_log(project_id, ts DESC);

CREATE TABLE mission (
    mission_id   INT IDENTITY(1,1) PRIMARY KEY,
    ext_id       VARCHAR(32)   NULL UNIQUE,         -- v1 'm_<base36>'
    title        NVARCHAR(300) NOT NULL,
    status       VARCHAR(10)   NOT NULL DEFAULT 'active',
    created_at   DATETIME2(3)  NOT NULL,
    archived_at  DATETIME2(3)  NULL,
    CONSTRAINT ck_mission_status CHECK (status IN ('active','archived'))
);
ALTER TABLE project ADD CONSTRAINT fk_project_mission
    FOREIGN KEY (mission_id) REFERENCES mission(mission_id);

-- A2: a phase is addressable by key, not by array index.
CREATE TABLE mission_phase (
    phase_id    INT IDENTITY(1,1) PRIMARY KEY,
    mission_id  INT           NOT NULL,
    position    DECIMAL(18,9) NOT NULL,
    text        NVARCHAR(400) NOT NULL,
    done        BIT           NOT NULL DEFAULT 0,
    done_at     DATETIME2(3)  NULL,
    CONSTRAINT fk_phase_mission FOREIGN KEY (mission_id) REFERENCES mission(mission_id)
);
CREATE INDEX ix_phase_mission ON mission_phase(mission_id, position);

-- Docs: separate tables per owner rather than a polymorphic owner_kind/owner_id pair, so the FK
-- is real. Two small tables beat one table with no referential integrity.
CREATE TABLE mission_doc (
    doc_id      INT IDENTITY(1,1) PRIMARY KEY,
    mission_id  INT           NOT NULL,
    position    DECIMAL(18,9) NOT NULL,
    label       NVARCHAR(300) NOT NULL,
    url         NVARCHAR(600) NOT NULL,
    CONSTRAINT fk_mdoc_mission FOREIGN KEY (mission_id) REFERENCES mission(mission_id)
);
CREATE TABLE project_doc (
    doc_id      INT IDENTITY(1,1) PRIMARY KEY,
    project_id  INT           NOT NULL,
    position    DECIMAL(18,9) NOT NULL,
    label       NVARCHAR(300) NOT NULL,
    url         NVARCHAR(600) NOT NULL,
    CONSTRAINT fk_pdoc_project FOREIGN KEY (project_id) REFERENCES project(project_id)
);
```

**`manager_session_id` must keep its compare-and-set semantics.** v1's `setProjectManager(name, uid,
expectUid)` writes only if the slot still holds `expectUid` — without it, retiring a ghost
coordinator nulls a *live* one's claim. In SQL that is
`UPDATE project SET manager_session_id=@new WHERE project_id=@p AND manager_session_id=@expect`,
checking `@@ROWCOUNT`. Do not replace it with a plain assignment.

### B4. Messages, events, reactions

```sql
-- The transcript. A5: surrogate PK, ts is data.
CREATE TABLE message (
    message_id   BIGINT IDENTITY(1,1) PRIMARY KEY,
    ts           DATETIME2(3) NOT NULL,
    kind         VARCHAR(12)  NOT NULL,   -- speech|chat|tts|msg|sys|task|react
    from_actor_id INT         NULL,       -- A1. NULL only for kinds with no sender (sys)
    to_actor_id   INT         NULL,       -- A1. NULL = addressed to nobody in particular
    mission_id   INT          NULL,       -- speech tagged to a mission thread
    body         NVARCHAR(MAX) NULL,
    img_url      NVARCHAR(600) NULL,
    CONSTRAINT ck_message_kind CHECK (kind IN ('speech','chat','tts','msg','sys','task','react')),
    CONSTRAINT fk_msg_from    FOREIGN KEY (from_actor_id) REFERENCES actor(actor_id),
    CONSTRAINT fk_msg_to      FOREIGN KEY (to_actor_id)   REFERENCES actor(actor_id),
    CONSTRAINT fk_msg_mission FOREIGN KEY (mission_id)    REFERENCES mission(mission_id)
);
CREATE INDEX ix_message_ts   ON message(ts DESC);
CREATE INDEX ix_message_kind ON message(kind, ts DESC);

-- kind='task' rows carry structured fields in v1 (op/board/task/from). Split them out rather than
-- reconstructing intent from prose -- db.mjs's backfill has to parse these today and it is the
-- fragile part of that module.
CREATE TABLE message_task_detail (
    message_id   BIGINT      NOT NULL PRIMARY KEY,
    op           VARCHAR(12) NOT NULL,
    board_id     INT         NULL,
    from_board_id INT        NULL,       -- only on a move
    task_text    NVARCHAR(MAX) NULL,
    CONSTRAINT fk_mtd_message FOREIGN KEY (message_id) REFERENCES message(message_id)
);

CREATE TABLE reaction (
    reaction_id  BIGINT IDENTITY(1,1) PRIMARY KEY,
    message_id   BIGINT       NOT NULL,   -- A5: a real FK, not a ts match
    actor_id     INT          NOT NULL,
    reaction     VARCHAR(10)  NOT NULL,
    created_at   DATETIME2(3) NOT NULL,
    CONSTRAINT ck_reaction CHECK (reaction IN ('up','love','squee','fire','down','poop')),
    CONSTRAINT fk_reaction_message FOREIGN KEY (message_id) REFERENCES message(message_id),
    CONSTRAINT fk_reaction_actor   FOREIGN KEY (actor_id)   REFERENCES actor(actor_id)
);
CREATE UNIQUE INDEX ux_reaction_once ON reaction(message_id, actor_id, reaction);

-- The event bus. A6: seq from a SEQUENCE, reads are seq > cursor.
CREATE SEQUENCE seq_event AS BIGINT START WITH 1 INCREMENT BY 1;
CREATE TABLE event (
    seq           BIGINT       NOT NULL PRIMARY KEY
                  DEFAULT (NEXT VALUE FOR seq_event),
    ts            DATETIME2(3) NOT NULL,
    kind          VARCHAR(16)  NOT NULL,
    from_actor_id INT          NULL,     -- optional in v1: a live msg event has no `from`
    to_actor_id   INT          NOT NULL, -- every v1 event is addressed to exactly one session
    body          NVARCHAR(MAX) NULL,
    CONSTRAINT ck_event_kind CHECK (kind IN
        ('speech','msg','screenshot','baton','retire-request','retired')),
    CONSTRAINT fk_event_from FOREIGN KEY (from_actor_id) REFERENCES actor(actor_id),
    CONSTRAINT fk_event_to   FOREIGN KEY (to_actor_id)   REFERENCES actor(actor_id)
);
CREATE INDEX ix_event_to_seq ON event(to_actor_id, seq);
```

**The `event.kind` CHECK list is exactly six, and that is a finding, not an omission.** `sys` is a
*transcript* kind and never reaches the bus; `gap` is synthesized onto the poll response and never
stored at all (`docs/V2-CURRENT-SYSTEM.md` §3.3-3.4). If v2 wants `gap` to be durable and
re-readable — which would be an improvement — that is a **new** behaviour and needs its own decision,
not a quiet extra CHECK value.

**`to_actor_id` is `NOT NULL` deliberately.** v1's read paths also accept `to === 'all'`, but *nothing
writes it* — it is a dead broadcast capability. Modelling it now would be building a feature nobody
requested off a vestige. If broadcast is wanted, it is `event_recipient` as a child table, decided
on purpose.

### B5. Merge lanes, handoffs, holds, repos

```sql
CREATE TABLE repo (
    repo_id         INT IDENTITY(1,1) PRIMARY KEY,
    repo_key        VARCHAR(64)   NOT NULL UNIQUE,
    cwd             NVARCHAR(400) NOT NULL,
    cwd_key         AS (LOWER(REPLACE(cwd, '\', '/'))) PERSISTED,
    default_purpose NVARCHAR(400) NULL,
    tier            VARCHAR(10)   NULL,
    model           VARCHAR(40)   NULL,
    permission_mode VARCHAR(40)   NULL,
    isolate         BIT           NULL
);
CREATE UNIQUE INDEX ux_repo_cwdkey ON repo(cwd_key);

CREATE TABLE merge_lane (
    lane_id        INT IDENTITY(1,1) PRIMARY KEY,
    repo_id        INT           NOT NULL UNIQUE,
    base_branch    NVARCHAR(200) NULL,
    holder_session_id INT        NULL,
    holder_branch  NVARCHAR(200) NULL,
    holder_note    NVARCHAR(400) NULL,
    taken_at       DATETIME2(3)  NULL,
    last_handoff   DATETIME2(3)  NULL,
    row_version    ROWVERSION,
    CONSTRAINT fk_lane_repo   FOREIGN KEY (repo_id) REFERENCES repo(repo_id),
    CONSTRAINT fk_lane_holder FOREIGN KEY (holder_session_id) REFERENCES session(session_id)
);

CREATE TABLE merge_lane_queue (
    entry_id    BIGINT IDENTITY(1,1) PRIMARY KEY,
    lane_id     INT           NOT NULL,
    session_id  INT           NOT NULL,
    position    DECIMAL(18,9) NOT NULL,
    branch      NVARCHAR(200) NULL,
    note        NVARCHAR(400) NULL,
    queued_at   DATETIME2(3)  NOT NULL,
    CONSTRAINT fk_lq_lane    FOREIGN KEY (lane_id)    REFERENCES merge_lane(lane_id),
    CONSTRAINT fk_lq_session FOREIGN KEY (session_id) REFERENCES session(session_id)
);
CREATE UNIQUE INDEX ux_lq_once ON merge_lane_queue(lane_id, session_id);

-- Handoffs. v1 keys these by cwdKey + "\n" + normalized purpose, because one directory hosts many
-- unrelated jobs and a cwd-only key let whoever retired last overwrite the slot.
CREATE TABLE handoff (
    handoff_id    BIGINT IDENTITY(1,1) PRIMARY KEY,
    cwd_key       NVARCHAR(400) NOT NULL,
    purpose_norm  NVARCHAR(400) NOT NULL,     -- lowercased, trimmed, whitespace-collapsed
    from_session_id INT         NULL,
    summary       NVARCHAR(MAX) NULL,
    notes         NVARCHAR(MAX) NULL,         -- what the predecessor WROTE. May be empty.
    auto_block    NVARCHAR(MAX) NULL,         -- what the hub OBSERVED. See note.
    board_snapshot NVARCHAR(MAX) NULL,        -- JSON; see migration note M5
    created_at    DATETIME2(3)  NOT NULL,
    CONSTRAINT fk_handoff_session FOREIGN KEY (from_session_id) REFERENCES session(session_id)
);
CREATE UNIQUE INDEX ux_handoff_job ON handoff(cwd_key, purpose_norm);

CREATE TABLE hold (
    hold_id     INT IDENTITY(1,1) PRIMARY KEY,
    hold_key    NVARCHAR(400) NOT NULL UNIQUE,
    callsign    VARCHAR(16)   NULL,
    cwd         NVARCHAR(400) NULL,
    purpose     NVARCHAR(400) NULL,
    summary     NVARCHAR(MAX) NULL,
    parked_at   DATETIME2(3)  NOT NULL
);
```

**Keep `notes` and `auto_block` as separate columns. Do not concatenate them.** They are different
kinds of thing — one is a predecessor's judgement, the other is reconstructed fact — and
`reconstructHandoff` states which it is on its own first line precisely so a model reading it cannot
confuse them. Merging the columns destroys that distinction silently.

### B6. Schedule, reminders, AI tab, misc

```sql
CREATE TABLE calendar_day (
    day_date     DATE         NOT NULL PRIMARY KEY,
    loaded_at    DATETIME2(3) NOT NULL,
    nudged_for   DATE         NULL
);

CREATE TABLE calendar_event (
    event_id   INT IDENTITY(1,1) PRIMARY KEY,
    day_date   DATE          NOT NULL,
    title      NVARCHAR(300) NOT NULL,
    starts_at  DATETIME2(3)  NOT NULL,
    ends_at    DATETIME2(3)  NOT NULL,
    link       NVARCHAR(600) NULL,
    join_url   NVARCHAR(600) NULL,
    join_kind  VARCHAR(20)   NULL,
    CONSTRAINT fk_calevt_day FOREIGN KEY (day_date) REFERENCES calendar_day(day_date)
);

-- v1's `announced` is a map keyed by TITLE + ':5'/':0'/':end'. That is a latent bug: two
-- same-titled meetings share one key, and renaming a meeting re-announces it. FK + enum fixes both.
CREATE TABLE calendar_announcement (
    event_id   INT         NOT NULL,
    milestone  VARCHAR(4)  NOT NULL,      -- 'T5' | 'T0' | 'end'
    fired_at   DATETIME2(3) NOT NULL,
    CONSTRAINT pk_calann PRIMARY KEY (event_id, milestone),
    CONSTRAINT ck_calann CHECK (milestone IN ('T5','T0','end')),
    CONSTRAINT fk_calann_event FOREIGN KEY (event_id) REFERENCES calendar_event(event_id)
);

CREATE TABLE reminder (
    reminder_id INT IDENTITY(1,1) PRIMARY KEY,
    ext_id      VARCHAR(32)   NULL UNIQUE,
    title       NVARCHAR(300) NOT NULL,
    starts_at   DATETIME2(3)  NOT NULL,
    fired_at    DATETIME2(3)  NULL
);

CREATE TABLE ai_thread (
    thread_id   INT IDENTITY(1,1) PRIMARY KEY,
    ext_id      VARCHAR(32)   NULL UNIQUE,
    title       NVARCHAR(300) NULL,
    model       VARCHAR(60)   NOT NULL,
    created_at  DATETIME2(3)  NOT NULL
);
CREATE TABLE ai_message (
    ai_message_id BIGINT IDENTITY(1,1) PRIMARY KEY,
    thread_id   INT           NOT NULL,
    position    DECIMAL(18,9) NOT NULL,
    role        VARCHAR(12)   NOT NULL,
    content     NVARCHAR(MAX) NOT NULL,
    model       VARCHAR(60)   NULL,
    ts          DATETIME2(3)  NOT NULL,
    CONSTRAINT ck_ai_role CHECK (role IN ('user','assistant')),
    CONSTRAINT fk_aimsg_thread FOREIGN KEY (thread_id) REFERENCES ai_thread(thread_id)
);
CREATE TABLE ai_spend (
    month_key  CHAR(7)        NOT NULL PRIMARY KEY,   -- 'YYYY-MM'
    usd        DECIMAL(12,6)  NOT NULL DEFAULT 0
);

-- v1's single global `focus` string, plus the other hub-wide flags that live in module scope.
CREATE TABLE hub_state (
    lock_col     CHAR(1)      NOT NULL PRIMARY KEY DEFAULT 'X',
    focus_board_id INT        NULL,
    muted        BIT          NOT NULL DEFAULT 0,
    paused       BIT          NOT NULL DEFAULT 0,
    stt_backend  VARCHAR(10)  NOT NULL DEFAULT 'google',
    away_until   DATETIME2(3) NULL,
    notify_url   NVARCHAR(600) NULL,
    CONSTRAINT ck_hub_singleton CHECK (lock_col = 'X'),
    CONSTRAINT fk_hub_focus FOREIGN KEY (focus_board_id) REFERENCES board(board_id)
);
```

---

## C. Views the application reads

Two of these exist so that a rule has exactly one definition.

```sql
-- A3: the spoken ordinal. review -> working -> queued -> done, then position.
CREATE VIEW v_task_ordinal AS
SELECT t.task_id, t.board_id,
       ROW_NUMBER() OVER (PARTITION BY t.board_id
                          ORDER BY CASE t.lane WHEN 'review'  THEN 1
                                               WHEN 'working' THEN 2
                                               WHEN 'queued'  THEN 3
                                               WHEN 'done'    THEN 4 END,
                                   t.position) AS ordinal
FROM task t
WHERE t.lane <> 'dropped';

-- A1: messages with callsigns resolved for display. The console renders from THIS, so no caller
-- ever has to know that `to` was a uid in one place and a callsign in another.
CREATE VIEW v_message AS
SELECT m.message_id, m.ts, m.kind, m.body, m.img_url, m.mission_id,
       fa.actor_kind AS from_kind, fs.callsign AS from_callsign,
       ta.actor_kind AS to_kind,   ts2.callsign AS to_callsign
FROM message m
LEFT JOIN actor fa   ON fa.actor_id = m.from_actor_id
LEFT JOIN session fs ON fs.session_id = fa.session_id
LEFT JOIN actor ta   ON ta.actor_id = m.to_actor_id
LEFT JOIN session ts2 ON ts2.session_id = ta.session_id;
```

---

## D. Open decisions — Chris's or the coordinator's, not mine

Carded rather than assumed.

1. **Back-end language (Node vs .NET).** Chris's call, and the schema does not depend on it. The
   *access layer* does: `node:sqlite` has no SQL Server driver, so a Node v2 needs `mssql`/Tedious,
   while .NET gets EF Core or Dapper. **This does not fork the DDL.**
2. **Does `event` keep everything forever?** v1 trims the bus and loses the trimmed events. Keeping
   all of it is my recommendation (the cursor is absolute either way), but retention is an operational
   call and affects partitioning.
3. **Does `gap` become a durable event?** Today it is synthesized and unrecoverable. Making it real
   would be a genuine improvement and is a **behaviour change**, so it needs an explicit yes.
4. **Broadcast (`to:'all'`).** Dead in v1. Build it or drop it — do not carry the vestige.
5. **When does `task.text_raw` get dropped?** After the parse is audited against the live board
   (A4) — someone has to own that check.
6. **Does the reporting store (`db.mjs`, `jarvis.db`) survive?** This schema supersedes it entirely.
   My read is that it should be retired rather than migrated, but it has a CLI with users.

---

## E. Migration notes

**Notes only. No migration code in this document, by instruction and by judgement** — several steps
below depend on part D, and code written ahead of those decisions has to be unpicked.

- **M1 — order matters.** `actor` (seed `human` + `hub`) → `project` → `mission` → `session` →
  `board` → everything else. `session` and `project` are mutually referential, so create the FK on
  `session.project_id` after both tables exist, as the DDL above does.
- **M2 — `uid` and `ext_id` are the idempotency keys.** Every table carrying a v1 identifier keeps it
  UNIQUE. That is what makes the migration **re-runnable** — an `IF NOT EXISTS`/`MERGE` on those
  columns means a half-finished run can be resumed rather than restored. Do not drop these columns in
  the same change that adds them.
- **M3 — 461 sessions, 26 callsigns.** The filtered unique index `ux_session_live_callsign` will
  **fail** on import if the source has two live sessions sharing a callsign. That should be
  impossible (`assignCallsign` prevents it) but a crash-interrupted roster could contain it. Check
  before creating the index, and treat a violation as data to inspect, not to auto-resolve.
- **M4 — `project_log.from_label` often names a dead session by callsign.** Resolving it to
  `from_actor_id` requires picking *which* `oscar`. Match on the log entry's `ts` falling inside a
  session's `[registered_at, ended_at]` window; where that is ambiguous or empty, **leave
  `from_actor_id` NULL and keep the label**. A wrong attribution is worse than a missing one.
- **M5 — `handoff.board_snapshot` stays JSON.** It is a point-in-time copy of a board that no longer
  exists, referenced by nothing. Normalizing it would create task rows for cards that were already
  migrated from the live board — duplicates that then need distinguishing. Keep the blob.
- **M6 — the transcript is the big one.** ~6000 live rows plus ~2000 archived, and the archive is
  append-only history that `GET /search` already reads. Migrate both into `message`, ordered by `ts`,
  and expect `from`/`to` resolution to be the slow part (see M4 — same problem, far more rows).
- **M7 — `announced` needs its key rebuilt.** The v1 map is keyed by title string; resolving each to
  an `event_id` requires matching on (day, title). Same-titled meetings on one day are genuinely
  ambiguous — that is the v1 bug, and migration is where it surfaces. Log them rather than guessing.
- **M8 — do NOT migrate the repo-directory `repos.json`.** It is an untracked, weeks-stale leftover
  that the hub does not read (`docs/V2-CURRENT-SYSTEM.md` §6.0). The live file is the one in
  `JARVIS_DATA`. It has already fooled people; delete it rather than importing it.
- **M9 — timestamps are ISO-8601 UTC strings.** Straight `CAST` to `DATETIME2(3)`. Two v1 fields are
  **not** ISO and need converting: `trust_until` and `away_until` are epoch milliseconds, and
  `calendar_day.day_date` is a `Date.toDateString()` string like `"Thu Jul 30 2026"`.
- **M10 — validate against the live counts before switching over.** Measured 2026-07-30/31: 461
  sessions, 106 handoff records (7 with an `auto` block, 6 on legacy cwd-only keys), 5 projects,
  3 missions, 6 board columns, 2 merge lanes, 3 repos, 3 AI threads, 456 archive epitaphs,
  ~7031 total bus events (5029 retained), ~5960 transcript rows + ~2002 archived.
