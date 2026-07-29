// Unit tests for the pure parsers in jarvis-text.mjs. Run with `npm test` (node --test).
// No server boot, no I/O — these import the real functions the hub uses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { clk, remTitle, parseReminder, parseScheduleText, shortTitle, summarizeBoard, permSig, permLabel, canon, orderedTasks, projectForMission, shouldNudgeSchedulePull } from '../jarvis-text.mjs';

const minutesFromNow = iso => (Date.parse(iso) - Date.now()) / 60000;

test('parseReminder — relative minutes', () => {
    const r = parseReminder('remind me in 10 min to take out the trash');
    assert.equal(r.title, 'take out the trash');
    assert.ok(Math.abs(minutesFromNow(r.start) - 10) < 0.5, 'fires ~10 min out');
});

test('parseReminder — relative hours', () => {
    const r = parseReminder('remind me in 2 hours to call the bank');
    assert.equal(r.title, 'call the bank');
    assert.ok(Math.abs(minutesFromNow(r.start) - 120) < 0.5);
});

test('parseReminder — task before the time clause', () => {
    const r = parseReminder('remind me to stretch in 20 minutes');
    assert.equal(r.title, 'stretch');
    assert.ok(Math.abs(minutesFromNow(r.start) - 20) < 0.5);
});

test('parseReminder — "an hour" maps to 60 min', () => {
    const r = parseReminder('remind me in an hour to drink water');
    assert.equal(r.title, 'drink water');
    assert.ok(Math.abs(minutesFromNow(r.start) - 60) < 0.5);
});

test('parseReminder — does not eat "for X" inside the task', () => {
    const r = parseReminder('remind me to pay for parking in 10 minutes');
    assert.equal(r.title, 'pay for parking');
    assert.ok(Math.abs(minutesFromNow(r.start) - 10) < 0.5);
});

test('parseReminder — bare timer phrasing titles as "Timer"', () => {
    assert.equal(parseReminder('set a timer for 5 minutes').title, 'Timer');
    assert.equal(parseReminder('timer for 1 hour').title, 'Timer');
});

test('parseReminder — jarvis prefix is stripped from the title', () => {
    const r = parseReminder('jarvis, remind me in 5 minutes to check the build');
    assert.equal(r.title, 'check the build');
});

test('parseReminder — absolute time, future today', () => {
    // Pick a time clearly later than "now" so it stays today: 11:59 PM.
    const r = parseReminder('remind me at 11:59pm to lock up');
    assert.equal(r.title, 'lock up');
    const d = new Date(r.start);
    assert.equal(d.getHours(), 23);
    assert.equal(d.getMinutes(), 59);
});

test('parseReminder — absolute 12 am/pm boundary (the H % 12 arithmetic)', () => {
    // "12 pm" is noon (hour 12), "12 am" is midnight (hour 0) — the +12/%12 math is easy to
    // flip at exactly 12. getHours() is stable whether the time lands today or rolls to tomorrow.
    assert.equal(new Date(parseReminder('remind me at 12 pm to eat lunch').start).getHours(), 12);
    assert.equal(new Date(parseReminder('remind me at 12 am to sleep').start).getHours(), 0);
    const r = parseReminder('remind me at 3:30 pm to join the call');
    assert.equal(new Date(r.start).getHours(), 15);
    assert.equal(new Date(r.start).getMinutes(), 30);
});

test('parseReminder — no time returns null', () => {
    assert.equal(parseReminder('what reminders do I have'), null);
    assert.equal(parseReminder('remind me about the thing'), null);
});

test('remTitle — defaults', () => {
    assert.equal(remTitle('remind me in 10 minutes'), 'Reminder');
    assert.equal(remTitle(''), 'Reminder');
});

