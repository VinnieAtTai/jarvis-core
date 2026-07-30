# JARVIS project threads (durable archive)

Every open thread the jarvis project store has accumulated, verbatim, newest-known-first as the
store held them on 2026-07-30. This file exists because the store itself is not a safe place to
keep 30KB of prose: subworkerBrief() embeds openThreads VERBATIM into every sub-worker boot
prompt, that prompt is re-parsed as a Windows command line, and CreateProcess caps a command line
at 32767 chars. At 46 threads the brief reached 31822 and sub-worker dispatch bricked outright --
spawns died before registering, with an empty log and nothing to read. Two sessions were lost to it.

So the store now carries a CURATED WORKING SET and points here for the rest. Add a lesson to the
store when it changes how the next session should act; move it down here once it is history. Keep
the live set small enough that the brief stays a few thousand chars, not tens of thousands.

Nothing below is summarized. If a thread reads oddly, it is because it was written by the session
that got burned, minutes after being burned, which is exactly why it is worth keeping.

## 1. READ THE BRANCH COMMIT BODY BEFORE YOU WRITE A MERGE COMMIT ABOUT IT - oscar got this wron

READ THE BRANCH COMMIT BODY BEFORE YOU WRITE A MERGE COMMIT ABOUT IT - oscar got this wrong on the live repo 2026-07-30 and it is now permanent in history. I merged jarvis/whiskey as 75795be and wrote in the merge commit that whiskey had supplied NO mutation-probe report and that its assertions were gated but unproven, because it went deaf before reporting to me. 176379b commit body says, verbatim, Probes 14/14 killed, up from 10/11. I had read the DIFF and gated the tree and never opened the commit message. Caught by uniform (whiskeys successor) reporting its own independent 6/6 and noting the board and the commit body disagreed. NOT rewriting pushed history over it; the correction lives here. TWO LESSONS. (1) A retired author CAN still have reported - the commit body is a report channel, and for a session that died before it could speak it is the ONLY one. Read it. (2) THE SAME COMMIT BODY ALSO CONTAINED WORK I HAD JUST DISPATCHED A WORKER TO RE-DERIVE: whiskey had already found, named AND fixed the rig trap where a test registering with the hub own cwd gets bused the stale-schedule nudge and releases a parked waiter - it fixed its own probe sessions to register in the scratch repo dir. I briefed first whiskey and then uniform to write that up from scratch. Redirected uniform to the narrower live question (who ELSE is exposed, and whether the fix belongs in test-support/scratch-hub.mjs rather than per-test) before it burned the pass. The general form: before briefing a delegate on work a retired session touched, read that session commits - not just its handoff, its board card, and what a predecessor told you.

## 2. TWO FAULTS

TWO FAULTS, ONE SYMPTOM - and the refinement matters more than either fix, 2026-07-30. Chris screenshotted his console and shouted BRICK OF TEXT USE RICH TEXT MAKE NOT SO THIS. WIRE FAULT (oscar, controlled A/B/C through curl.exe, read back off the bus): a literal BACKSLASH anywhere in a /send body destroys every line break in that message - plain body gave 2 real newlines, a body containing d:/claude/x written with backslashes gave ZERO real newlines and 2 literal backslash-n, an escaped quote gave 2 real newlines. Invisible to the sender. RENDER FAULT (bravo): fixEscapedBreaks was handed the JOINED bubble at console.js chatBubble, not one message, so its has-real-newlines guard bailed and the repair switched itself off for any message with a NEIGHBOUR - which is why only 2 of 14 messages bricked. Fixed by repairing before joining. THEN SIERRA CORRECTED BOTH OF US, and this is the durable part: bravo said my message survived by LUCK OF SPELLING (backslash-c, -dot, -o are not touched); sierra proved it survived by LUCK OF SHAPE - it HAD real line breaks so the guard bailed. Therefore the corrupting case is a SHORT ONE-LINE message naming a Windows path, which is precisely what Chris had just asked us all to write. The fix for verbosity increased exposure to the bug, and nobody would have seen that without a third pair of eyes. Sierra also scanned all 2321 live board strings: exactly ONE literal-escape hit (boards[0].cwd, a backslash-t) and it renders only through esc/escAttr/b64, never richText - so the hazard is live on CHAT and the ASK tab only and is NOT a board defect. Following a count to its render path instead of stopping at the count is what made that distinction. SENDER-SIDE RULE: build /send bodies with JSON.stringify in-process (see a manager scratchpad send.js), never a hand-written curl -d body. Each session was right about what it MEASURED and wrong about SCOPE - three times in one thread.

