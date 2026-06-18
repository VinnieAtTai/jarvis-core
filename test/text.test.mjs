// Unit tests for the pure parsers in jarvis-text.mjs. Run with `npm test` (node --test).
// No server boot, no I/O — these import the real functions the hub uses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { clk, remTitle, parseReminder, parseScheduleText } from '../jarvis-text.mjs';

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