test('clk — 12h formatting', () => {
    assert.equal(clk(new Date(2026, 0, 1, 15, 30).toISOString()), '3:30 PM');
    assert.equal(clk(new Date(2026, 0, 1, 9, 0).toISOString()), '9 AM');
    assert.equal(clk(new Date(2026, 0, 1, 0, 0).toISOString()), '12 AM');
    assert.equal(clk(new Date(2026, 0, 1, 12, 0).toISOString()), '12 PM');
});

test('parseScheduleText — titles + times, sorted, RSVP noise stripped', () => {
    const s = parseScheduleText([
        'Design review (Jane @ jane@example.com)',
        '2:00 PM - 3:00 PM',
        'Standup',
        '9:00 AM - 9:15 AM',
    ].join('\n'));
    assert.equal(s.events.length, 2);
    // sorted by start
    assert.equal(s.events[0].title, 'Standup');
    assert.equal(s.events[1].title, 'Design review');   // "(Jane @ ...)" stripped
    assert.equal(new Date(s.events[0].start).getHours(), 9);
    assert.equal(new Date(s.events[1].start).getHours(), 14);
    assert.deepEqual(s.announced, {});
});

test('parseScheduleText — empty input yields no events', () => {
    assert.equal(parseScheduleText('').events.length, 0);
});

test('parseScheduleText — a start time with no AM/PM inherits the end\'s meridiem', () => {
    // Documented quirk: the start meridiem is optional, so "10:00 - 11:00 AM" reads the start
    // as 10 AM by borrowing the end's "AM". (Pins current behavior; a future change here is a
    // deliberate choice, not a silent regression.)
    const s = parseScheduleText('Standup\n10:00 - 11:00 AM');
    assert.equal(s.events.length, 1);
    assert.equal(new Date(s.events[0].start).getHours(), 10);
    assert.equal(new Date(s.events[0].end).getHours(), 11);
});

test('parseScheduleText — "Past events" marker drops the dangling title before it', () => {
    // A title with no time line must not bind to the next time after a "Past events" divider.
    const s = parseScheduleText(['Yesterday leftover', 'Past events', 'Real meeting', '2:00 PM - 3:00 PM'].join('\n'));
    assert.equal(s.events.length, 1);
    assert.equal(s.events[0].title, 'Real meeting');
});

test('shortTitle — strips a leading category tag', () => {
    assert.equal(shortTitle('BUG: copy button denied'), 'copy button denied');
    assert.equal(shortTitle('FEATURE: add a local STT toggle'), 'add a local STT toggle');
});

test('shortTitle — keeps the first seven words', () => {
    assert.equal(shortTitle('one two three four five six seven eight nine'), 'one two three four five six seven');
});

test('shortTitle — caps the headline at 50 chars', () => {
    assert.ok(shortTitle('supercalifragilistic expialidocious antidisestablishmentarianism').length <= 50);
});

test('summarizeBoard — empty / work-free board reads as nothing', () => {
    assert.equal(summarizeBoard(null), '');
    assert.equal(summarizeBoard({ working: [], queued: [] }), '');
    // only done/review counts as no open work
    assert.equal(summarizeBoard({ done: [{ text: 'shipped' }], review: [{ text: 'r' }] }), '');
});

test('summarizeBoard — a single working task names it, summarized (no tag)', () => {
    assert.equal(
        summarizeBoard({ working: [{ text: 'BUG: fix the copy button on chat cards right now' }], queued: [] }),
        'Working on fix the copy button on chat cards.'
    );
});

test('summarizeBoard — multiple working tasks give a count + headline, not all of them', () => {
    assert.equal(
        summarizeBoard({ working: [{ text: 'alpha task' }, { text: 'beta task' }, { text: 'gamma' }], queued: [] }),
        'Working on 3, starting with alpha task.'
    );
});

test('summarizeBoard — queued summarized as count + next', () => {
    assert.equal(summarizeBoard({ working: [], queued: [{ text: 'review the PR' }] }), '1 queued, review the PR.');
    assert.equal(
        summarizeBoard({ working: [], queued: [{ text: 'alpha' }, { text: 'beta' }] }),
        '2 queued, next alpha.'
    );
});