## 3. A /send RECEIPT cursor is a BUS INDEX

A /send RECEIPT cursor is a BUS INDEX, not a poll cursor - new variant of the skipped-event trap, self-reported by kilo 2026-07-30. It relaunched a poll loop from the cursor in a /send receipt rather than from a poll response. It cost nothing ONLY because its previous loop was still running and both returned the identical batch; without that overlap it would have silently lost everything between the two numbers, with both ends reading healthy. The store already says relaunch with the EXACT cursor the POLL printed - this names the specific wrong number that looks most like the right one, because a receipt genuinely does carry a field called cursor.

## 4. CREATE YOUR VERIFY WORKTREE OUTSIDE WT_ROOT - the boot sweep will eat it otherwise

CREATE YOUR VERIFY WORKTREE OUTSIDE WT_ROOT - the boot sweep will eat it otherwise, measured on the live hub 2026-07-30 while a probe was running in it. orphanWorktrees (jarvis-text.mjs:1249) collects every dir under WT_ROOT that no live session claims, and a managers ad-hoc verify tree is claimable by NOTHING: the hub did not mint it, there is no host pid record, and a bound coordinators own session row has worktree null. Chris restarted at 13:29:54 on MY recommendation and the boot sweep logged ''worktree remove FAILED for a dead session at d:/claude/.jarvis-wt/oscar-verify; branch HEAD kept'' then ''collected 4 orphaned worktrees''; the tree was three minutes old, and it is now an empty shell with no .git and no entry in git worktree list. THE LOOP IS STRUCTURAL, not bad luck: the house standard says gate the candidate in a throwaway tree and THEN ask for the restart that deploys it, so every manager aims the sweep at its own running gate. Put the tree somewhere the sweep does not scan (the session scratchpad works) until the two carded fixes land - collect only names matching the jarvis-<callsign> pattern the hub itself mints, and never collect a tree younger than the grace window. SECOND LESSON, and it is why this was caught at all: a probe harness must re-verify its BASELINE AFTER probing, not only before. Mine did, came back 17 tests / 1 fail, and refused to print seven confident verdicts from a rig that was being deleted underneath it.

## 5. READABILITY IS A FIRST-CLASS REQUIREMENT NOW

READABILITY IS A FIRST-CLASS REQUIREMENT NOW, and the offender was us. Chris, voice + screenshot 2026-07-30 12:41: "I can not understand half of whats in there ... can we rebuild this with readability in mind for us slow readers ... but I need you to still have all the context you need". He was looking at agent-written board cards - multi-line paragraphs of shas, line numbers and parentheticals - plus a currentFocus line of roughly a thousand characters that I had written. THE APPROVED SHAPE: every card is HEADLINE -- DETAIL, the console renders only the headline (one line, ~80 chars, plain English), the detail opens on click. Separator is the first space-dash-dash-space, which is ALREADY the house separator because curl.exe mangles non-ASCII so em dashes are banned. No migration: an existing card renders its first clause as the headline and collapses the rest. HARD CONSTRAINT: do not rewrite existing card text to fit - Chris watches this board live and card churn jumps his view, so the RENDERER adapts. Applies equally to the rail summary and the doing line, which were worse than any card in that screenshot. bravo (s_0430) owns the build. AND THE PART THAT IS ON EVERY FUTURE MANAGER: keep currentFocus and doing SHORT because they render on HIS screen, and keep openThreads dense because only agents read them. I had already been told this on 2026-07-09 and drifted straight back.

## 6. PROBE METHOD

