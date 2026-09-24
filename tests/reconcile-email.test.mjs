// tests/reconcile-email.test.mjs — reconcile-email.mjs / lib/email-reconcile.mjs.
//
// Offline: gog is a fake executable or a stub, Jev is a stub `ask`. Pinned:
//   - every gog call is read-only and wraps untrusted content; bodies are sanitized
//   - an ATS sender (not the employer) still reaches the employer's row, in any track
//   - a recruiter writing as a person reaches the row through its Via column
//   - a transition that would move a row backwards is refused, not written
//   - a match below 0.7 is only reviewed, never written
//   - --apply backs up, writes through set-status, and a second run changes nothing

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pass, fail, rmSync } from './helpers.mjs';
import {
  GOG_SAFETY_FLAGS, applyChanges, candidatesFor, extractDeadline, fetchEmails, judgeEmails, planReconciliation, runGog,
} from '../lib/email-reconcile.mjs';
import { readTrackerRows, trackList } from '../lib/tracks.mjs';

console.log('\nreconcile-email — Gmail × tracker reconciliation');

const ok = (label, cond) => (cond ? pass(label) : fail(label));
delete process.env.CAREER_OPS_TRACKER;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-email-'));
const HEADER = '# Applications Tracker\n\n| # | Date | Company | Via | Role | Score | Status | PDF | Report | Notes |\n|---|------|---------|-----|------|-------|--------|-----|--------|-------|\n';
const row = (num, company, via, role, status, notes = 'evaluated') => `| ${num} | 2026-09-01 | ${company} | ${via} | ${role} | 4.0/5 | ${status} | ❌ | [${num}](../reports/${num}-x-2026-09-01.md) | ${notes} |\n`;

function makeTracks() {
  const dir = fs.mkdtempSync(path.join(tmp, 'run-'));
  const a = path.join(dir, 'track-a');
  const b = path.join(dir, 'track-b');
  const shared = path.join(dir, 'shared');
  for (const d of [a, b, shared]) fs.mkdirSync(path.join(d, 'data'), { recursive: true });
  fs.writeFileSync(path.join(a, 'data', 'applications.md'), HEADER
    + row(10, 'Acme Cloud', '—', 'Senior Site Reliability Engineer', 'Applied')
    + row(11, 'ALTAVE', '—', 'Engineering Manager - IA', 'Interview')
    + row(12, 'Globex', '—', 'Platform Engineer', 'Discarded')
    + row(13, 'Initech', '—', 'DevOps Engineer', 'SKIP'));
  fs.writeFileSync(path.join(b, 'data', 'applications.md'), HEADER
    + row(1003, 'Chartis', '—', 'Senior Data Platform Engineer', 'Evaluated')
    + row(1004, '?', 'iTRTech Group', 'Technical Project Manager - DevSecOps', 'Evaluated')
    + row(1005, 'Umbrella', '—', 'Staff Product Manager', 'Evaluated'));
  fs.writeFileSync(path.join(shared, 'trilhas.yml'), `trilhas:\n  - id: A\n    dir: ${a}\n  - id: B\n    dir: ${b}\n`);
  const tracks = trackList(a, shared);
  return { a, b, tracks };
}

function allRows(tracks) {
  return tracks.flatMap((t) => readTrackerRows(t.root).rows.map((r) => ({ track: t.id, row: r })));
}

const email = (threadId, date, fromName, address, subject, body) => ({ threadId, recortes: ['ats'], fromName, address, subject, date, dateIso: `${date}T12:00:00.000Z`, body });

const EMAILS = [
  email('t1', '2026-09-20', 'Chartis Hiring Team', 'no-reply@ashbyhq.com', 'Application Update', 'Hi Rafael, thank you for applying to the Senior Data Platform Engineer role at Chartis. We received your application.'),
  email('t2', '2026-09-22', 'Chartis Hiring Team', 'no-reply@ashbyhq.com', 'Chartis | Senior Data Platform Engineer', 'Unfortunately we have decided not to move forward with your application at Chartis.'),
  email('t3', '2026-09-21', 'Catarina Cristo', 'catarina.cristo@itrtechgroup.com', 'Oportunidade DevSecOps', 'Olá Rafael, podemos conversar sobre a vaga de Technical Project Manager? Por favor responda até 26/09 com sua pretensão.'),
  email('t4', '2026-09-19', 'ALTAVE Carreiras', 'no-reply@gupy.io', 'Recebemos sua candidatura', 'Sua candidatura para Engineering Manager - IA na ALTAVE foi recebida.'),
  email('t5', '2026-09-18', 'Talent', 'jobs@umbrella.com', 'Your application', 'We received your application for Staff Product Manager at Umbrella.'),
  email('t6', '2026-09-17', 'Globex Careers', 'careers@globex.com', 'Update', 'We will not move forward with your Platform Engineer application at Globex.'),
  email('t7', '2026-09-16', 'Initech Recruiting', 'no-reply@lever.co', 'Thanks for applying', 'Thanks for applying to DevOps Engineer at Initech.'),
  email('t8', '2026-09-15', 'Daily Jobs', 'alerts@jobs.example', 'New jobs for you', 'Ten new DevOps roles near you.'),
];