test('summarizeBoard — working + queued combine in one line', () => {
    assert.equal(
        summarizeBoard({ working: [{ text: 'the big task' }], queued: [{ text: 'b' }, { text: 'c' }] }),
        'Working on the big task; 2 queued, next b.'
    );
});

test('summarizeBoard — tolerates legacy string tasks and blank entries', () => {
    assert.equal(summarizeBoard({ working: ['legacy string task'], queued: [] }), 'Working on legacy string task.');
    // blank-text tasks do not count toward the summary
    assert.equal(summarizeBoard({ working: [{ text: '' }, { text: '   ' }], queued: [{ text: 'real one' }] }), '1 queued, real one.');
});

test('permSig — Bash single-word command collapses to one verb', () => {
    assert.equal(permSig('Bash', 'ls -la'), 'Bash::ls');
});

test('permSig — multiword family keeps two leading words, lowercased', () => {
    assert.equal(permSig('Bash', 'git SHOW abc123'), 'Bash::git show');
    assert.equal(permSig('PowerShell', 'npm run build'), 'PowerShell::npm run');
});

test('permSig — non-shell tools collapse to the tool name', () => {
    assert.equal(permSig('Read', '/etc/hosts'), 'Read::*');
});

test('permLabel — shell families get a trailing wildcard, non-shell just the tool', () => {
    assert.equal(permLabel('Bash', 'git show abc'), 'git show *');
    assert.equal(permLabel('Bash', 'ls -la'), 'ls *');
    assert.equal(permLabel('Edit', 'foo.js'), 'Edit');
});

test('canon — normalizes the NATO aliases STT mangles', () => {
    assert.equal(canon('tell x-ray and x ray and juliette'), 'tell xray and xray and juliet');
    assert.equal(canon('no aliases here'), 'no aliases here');
});

test('orderedTasks — flattens lanes in display order with lane + index', () => {
    const board = { working: [{ text: 'w0' }], queued: [{ text: 'q0' }, { text: 'q1' }], done: [{ text: 'd0' }], review: [{ text: 'r0' }] };
    const ord = orderedTasks(board);
    assert.deepEqual(ord.map(o => o.list), ['review', 'working', 'queued', 'queued', 'done']);
    assert.deepEqual(ord.map(o => o.item.text), ['r0', 'w0', 'q0', 'q1', 'd0']);
    assert.equal(ord[2].i, 0); // first queued keeps its within-lane index
});

test('orderedTasks — missing lanes are treated as empty', () => {
    assert.deepEqual(orderedTasks({ working: [{ text: 'only' }] }).map(o => o.item.text), ['only']);
});

test('projectForMission — finds the project whose missionId matches', () => {
    const projects = [
        { name: 'jarvis', missionId: null },
        { name: 'primeng', missionId: 'm_abc' },
        { name: 'waterfall', missionId: 'm_xyz' },
    ];
    assert.equal(projectForMission(projects, 'm_abc').name, 'primeng');
    assert.equal(projectForMission(projects, 'm_xyz').name, 'waterfall');
});

test('projectForMission — no match / no id / bad input yields null', () => {
    const projects = [{ name: 'primeng', missionId: 'm_abc' }];
    assert.equal(projectForMission(projects, 'm_nope'), null);
    assert.equal(projectForMission(projects, ''), null);
    assert.equal(projectForMission(projects, null), null);
    assert.equal(projectForMission(null, 'm_abc'), null);
    assert.equal(projectForMission(undefined, 'm_abc'), null);
});

test('projectForMission — returns the FIRST project when several link the same mission', () => {
    const projects = [
        { name: 'first', missionId: 'm_shared' },
        { name: 'second', missionId: 'm_shared' },
    ];
    assert.equal(projectForMission(projects, 'm_shared').name, 'first');
});