PROBE METHOD, new from yankee 2026-07-30 and it generalises: A NEEDLE THAT IS UNIQUE ONLY BY ACCIDENT LEAVES ITS TWIN UNPROBED. My forProject needle passed the harness one-hit guard and therefore looked rigorous, but it was unique only because I happened to include the join(DATA, worker-cs.log) argument - jarvis-core.mjs:2531 (console-less branch) and :2566 (console-ful wt-new-tab, passes null for the log) carry the IDENTICAL subOf || boundTo fallback, and :2566 has never been touched by any needle. The harness one-hit check protects against a needle matching too MUCH; nothing protects against a needle matching one of N equivalent sites. RULE: after a needle passes the one-hit guard, grep the SEMANTIC core of it (here subOf || boundTo) and count the sites - if the count is >1 you have probed one branch and proved nothing about the others. Companion to the existing survivor-meaning threads: same night delta closed a third survivor as EQUIVALENT code by proving the guarded field does not exist on the shape at all (coordinatorSlotHolder returns { kind, callsign } with no uid, so reachable(undefined) is already false and kind === live cannot change the outcome), and correctly refused to write a seventh assertion where deepEqual already pins the shape six times in the canonical file.

## 7. A FILE-MUTATING PROBE HARNESS MUST NEVER RUN AGAINST THE LIVE CHECKOUT - yankee did it and

A FILE-MUTATING PROBE HARNESS MUST NEVER RUN AGAINST THE LIVE CHECKOUT - yankee did it and it cost a deploy, 2026-07-30. I ran foxtrot probe-delta.mjs in d:/claude/jarvis-core (it writes jarvis-core.mjs, gates, restores) and recommended a Restart-and-deploy in the same window. Chris pressed it at 12:20:09 while mutant 3 of 8 was in the file, so the hub booted with deadSpawns.push instead of unshift and build.dirty came up TRUE. The mutant is NOT cosmetic: line 2422 truncates with deadSpawns.length = 10 which drops from the END, so append-then-truncate makes every new dead spawn invisible on /roster once ten have died - it silently disables the exact observability delta shipped hours earlier. Live impact was nil only because deadSpawns is in-memory and resets at boot. TWO RULES: (1) run mutation harnesses in a git worktree, never the checkout the hub loads; (2) build.dirty is the observable that catches this - read it on EVERY post-restart verify, because build.short alone said 59bf780 and looked like a perfect deploy.

## 8. A SURVIVING PROBE HAS A THIRD MEANING AND IT KEEPS RECURRING

A SURVIVING PROBE HAS A THIRD MEANING AND IT KEEPS RECURRING: the code is fine and the TEST was under-fed. romeo hit it 2026-07-30 - deleting the command-verb veto from isBatonQuestion killed nothing, because every command sentence in its fixture led with a VERB and the leading-interrogative anchor already rejected them. The veto is genuinely load-bearing, but only for polite forms that OPEN with an interrogative and reach it last: 'can you take the merge lane', 'would you hand the baton to kilo' - which are the forms Chris actually uses. Lesson: when a guard survives deletion, ask what input class would REACH it before concluding it is dead. Same night kilo hit the mis-ordered-test variant and romeo also found one genuine dead-CSS survivor it correctly deleted, so all three meanings appeared in one session.

## 9. LINE ENDINGS

LINE ENDINGS, SETTLED WITH A METHOD INSTEAD OF A FOURTH SNAPSHOT (charlie measured 2026-07-30, romeo prompted it). MEASURE WITH NODE: count bytes 0x0a and check whether the preceding byte is 0x0d. Result in d:/claude/jarvis-core at 8f586d7 - console.js 2147 CRLF / 0 LF, console.css 328/0, jarvis-text.mjs 1433/0, jarvis-core.mjs 4599/0, package.json 32/0, WORKER.md 249/0, and db.mjs 0 CRLF / 445 LF. So each FILE is internally pure and the REPO is mixed across files - which is why this store has flip-flopped four times: 'mixed' was true repo-wide, 'all CRLF' was true of whichever files that session opened, and neither was a lie. DO NOT TRUST SHELL TOOLS HERE, and do not name a guilty one: they fail INCONSISTENTLY by shell and invocation. romeo measured `tr -cd CR | wc -c` lying in its worktree; in the main checkout the same command was exactly right (2147) while `grep -c` for a literal CR returned 0 against 2147 CRs. sed strips CR before od ever sees it. Node or nothing.

## 10. A SIGNATURE CAN AGE INTO A NO-OP AND NO TEST WILL NOTICE

