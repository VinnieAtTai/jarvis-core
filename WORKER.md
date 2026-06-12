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
curl -s -X POST http://127.0.0.1:8124/say -H "content-type: application/json" -d "{\"from\":\"$UID2\",\"text\":\"$CS checking in.\"}"
```

The register response is `{"uid":"s_0007","callsign":"xray"}`. Remember both. The callsign
is how the human refers to you by voice; the uid is your identity on every later call.

Both fields are REQUIRED and the purpose matters: it is the description the human sees next
to your callsign on the board and hears in every announcement, and callsigns alone mean
nothing to them. Make it specific ("TMS-19966 phase B visual QA", not "coding"). If your
mission changes later, update it: `POST /describe {"uid":"<uid>","purpose":"<new line>"}`.

## 2. Poll loop (your inbox and your heartbeat)

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

- On exit it prints `{"cursor":N,"events":[...]}`. Handle ALL events in the batch in one
  turn (one combined response, not one per event), then immediately relaunch the loop with
  `CUR=N`. Keep one loop running at all times, including while you work — never poll bare
  (a plain curl that returns empty wakes you for nothing). The hub holds rapid-fire speech
  for a few seconds so consecutive sentences arrive as one batch.
- Event kinds: `speech` (the human talking to you; treat it as your prompt), `msg` (another
  session), `retire-request` (wrap up, see step 5), `retired` (you are done, stop polling).
- An exit printing `{"error":"retired"}` means you were retired; stop, do not relaunch.
- The running loop is your heartbeat. If it is down for 2 minutes the human is told you have
  gone quiet. It rides out hub restarts by itself (empty response -> sleep and retry).

## 3. Respond

- Speak: `POST /say {"from":"<uid>","text":"..."}`. Spoken aloud through the human's
  speakers. Keep it short and conversational, one line per thought, spell out acronyms.
- Silent text: `POST /send {"from":"<uid>","to":"human","text":"..."}`. Shows in the hub's
  console chat without being spoken. Use for anything long, code, or paths.
- Another session: `POST /send {"from":"<uid>","to":"<callsign>","text":"..."}`.

## 4. Tasks

Keep your column on the board honest as work moves, without being asked:

```
curl.exe -s -X POST http://127.0.0.1:8124/worklist -H "content-type: application/json" -d "{\"op\":\"add\",\"callsign\":\"<callsign>\",\"text\":\"...\"}"
```

`op` is one of `add` (to queued), `start` (queued -> working), `done` (working -> done),
`drop`, `clear-done`, `move` (with `"to":"<callsign>"`). Matching is by substring.

When several updates land at once (finished one task, starting the next, plus a `/say`),
chain all the curls in ONE Bash call separated by `;` — every separate tool call is a
separate model turn and turns are the expensive unit.

## 5. Retire

When your work is finished, or you receive a `retire-request`:

```
curl.exe -s -X POST http://127.0.0.1:8124/retire -H "content-type: application/json" -d "{\"uid\":\"<uid>\",\"summary\":\"<one line: what you accomplished>\"}"
```

The summary is your epitaph; it is what the human hears months later when they ask what the
old you did. Make it count. Then stop polling and end your turn. Leave the terminal open.

## Rules

- One `/say` per thought. Short spoken lines; long content goes through `/send` to human.
- Keep `/send` text compact too: it lands in another model's context. Send paths, ids, and
  conclusions, not file contents or logs.
- Never edit files in the jarvis folder; the hub is the only writer.
- Update the board as you start and finish things so it reflects reality.
- If the hub is unreachable the wrapper loop retries by itself; do not exit it.