// ---- shouldNudgeSchedulePull: who gets asked to fetch the day's meetings, and how often --------
// The hub cannot reach Google, so the day's schedule only arrives if a Calendar-capable session goes
// and gets it. These pin the two things that make an automatic ask safe rather than annoying: it goes
// to a session that can actually act on it, and it goes out once.
const TODAY = 'Tue Jul 28 2026';
const HUB = 'd:/claude/jarvis-core';
const nudge = (o = {}) => shouldNudgeSchedulePull({
    scheduleDate: 'scheduleDate' in o ? o.scheduleDate : 'Mon Jul 27 2026',
    nudgedFor: o.nudgedFor,
    today: 'today' in o ? o.today : TODAY,
    sessionCwd: 'cwd' in o ? o.cwd : HUB,
    hubCwd: o.hub || HUB,
    isSubWorker: o.isSubWorker,
});

test('shouldNudgeSchedulePull — a stale schedule asks the session in the hub own checkout', () => {
    assert.equal(nudge(), true);
    // Never pulled at all is the same stale, not a special case (this was the state on a fresh boot).
    assert.equal(nudge({ scheduleDate: undefined }), true);
    assert.equal(nudge({ scheduleDate: null }), true);
});

test('shouldNudgeSchedulePull — a schedule already pulled today asks nobody', () => {
    assert.equal(nudge({ scheduleDate: TODAY }), false);
});

test('shouldNudgeSchedulePull — ONCE a day: a session registering after the ask is not asked again', () => {
    // The fleet case: several sessions can register within seconds of each other, and the chore is
    // one chore. `nudgedFor` is persisted with the schedule, so this holds across a hub restart too.
    assert.equal(nudge({ nudgedFor: TODAY }), false);
    // ...and yesterday's ask does not silence today's.
    assert.equal(nudge({ nudgedFor: 'Mon Jul 27 2026' }), true);
});

test('shouldNudgeSchedulePull — a worker in ANOTHER repo is never asked', () => {
    // A TMS worker has no Calendar access; asking it burns a turn it cannot act on, and because the
    // ask is once-a-day it would burn the whole day's pull with it.
    assert.equal(nudge({ cwd: 'd:/code/tms' }), false);
    assert.equal(nudge({ cwd: '' }), false);
    assert.equal(nudge({ cwd: null }), false);
    // Two UNKNOWN paths are not the same directory. Without this an unregistered cwd on both sides
    // compares equal-as-empty and every such session gets asked.
    assert.equal(shouldNudgeSchedulePull({ scheduleDate: 'Mon Jul 27 2026', today: TODAY, sessionCwd: '', hubCwd: '' }), false);
    // A bare call must not throw its way into blocking a register.
    assert.equal(shouldNudgeSchedulePull(), false);
    assert.equal(shouldNudgeSchedulePull(undefined), false);
});

test('shouldNudgeSchedulePull — a SUB-WORKER is left alone, even in the hub own checkout', () => {
    // Sub-workers are spawned for one named job and usually isolated in a worktree whose cwd is
    // remapped back to the repo at register, so they look exactly like a brain here. The chore
    // belongs to a coordinator; handing it to a delegated build is how the build gets distracted.
    assert.equal(nudge({ isSubWorker: true }), false);
    assert.equal(nudge({ isSubWorker: false }), true);
});

test('shouldNudgeSchedulePull — matches through Windows path spelling, or the ask never fires at all', () => {
    // Sessions store the path they booted in (backslashes); the hub knows its own as it was resolved.
    // The same class of mismatch that made resolveRepo miss d:\\code\\tms would silently disable this.
    for (const spelling of ['D:\\claude\\jarvis-core', 'd:\\claude\\jarvis-core\\', 'D:/CLAUDE/Jarvis-Core']) {
        assert.equal(nudge({ cwd: spelling }), true, spelling);
    }
});

test('shouldNudgeSchedulePull — no notion of today means no notion of stale', () => {
    assert.equal(nudge({ today: '' }), false);
    assert.equal(nudge({ today: null }), false);
});