A SIGNATURE CAN AGE INTO A NO-OP AND NO TEST WILL NOTICE, proven on the live hub 2026-07-30. diagnoseSpawnLog matched /trust the files/i, the OLD Claude Code folder-trust wording, which appears ZERO times in a real log; the current prompt is 'Quick safety check: Is this a project you created or one you trust?' with 'Yes, I trust this folder'. charlie fired a deliberate doomed spawn (hotel, into an untrusted dir): the sweep fired correctly at 100s, deadSpawns row correct, sys line searchable, callsign freed - but it said 'No reason in the log' for the exact death the diagnoser exists to name, and diagnoseSpawnLog(real log) === null. THE TEST PASSED THROUGHOUT because its FIXTURE carries the old wording too, so it pinned the implementation assumption rather than reality. Lesson: when a test fixture and the code share an assumption about the OUTSIDE WORLD, the test proves only that they agree. Build fixtures from captured real output. Real log preserved at C:/Users/vinni/AppData/Local/Temp/claude/deadspawn-probe/hotel-trust-prompt.log; delta is fixing it.

## 11. VOICE INTENTS ARE NOT IN jarvis-text

VOICE INTENTS ARE NOT IN jarvis-text.mjs - charlie briefed romeo wrong on this 2026-07-30 and romeo measured it. Every spoken intent is dispatched by INLINE REGEX inside handleSpeech in jarvis-core.mjs (~2462-2790). There is no generic pure dispatcher to extend: isMissionCloseIntent / matchMissionByPhrase are only PREDICATES, and core still owns the if and the enqueueSay. So any new voice phrase needs a small insertion in jarvis-core.mjs no matter how much of it is pure - and shipping the helpers unwired is the Where-is-the-search failure one layer down. Related, and load-bearing for the baton chip: batonFor(uid) is keyed on the CARD uid (jarvis-core.mjs:3050, built at 2990-3000), and a project card uid is its BOUND WORKER, so when the manager holds the lane the chip renders on the jarvis PROJECT card, not on a session card.

## 12. A CROSSING MESSAGE CAN MAKE A TRUE STATEMENT FALSE

A CROSSING MESSAGE CAN MAKE A TRUE STATEMENT FALSE, 2026-07-30. I mistook primeng sub-worker sierra for a successor of my own retired worker and told it to stand down; it pushed back with specifics (its own pin, parentProject primeng, briefed by quebec at 00:02, no handoff, no inherited board) and was right on every point. It also warned me jarvis/sierra was UNMERGED - true when it wrote it, false by the time I read it, because quebec had merged it a minute earlier as NewBeta2 a901a218bb, gated green. quebec named the real hazard: the same crossing can go the OTHER way, so a card closed because a delegate said the work landed can be closed on a belief that was not yet true. VERIFY STATE AT THE MOMENT YOU ACT, not at the moment you were told. Note also that NO uniform successor ever spawned - closing its board card before it retired is what prevented one.

## 13. DO NOT PARSE node --test OUTPUT BY ASSUMING THE LINE PREFIX - hit by TWO sessions independ

DO NOT PARSE node --test OUTPUT BY ASSUMING THE LINE PREFIX - hit by TWO sessions independently within one hour, 2026-07-30. The summary lines are `i tests 431`, not `# tests 431`, using a multibyte info glyph. charlie probe harness regex ^# ?tests (\d+)$ matched nothing and read every count as null; uniform grep ^. matched nothing, exited 1, and it nearly reported a PASSING gate to its manager as a failure. Robust form: ^\W*<key> (\d+)\s*$ with the m flag. Same family as the JARVIS_INTEGRATION skip trap and the unparsed-count trap already in this store - all three make an instrument report the absence of evidence as evidence. The rule that saves you: a harness must verify its own BASELINE parses to the exact expected count with skipped==0 before any verdict it prints is worth reading.

## 14. CHECK ON A SUB-WORKER VIA /board