// What Jev "answers" per e-mail subject: kind, action, the company it picks, and that pick's probability.
const VERDICTS = {
  'Application Update': { kind: 'confirmation', company: 'Chartis', p: 0.95 },
  'Chartis | Senior Data Platform Engineer': { kind: 'rejection', company: 'Chartis', p: 0.97 },
  'Oportunidade DevSecOps': { kind: 'recruiter_request', action: 'reply_to_recruiter', company: '?', p: 0.9 },
  'Recebemos sua candidatura': { kind: 'confirmation', company: 'ALTAVE', p: 0.93 },
  'Your application': { kind: 'confirmation', company: 'Umbrella', p: 0.6 },
  Update: { kind: 'rejection', company: 'Globex', p: 0.9 },
  'Thanks for applying': { kind: 'confirmation', company: 'Initech', p: 0.9 },
  'New jobs for you': { kind: 'not_job' },
};

function stubAsk() {
  const calls = [];
  const ask = async ({ state, questions }) => {
    const s = JSON.parse(state);
    calls.push({ s, questions });
    const v = VERDICTS[s.email.subject];
    const answers = {
      kind: { enabled: true, choice: v.kind, confidence: 0.95, probabilities: { [v.kind]: 0.95 } },
      action: { enabled: true, choice: v.action || 'none', confidence: 0.9, probabilities: { [v.action || 'none']: 0.9 } },
    };
    if (questions.match) {
      const hit = s.candidates.find((c) => c.company === v.company);
      const choice = hit ? hit.id : 'none';
      answers.match = { enabled: true, choice, confidence: v.p ?? 0.9, probabilities: { [choice]: v.p ?? 0.9 } };
    }
    return { enabled: true, usage: { input_tokens: 100, output_tokens: 10 }, answers };
  };
  ask.calls = calls;
  return ask;
}

// ── gog: safety flags, both searches, sanitized bodies ──────────────────
{
  const fake = path.join(tmp, 'fake-gog.mjs');
  fs.writeFileSync(fake, '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ argv: process.argv.slice(2) }));\n');
  fs.chmodSync(fake, 0o755);
  const res = await runGog('me@example.com', ['gmail', 'search', 'x'], { bin: fake });
  ok('runGog passes --account and every safety flag before the command',
    JSON.stringify(res.argv.slice(0, 2 + GOG_SAFETY_FLAGS.length)) === JSON.stringify(['--account', 'me@example.com', ...GOG_SAFETY_FLAGS]));
  ok('the safety flags are read-only, non-interactive, no-send, JSON, untrusted-wrapped',
    ['--readonly', '--no-input', '--gmail-no-send', '--json', '--wrap-untrusted'].every((f) => GOG_SAFETY_FLAGS.includes(f)));

  const calls = [];
  const wrap = (t) => `<<<EXTERNAL_UNTRUSTED_CONTENT id="x">>>\nSource: google_api\n---\n${t}\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id="x">>>`;
  const run = async (args) => {
    calls.push(args);
    if (args[1] === 'search') return args[2].includes('hit-reply@linkedin.com') ? { threads: [{ id: 'p1' }, { id: 'a1' }] } : { threads: [{ id: 'a1' }] };
    const id = args[3];
    return { thread: { messages: [
      { headers: { from: 'Recruiter <rec@corp.com>', subject: wrap(`Subject ${id}`) }, internalDate: '1790000000000', body: wrap('first') },
      { headers: { from: 'Me <me@example.com>', subject: wrap('Re') }, internalDate: '1790000100000', body: wrap('my reply') },
    ] } };
  };
  const { emails, searched } = await fetchEmails({ account: 'me@example.com', days: 40, run });
  const searches = calls.filter((c) => c[1] === 'search');
  ok('two searches run: the ATS one and the recruiter-as-person one',
    searches.length === 2 && searches.every((c) => c[2].startsWith('newer_than:40d ')) && searches.some((c) => c[2].includes('ashbyhq.com')));
  ok('a thread found by both searches is fetched once', calls.filter((c) => c[1] === 'thread').length === 2 && searched.threads === 2);
  ok('every thread body is fetched with --sanitize-content', calls.filter((c) => c[1] === 'thread').every((c) => c.includes('--sanitize-content')));
  const a1 = emails.find((e) => e.threadId === 'a1');
  ok('the latest message NOT sent by the account is the one judged, markers stripped',
    a1 && a1.address === 'rec@corp.com' && a1.body === 'first' && a1.subject === 'Subject a1');
  ok('a thread keeps which searches found it', a1 && a1.recortes.includes('ats') && a1.recortes.includes('person'));
}

