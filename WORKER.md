# JARVIS worker protocol

You are a worker session attached to the JARVIS voice hub at `http://127.0.0.1:8124`.
A human talks to the hub by voice; the hub routes their words to you over HTTP. You never
touch the hub's files directly. Everything below uses `curl.exe` (works in PowerShell).

## 1. Register and greet (one Bash call)

```
R=$(curl -s -X POST http://127.0.0.1:8124/register -H "content-type: application/json" -d '{"cwd":"<your working directory>","purpose":"<one short line, speakable>"}')
echo "$R"
UID2="${R#*\"uid\":\"}"; UID2="${UID2%%\"*}"
CS="${R#*\"callsign\":\"}"; CS="${CS%%\"*}"
case "$R" in *'"uid"'*) curl -s -X POST http://127.0.0.1:8124/say -H "content-type: application/json" -d "{\"from\":\"$UID2\",\"text\":\"$CS checking in.\"}";; *) echo "REGISTER FAILED, not greeting: $R";; esac
```

The register response is `{"uid":"s_0007","callsign":"xray"}`. Remember both. The callsign
is how the human refers to you by voice; the uid is your identity on every later call.

If the response also carries a `handoff` field, a predecessor on your cwd left you one:
`GET /handoff?cwd=<your cwd>` to read its summary + detailed notes, tell the human in one
chat line that you've picked up the handoff, then resume that work (see §5).

If your boot instructions name a pin (e.g. "Register with pin: golf"), include
`"pin":"golf"` in the register body — your terminal tab is already titled with that
callsign, so claiming it keeps the tab and the board in sync.

Both fields are REQUIRED and the purpose matters: it is the description the human sees next
to your callsign on the board and hears in every announcement, and callsigns alone mean
nothing to them. Make it specific ("TMS-19966 phase B visual QA", not "coding"). If your
mission changes later, update it: `POST /describe {"uid":"<uid>","purpose":"<new line>"}`.

## 2. Poll loop (your inbox) + heartbeat ping (your liveness)

Run this wrapper loop as a single background Bash task, substituting your uid (CUR starts
at 0). It silently re-polls while nothing is happening and exits only when there is
something for you — an idle session never wakes and costs no tokens:

```
CUR=0
while :; do
  R=$(curl -s --max-time 60 "http://127.0.0.1:8124/poll?uid=<uid>&cursor=$CUR")
  if [ -z "$R" ]; then sleep 5; continue; fi
  case "$R" in
    *'"events":[]'*) CUR="${R#*\"cursor\":}"; CUR="${CUR%%,*}";;
    *) printf '%s\n' "$R"; exit 0;;
  esac
done
```

**Also launch a heartbeat ping** as a SECOND perpetual background Bash task, once, right after
you register. Unlike the poll loop it never exits, so it keeps your liveness fresh through a
long agent turn that never reaches a relaunch boundary:

```
while :; do curl -s "http://127.0.0.1:8124/heartbeat?uid=<uid>" >/dev/null; sleep 30; done
```

`/heartbeat` only refreshes your `lastSeen` — no events, never blocks, costs zero model tokens.
Without it, a single long turn (a big workflow / deep think) leaves the poll loop un-relaunched,
`lastSeen` goes stale, and at 2 minutes the hub marks you gone-quiet and pulls focus away — comms
dead for the whole turn. The ping prevents that; the poll loop stays your inbox.

- On exit the poll loop prints `{"cursor":N,"events":[...]}`. Relaunch the loop with `CUR=N`
  FIRST, then handle the events — if you handle first and the work runs long, your inbox is
  down the whole time and the human cannot reach you to redirect or stop you.
  Handle ALL events in the batch in one turn (one combined response, not one per event).
  Never poll bare (a plain curl that returns empty wakes you for nothing). The hub holds
  rapid-fire speech for a few seconds so consecutive sentences arrive as one batch.
- Event kinds: `speech` (the human talking to you; treat it as your prompt), `screenshot`
  (text is the path to a screen capture the hub took the INSTANT the human said take a
  screenshot — Read it as an image; it usually arrives in the same batch as the speech that
  asked for it, and your analysis should refer to that exact moment), `msg` (another
  session), `retire-request` (wrap up, see step 5), `retired` (you are done, stop polling).
- An exit printing `{"error":"retired"}` means you were retired; stop, do not relaunch.
- The heartbeat PING (not this loop) is what keeps you live — so even a long turn stays green.
  If your `lastSeen` is stale for 2 minutes the human is told you have gone quiet. Both the
  ping and the loop ride out hub restarts by themselves (empty/failed response -> sleep, retry).

## 3. Respond — text first, voice for headlines only

- Default channel: `POST /send {"from":"<uid>","to":"human","text":"..."}` — silent text in
  the console chat. The human reads much faster than they can listen; findings, options,
  status, code, paths, anything longer than one sentence goes here.
- Speak ONLY headlines: `POST /say {"from":"<uid>","text":"..."}` — one short, super high
  level sentence ("Build is green." / "Found the timeout cause, details in chat."). Never
  read details, lists, or numbers aloud.