CHECK ON A SUB-WORKER VIA /board, NEVER /roster - generalises an older note in this store. GET /roster live[] projects a THIN row: no doing, no context, no project, no parentProject, and (already known) no worktree and no branch. quebec read kilo as never having posted a doing line and told Chris so; kilo had posted /health five times, most recently two minutes earlier. quebec own row showed ctx blank despite two /health posts, which is the proof it is the ENDPOINT and not the workers. /board carries all of those fields, which is why the console looks fine. Carded 2026-07-30.

## 15. MISSION RAIL

MISSION RAIL, two measured facts from uniform 2026-07-30 that any rail work must handle: (1) b.worker is NULL whenever a session callsign equals its card callsign (jarvis-core.mjs:2947), so on a SUB-WORKER row it is always null - alpha warned that printing it everywhere would render LIMA twice, and the real effect is that it renders NOTHING; the guard was right, the stated mechanism was not. (2) Retiring a coordinator NULLS its project card uid and the rail filters on uid, so the parent row LEAVES the rail while its sub-workers stay nested through the surviving card - THERE IS NOT ALWAYS A PARENT ROW. Also uniform rule for the COORD chip, which is the right one: coordinator = HAS A PROJECT CARD, not has-sub-workers; role is how a session is BOUND, not how many children exist this second, and railRole takes one argument so it structurally cannot consult the children.

## 16. A BOUND COORDINATOR HAS NO CARD UNDER ITS OWN CALLSIGN - this is BY DESIGN

A BOUND COORDINATOR HAS NO CARD UNDER ITS OWN CALLSIGN - this is BY DESIGN, not the board gap it looks like. It renders as the PROJECT card with worker:<callsign> (jarvis card carries worker:charlie, primeng card carries worker:quebec), so a roster-vs-board diff will always show the coordinator as NO CARD. charlie briefly reported that as a defect to Chris 2026-07-30 and had to retract it; the retraction also caught a second error, that oscar and papa had simply RETIRED between the /roster pull and the /board pull. Cross-check roster against board in ONE fetch pair or the session churn reads as a bug. The genuine related defect is already queued: the mission rail parent row prints the project key and drops the callsign (uniform building the COORD chip).

## 17. RECORD INTER-WORKER /send AS kind

RECORD INTER-WORKER /send AS kind:msg, NOT kind:chat - golf overturned charlie brief on mechanism 2026-07-30 and the reasoning is worth keeping. kind:chat looks harmless (it never matches the solo-brain speech filter) but breaks two things: console.js:1657-1678 consults `to` ONLY when who==="you" (the human routing speech at a worker), so a worker-authored chat routes by e.who === activeTab and a delegation brief renders in the MANAGER own tab as if the manager were talking to Chris; and worse, GET /mission-chat (jarvis-core.mjs:3535-3537) gates kinds={speech,tts,chat} and matches memberCs.has(from)||memberCs.has(to), so recording as chat injects worker-to-worker traffic into the mission conversation that a BOOTING COORDINATOR is told (jarvis-core.mjs:2321) to treat as its live prompt - a brief gets re-read as an instruction. kind:msg is already the bus name for this and is not yet a transcript kind, so both transcript gates (3407, 3535) exclude it by construction. Then add msg to SEARCHABLE and to DEFAULT_KINDS (console.js:416 searches with no kinds param, so SEARCHABLE-only leaves the default path blind); charlie authorised widening the default and updating the pinned assertion at test/search.test.mjs:103.

## 18. PROBE LESSON

PROBE LESSON, new, from kilo 2026-07-30: a probe that SURVIVES is as often a MIS-ORDERED TEST as it is dead code. kilo deleted pendingSpawns.delete() from the sweep and nothing failed - cause was its own test ordering, because a step that registered a session under the dead callsign made overdueSpawns skip that entry from then on, so the reported-ONCE check downstream was measuring nothing. The store previously knew only two survivor meanings (redundant code / real test gap); this is a third and it is the one that looks most like the code being fine.

## 19. TRAP THAT MAKES A FALSE TEST LOOK CONCLUSIVE

TRAP THAT MAKES A FALSE TEST LOOK CONCLUSIVE, found by zulu 2026-07-29: inter-worker /send calls busAppend ONLY and never record() - just the to:"human" branch records (jarvis-core.mjs:3686-3692). So worker-to-worker messages NEVER enter transcript.jsonl and GET /search can never see them. I searched the transcript for a delegate's report, found nothing, and told it its send had failed - the evidence was void by construction. Never use chat search to test inter-worker delivery; read the bus or poll the index.