// ── candidates: ATS sender, recruiter via ──────────────────────────────
{
  const { tracks } = makeTracks();
  const rows = allRows(tracks);
  const ats = candidatesFor(EMAILS[1], rows);
  ok('an ATS sender (no-reply@ashbyhq.com) still reaches the employer row in another track',
    ats[0]?.track === 'B' && ats[0]?.row.company === 'Chartis');
  ok('unrelated rows are not offered as candidates', ats.every((c) => c.row.company === 'Chartis'));
  const person = candidatesFor(EMAILS[2], rows);
  ok('a recruiter writing as a person reaches the row through its Via column',
    person.some((c) => c.row.num === 1004));
  ok('no row is offered for a job alert', candidatesFor(EMAILS[7], rows).length === 0);
}

// ── plan: transitions, refusals, review ────────────────────────────────
{
  const { tracks } = makeTracks();
  const rows = allRows(tracks);
  const ask = stubAsk();
  const { judgments } = await judgeEmails(EMAILS, rows, { ask });
  const plan = planReconciliation(judgments);
  const change = (num) => plan.changes.filter((c) => c.num === num);

  ok('e-mail text only travels in the Jev state, never in instructions or options',
    ask.calls.every(({ questions }) => !JSON.stringify(questions).includes('Chartis') && !JSON.stringify(questions).includes('Catarina')));
  const chartis = change(1003);
  ok('confirmation then rejection: Evaluated → Applied → Rejected, oldest first',
    chartis.length === 2 && chartis[0].before === 'Evaluated' && chartis[0].after === 'Applied' && chartis[1].before === 'Applied' && chartis[1].after === 'Rejected');
  ok('each change carries track, e-mail date and sender', chartis[1].track === 'B' && chartis[1].date === '2026-09-22' && chartis[1].from.includes('no-reply@ashbyhq.com'));
  ok('recruiter request moves an Evaluated row to Responded', change(1004)[0]?.after === 'Responded');
  ok('that refused confirmation is marked stale (old acknowledgment, no news)', plan.refused.find((r) => r.num === 11)?.stale === true);
  ok('a refused rejection on a Discarded row is not stale', plan.refused.find((r) => r.num === 12)?.stale === false);
  ok('recruiter request is listed with the deadline it states',
    plan.recruiterRequests.some((r) => r.threadId === 't3' && r.deadline === '2026-09-26'));
  ok('a confirmation on an Interview row is refused, not written (no downgrade)',
    change(11).length === 0 && plan.refused.some((r) => r.num === 11 && r.before === 'Interview' && r.after === 'Applied'));
  ok('a rejection on a Discarded row is refused (terminal)', change(12).length === 0 && plan.refused.some((r) => r.num === 12));
  ok('a confirmation on a SKIP row moves it to Applied', change(13)[0]?.before === 'SKIP' && change(13)[0]?.after === 'Applied');
  ok('match probability 0.6 (< 0.7) only goes to review',
    change(1005).length === 0 && plan.review.some((r) => r.threadId === 't5' && /0\.60 < 0\.7/.test(r.reason)));
  ok('not_job e-mails are dropped', ![...plan.changes, ...plan.review].some((x) => x.threadId === 't8'));
  ok('live processes list rows left Applied/Responded/Interview',
    plan.live.some((l) => l.num === 11 && l.status === 'Interview') && plan.live.some((l) => l.num === 1004 && l.status === 'Responded') && !plan.live.some((l) => l.num === 1003));
}