- When you genuinely need the human, lead the spoken line with "Need you:" and a few words
  of why ("Need you: pick between two formats, options in chat."). Reserve it for real
  decisions and blockers — it is the interrupt channel, do not dilute it.
- Another session: `POST /send {"from":"<uid>","to":"<callsign>","text":"..."}`.
- Screenshots: when the human says take a screenshot, the HUB captures instantly and you
  receive the path as a `screenshot` event — you do not need to do anything to get it. For a
  FOLLOW-UP capture (e.g. the other monitor), `GET /screen?uid=<uid>` returns
  `{"path":"<png>"}` (`&all=1` for every monitor) — but it is HARD-GATED by voice: only works
  within two minutes of the human's ask, one capture per ask. A 403 means they have not
  asked — never retry it; ask them to say take a screenshot if you need to see something.

## 4. Tasks

Keep your column on the board honest as work moves, without being asked:

```
curl.exe -s -X POST http://127.0.0.1:8124/worklist -H "content-type: application/json" -d "{\"op\":\"add\",\"callsign\":\"<callsign>\",\"text\":\"...\"}"
```

`op` is one of `add` (to queued), `start` (queued -> working), `done` (working -> done),
`drop`, `clear-done`, `move` (with `"to":"<callsign>"`). Matching is by substring.

**Prefix task text with a category tag** so the board renders a colored chip (Chris likes the
context-at-a-glance): start the text with one of `BUG: SECURITY: ROBUST: FEATURE: REVIEW:
WORK: FS: MAINT: POLISH: NOTE:` (e.g. `"text":"BUG: copy button denied"`). The tag is shown
as a 3-letter chip with a hover tooltip and stripped from the visible line; untagged tasks
just render plain.

When several updates land at once (finished one task, starting the next, plus a `/say`),
chain all the curls in ONE Bash call separated by `;` — every separate tool call is a
separate model turn and turns are the expensive unit.

## 5. Retire & hand off

When your work is finished, or you receive a `retire-request`:

```
curl.exe -s -X POST http://127.0.0.1:8124/retire -H "content-type: application/json" -d "{\"uid\":\"<uid>\",\"summary\":\"<one line: what you accomplished>\",\"notes\":\"<detailed handoff>\"}"
```

The `summary` is your epitaph — what the human hears months later when they ask what the old
you did; make it count. The `notes` are your detailed handoff (state, gotchas, what's left,
where you were mid-thought). Then stop polling and end your turn. Leave the terminal open.

**Auto-successor.** If your board still has working/queued tasks when you retire, the hub
spawns a SUCCESSOR on the same job, hands it your summary + notes + your unfinished board,
and moves focus to it — so work continues with no human re-brief. Add `"successor":false`
to retire cleanly with no replacement (job truly done), or `"successor":true` to force one.

**Hand off before you degrade.** When your context passes ~85% (or you were just compacted),
don't soldier on — POST a rich `/handoff {"uid":"<uid>","notes":"..."}` checkpoint (callable
anytime, latest wins), then `/retire` with `successor:true`. A fresh session picks up exactly
where you left off.

**If you ARE the successor** (your boot prompt said so): the moment you register, `GET
/handoff?cs=<your-callsign>` to read your predecessor's summary + notes, tell the human in
one chat line that you've picked up the handoff, then resume. Your board already holds the
unfinished items.

## Rules

- One `/say` per thought. Short spoken lines; long content goes through `/send` to human.
- Keep `/send` text compact too: it lands in another model's context. Send paths, ids, and
  conclusions, not file contents or logs.
- Report context health AND what you are doing: chain
  `POST /health {"uid":"<uid>","context":<0-100>,"doing":"<short phrase>"}` into a bash call
  you are already making (after handling a batch, alongside board updates). `context` is your
  best estimate of how full your context window is — the board shows it and the hub warns the
  human at 80 so a fresh session can take over before you degrade; report high (85+) if you
  were recently summarized or compacted. `doing` is one short phrase of your current state —
  "working: F19 verify", "waiting on Chris for query results", "standing by" — it renders
  under your callsign so the human can tell waiting from working at a glance. Update it
  whenever your state changes, especially when you become blocked on the human.
- **Permissions / self-sufficiency.** Read-only and routine build commands run WITHOUT bothering
  the human: git status/diff/log/show/branch, ls/cat/grep/rg/find, node --check, npm run
  lint/build/test, dotnet build/test. Only risky or out-of-repo actions raise a prompt. So favor
  those pre-approved commands, batch shell calls (chain with `;`), and self-verify by running the
  lint gate yourself instead of asking. Never ask the human to run something you can run.
- **Risky actions still prompt** (rm/del, git push/reset --hard/commit, npm install, killing
  processes, writing outside your cwd). That is intentional: surface them clearly and keep working
  on everything else while they wait.
- **Subagents inherit the same gate.** If you fan out Agent-tool subagents, keep them to the safe
  command set so they do not each stack up permission prompts; do anything risky yourself.
- Never edit files in the jarvis folder; the hub is the only writer.
- Update the board as you start and finish things so it reflects reality.
- If the hub is unreachable the wrapper loop retries by itself; do not exit it.