## 20. POLL DISCIPLINE

POLL DISCIPLINE, and it cost a report tonight: relaunch the loop with the EXACT cursor the poll printed, never a number you inferred. I relaunched at 6390 when the poll had returned 6388 and silently skipped 6389, which was zulu's whole board audit. A cursor advanced past an event makes that event UNREACHABLE through /poll - there is no catch-up and no error, and both ends read healthy. Recovery: curl /poll?cursor=<N-1> directly for the missed index. Related open card asks for a delivery signal on /send.

## 21. CORRECTION 2026-07-29

CORRECTION 2026-07-29, measured: the 'node db.mjs backfill still owed / jarvis.db last written Jul 22' item that has been parked on Chris for days is DEAD. jarvis.db mtime is 2026-07-29 18:36 (verified on disk), and the hub never writes that file - only db.mjs does - so the re-run already happened. Do not re-park it.

## 22. STORE HAZARD

STORE HAZARD, and I did the damage myself 2026-07-29 23:50: POST /project-context REPLACES openThreads wholesale, and GET /project?name=jarvis returns the project FLAT (no `project` wrapper). My update script read `(await r.json()).project` on that flat response, got undefined, defaulted to an empty array, and overwrote 22 entries with 3. Restored from context. Read-modify-write this array with `j.project || j`, and ALWAYS verify the read-back count is >= what you started with before you consider the write done.

## 23. DESIGN CONSTRAINT from Chris

DESIGN CONSTRAINT from Chris, voice + screenshot 2026-07-29 23:41: in the new UI, KEEP THE WORKERS CLOSER TO THE MISSION. What he was looking at is the flat worker pane - every session card in one arbitrary list, with jarvis's sub-workers (kilo, uniform, zulu) interleaved between primeng's (bravo, lima, mike, xray), so a worker's card sits nowhere near the mission it serves. NOTE THE CONTRADICTION, and it matters because the card is the only place the design exists: the board card for the mission-first re-layout says 'left=missions, mid=workers+shared chat', which puts workers in a SEPARATE COLUMN - FURTHER from the mission, not closer. Redraw that sketch before anyone builds it. The shape that already works is the compact mission rail he called amazeballs the same minute: workers nested INSIDE the mission card, indented under their coordinator. No doc in docs/ describes this layout at all - grep found nothing for mission-first / left=missions / drag-to-bind - which is exactly why it is recorded here.

## 24. NEW TRAP, found by charlie the hard way and it is silent: the boot pro

NEW TRAP, found by charlie the hard way and it is silent: the boot prompt is re-parsed as a CMD.EXE COMMAND LINE. node-pty runs claude through cmd.exe when it resolves to a .cmd, so a stray < or > anywhere in the boot text is a REDIRECTION - measured, an angle-bracketed placeholder made cmd answer 'The system cannot find the file specified' and the worker NEVER REGISTERED. Indistinguishable from a spawn that simply failed. Keep boot-prompt placeholders in quotes; safePurpose already strips the class from the human-controlled part.

## 25. NOTE on test/delegate

NOTE on test/delegate.test.mjs: it is ONE test covering three claims (coordinator is told, sub-worker is not, delegate reports back). Both of my independent probes killed it but via DIFFERENT assertions, so each claim is genuinely pinned - however the house standard prefers splitting so a red test names which claim broke. Left as-is deliberately (organization, not a correctness gap); split it if you touch that file.

## 26. BOARD ROT IS REAL - audit the queued lane against the CODE before building anything