// ── pending actions: newest per sender, expired and closed rows dropped ─
{
  const j = (threadId, date, from, action, extra = {}) => ({
    email: email(threadId, date, from, `${from.toLowerCase()}@ats.example`, `Subject ${threadId}`, extra.body || 'Please complete the step.'),
    candidates: [], kind: extra.kind || 'incomplete', kindProb: 0.9, action, actionProb: 0.9, match: extra.match || null, matchProb: extra.match ? 0.9 : 0, error: null,
  });
  const closedRow = { track: 'A', row: { num: 7, company: 'Hooli', role: 'SRE', canonical: 'Applied' } };
  const plan = planReconciliation([
    j('p1', '2026-09-01', 'Screener', 'ai_interview'),
    j('p2', '2026-09-10', 'Screener', 'ai_interview'),
    j('p3', '2026-09-05', 'Tester', 'technical_assessment', { body: 'Complete the test by 2026-09-08.' }),
    j('p4', '2026-09-06', 'Hooli', 'technical_assessment', { match: closedRow }),
    j('p5', '2026-09-09', 'Hooli', 'none', { kind: 'rejection', match: closedRow }),
  ], { today: '2026-09-12' });
  const ids = plan.pendingActions.map((a) => a.threadId);
  ok('pending actions keep only the newest e-mail per sender and action', ids.includes('p2') && !ids.includes('p1'));
  ok('a pending action whose deadline passed is dropped', !ids.includes('p3'));
  ok('a pending action on a row that ends Rejected is dropped', !ids.includes('p4'));
}

// ── apply: backup, set-status write, idempotent re-run ─────────────────
{
  const { tracks, b } = makeTracks();
  const trackerB = path.join(b, 'data', 'applications.md');
  const before = fs.readFileSync(trackerB, 'utf8');
  const first = planReconciliation((await judgeEmails(EMAILS, allRows(tracks), { ask: stubAsk() })).judgments);
  const applied = applyChanges(first.changes, tracks, { stamp: 'test' });
  ok('every change is written through set-status', applied.results.length === first.changes.length && applied.results.every((r) => r.ok && r.changed));
  ok('each touched tracker is backed up before the first write',
    applied.backups.includes(`${fs.realpathSync(trackerB)}.bak-reconcile-email-test`) && fs.readFileSync(applied.backups.find((p) => p.includes('track-b')), 'utf8') === before);
  const after = fs.readFileSync(trackerB, 'utf8');
  const chartisLine = after.split('\n').find((l) => l.includes('| 1003 |'));
  ok('the row ends Rejected with dated notes of both e-mails',
    /\| Rejected \|/.test(chartisLine) && chartisLine.includes('application confirmed by e-mail on 2026-09-20') && chartisLine.includes('rejected by e-mail on 2026-09-22'));
  const log = fs.readFileSync(path.join(b, 'data', 'status-log.tsv'), 'utf8');
  ok('status-log records the transition on the e-mail date', log.includes('1003\t2026-09-22\tApplied\tRejected\treply-watch'));

  const second = planReconciliation((await judgeEmails(EMAILS, allRows(tracks), { ask: stubAsk() })).judgments);
  ok('a second run proposes no change', second.changes.length === 0);
  const again = applyChanges(first.changes.filter((c) => c.num === 1003).slice(-1), tracks, { stamp: 'again' });
  const lineAgain = fs.readFileSync(trackerB, 'utf8').split('\n').find((l) => l.includes('| 1003 |'));
  ok('re-applying the same change does not duplicate its note',
    again.results[0].ok && !again.results[0].changed && lineAgain.split('rejected by e-mail on 2026-09-22').length === 2);
}

// ── deadlines ──────────────────────────────────────────────────────────
ok('deadline: "até 26/09" → next 26 Sep', extractDeadline('Por favor responda até 26/09.', '2026-09-21') === '2026-09-26');
ok('deadline: "by September 30"', extractDeadline('Please complete the assessment by September 30.', '2026-09-21') === '2026-09-30');
ok('deadline: "within 3 days" counts from the e-mail', extractDeadline('Complete it within 3 days.', '2026-09-21') === '2026-09-24');
ok('deadline: "prazo de 48 horas"', extractDeadline('Você tem prazo de 48 horas para concluir.', '2026-09-21') === '2026-09-23');
ok('deadline: a date without a deadline cue is ignored', extractDeadline('Posted on 2026-09-01. Thanks.', '2026-09-21') === null);

rmSync(tmp, { recursive: true, force: true });