BOARD ROT IS REAL - audit the queued lane against the CODE before building anything. india found two shipped cards still sitting in queued (P2 parentProject sub-workers, and type-to-mission T1+T2). A card that says 'needs server change' may describe work that landed weeks ago. AUDITED 2026-07-29 by zulu: 5 verified-shipped cards cleared from queued; only 3 cards in the lane are genuinely unbuilt (prod-deployment Slack watcher, re-home the #jarvis watcher, delete the stale repo-dir repos.json); 3 more still SAY 'needs hub restart' when the restart is long done.

## 27. RIG NOTE the roster does NOT show

RIG NOTE the roster does NOT show: GET /roster live[] omits worktree and branch, so a sub-worker looks like it is sharing the main checkout when it is not. I briefly mis-read charlie that way. Confirm isolation with git worktree list, not the roster.

## 28. DO NOT re-inherit 'blocked on hub restart'

DO NOT re-inherit 'blocked on hub restart'. It happened at 21:59:17Z on 2026-07-27 and is verified three ways (build.short = HEAD, new pid, boot transcript line carries the sha).

## 29. RESOLVED 2026-07-27

RESOLVED 2026-07-27: the push question is CLOSED. Chris said push; origin is https://github.com/VinnieAtTai/jarvis-core.git (PUBLIC) and main is pushed to 2b788d5 with 0 unpushed. Do not re-offer it as an open decision. TWO remotes - origin is public GitHub, backup is a local bare repo in OneDrive.

## 30. CLOSED 2026-07-29 22

CLOSED 2026-07-29 22:38:50, and observed not inferred: the SECOND-RESTART survival question is ANSWERED. Chris ran a real Restart-and-deploy (pid 53888 -> 47752, build f5fc578 -> 2b788d5) and THREE workers spawned by the OLD pid came through it: india kept polling after nine hours up, juliet kept polling, and whiskey survived long enough to finish its build and retire cleanly a minute later. Do not re-open this.

## 31. PROVEN LIVE the same minute

PROVEN LIVE the same minute: the sub-worker retire notify from 2b788d5 fired in production - 'your sub-worker whiskey retired: ...' arrived on the coordinator inbox from the running hub. I nearly reported this as my feature working BEFORE checking the build, which would have been the merged-means-deployed error all over again. Check build.short FIRST, every time; the reason the message existed at all was that Chris had just deployed it.

## 32. LESSON, cost a round trip with an annoyed Chris: do not scope the SURF

LESSON, cost a round trip with an annoyed Chris: do not scope the SURFACE out of a user-facing feature. He asked for chat search, I shipped GET /search and deliberately left the console box for later to avoid colliding with his unpicked shell - his reply was 'Where's the search?!'. A search you have to curl is not a search. Server-first is right for plumbing (the baton, the notify); it is wrong when the whole point is that HE can use it. Ship the box with the endpoint.

## 33. TOOLING, current: npm run test:integration opens the gate on the WHOLE

TOOLING, current: npm run test:integration opens the gate on the WHOLE suite - baseline now 398/398/0 (was 354). Individual gates: test:survival, test:revive, test:subworker, test:boardcard, test:store, test:report, test:credit, test:spawnslot, test:schedulenudge, test:baton, test:delegate, test:archive, verify:searchbox.

## 34. HOUSE STANDARD

HOUSE STANDARD: mutation-probe every new assertion - a test that has never failed has not been shown to check anything. Report a probe that SURVIVES rather than hiding it. It keeps paying: survivors have been deleted as redundant code three times, and three of bravo six became real test gaps. Also probe a sub-worker's work YOURSELF at merge time; do not merge on its probe count alone. AND PROBE YOUR PROBE HARNESS: mine printed KILLED for four mutants because its count regex failed to parse node --test output and '?' is not '0'. Verify the harness reads a clean BASELINE, and require tests-ran == baseline with skipped == 0, so 'nothing ran' can never read as 'killed'.

## 35. CORRECTED

CORRECTED (was wrong in this store): line endings here are MIXED, not uniformly CRLF. jarvis-core.mjs, jarvis-text.mjs and package.json are CRLF; db.mjs, console.js, WORKER.md and several test/ files are LF; a fresh worktree can differ from the main checkout again. MEASURE the file before writing a multi-line mutation needle, or keep needles to single lines.

## 36. CWD TRAP, hit twice by two different sessions: the Bash tool cwd PERSI

CWD TRAP, hit twice by two different sessions: the Bash tool cwd PERSISTS between calls, so a cd into a worker worktree silently redirects every later relative git/grep. It looked like the merge had dropped my own commits. Use git -C and absolute paths.

## 37. TESTING TRAP

TESTING TRAP: node --test collects EVERY .mjs under test/, so a helper there counts as a passing test. Shared rig lives in test-support/scratch-hub.mjs and doubles as a CLI: node test-support/scratch-hub.mjs --hold 180. Its spawnWorker defaults cwd to a SCRATCH repo dir, NOT the hub checkout - anything keyed on the hub own directory needs cwd: REPO_ROOT explicitly or the wiring never fires and the test passes for the wrong reason. Boot prompts ARE observable after all: overwrite hub.BIN/claude.cmd before hub.start() and dump CMDCMDLINE under delayed expansion (recordBootPrompts in test/delegate.test.mjs - promote it if a second test needs it). %* cannot be forwarded, because node-pty escapes the prompt's own quotes as backslash-quote and cmd does not understand that escape.

## 38. ANOTHER SKIP TRAP

ANOTHER SKIP TRAP, and it burned two sessions in a row: node --test <file> SKIPS integration tests unless JARVIS_INTEGRATION=1, so fail=0 means NOTHING RAN, not nothing caught it. Always read the PASS count. npm run test:integration sets the env var for the whole suite.

## 39. NOTE, not a defect: an UNCONFIGURED repo resolves to the adhoc key, so

NOTE, not a defect: an UNCONFIGURED repo resolves to the adhoc key, so two unrelated ad-hoc checkouts would share one commit-baton lane. Conservative (over-serialization, never corruption) and the same fallback resolveRepo already uses for tier/permissionMode; every repo in play is configured.

## 40. ROLE PROBLEM

ROLE PROBLEM, open and not a bug: primeng carries a huge board on the COORDINATOR. Chris wants coordinators thin. Do not bulk-mutate without an explicit go. Seen again 2026-07-29 23:35: its rail row read 'working: bulk-operations guard fix' while two sub-workers were out, and Chris noticed and asked which one was the coordinator.

## 41. DO NOT /forget a live coordinator to clear a duplicate card - that endpoint RETIRES the se

DO NOT /forget a live coordinator to clear a duplicate card - that endpoint RETIRES the session.

## 42. DO NOT NARROW guardian taskkill /T - stt

DO NOT NARROW guardian taskkill /T - stt.mjs:74 spawns whisper-server as an undetached hub child and only /T reaps it. What protects the worker fleet is upstream: workers are orphan-spawned via orphan-spawn.mjs into pty-hosts parented to a dead pid, so they sit outside the /T tree entirely (guardian.mjs:40-62 explains it; hostPid itself lives in jarvis-core.mjs, not guardian.mjs).

## 43. OPEN DECISION

OPEN DECISION: repos.json jarvis tier=trusted on top of bypassPermissions. jarvis workers already launch with --permission-mode bypassPermissions; broker (d:/code/tms) has NEITHER, so every TMS worker interrupts Chris. NOTE 2026-07-29: Chris gave the go for tier:trusted on broker and tango applied it via POST /repos + POST /trust, verified on disk because GET /repos does not project the tier field. Separately MEASURED: bypassPermissions does NOT suppress the folder-trust dialog, so it was never a spawn fix.

## 44. NEEDS CHRIS IN THE BROWSER after a RELOAD

NEEDS CHRIS IN THE BROWSER after a RELOAD: pane-lock 5-step, sub-worker indentation, DEAF chip, Local-STT voice check, and the new chat search box at his real window size. (Auto-revive is covered headlessly by test:revive.)

## 45. LESSON, cost 5 sessions: verify a deploy by an observable the fix ACTU

LESSON, cost 5 sessions: verify a deploy by an observable the fix ACTUALLY changes. build.short is now that observable - but build.short only proves the code is LOADED. For the folder-trust fix the real observable was the trust mark appearing on the new worktree path in .claude.json, which only trustWorktreePath() can write.

## 46. VERIFY 'MERGED' THE SAME WAY YOU VERIFY 'DEPLOYED'

VERIFY 'MERGED' THE SAME WAY YOU VERIFY 'DEPLOYED', 2026-07-29: echo's spawn folder-trust fix was recorded in this store AND in a handoff as 'merged by the manager' and it was not - it sat on jarvis/echo, one retire away from being lost, and it was the most valuable commit of the night. On arrival, run git merge-base --is-ancestor <branch> main for every branch a predecessor claims to have landed.
