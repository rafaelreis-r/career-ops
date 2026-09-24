// tests/eval-queue.test.mjs — the forwarding gate in front of the long evaluation.
//
// rank-pipeline.mjs only annotates; eval-queue.mjs decides what reaches the
// expensive A-G evaluation. The properties pinned here:
//
//   1. Every pending row lands on exactly one side, with a reason.
//   2. Already-evaluated postings (report `**URL:**` header or tracker) never
//      re-enter the queue, whatever URL spelling they come back under.
//   3. An unranked row waits; it is not forwarded and not dropped.
//   4. --force overrides the cutoff and a missing rank, nothing else.
//   5. The queue file grows with ids that cannot collide with batch state, and
//      pipeline.md is never written.
import { pass, fail, ROOT, NODE, rmSync } from './helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';

console.log('\neval-queue — cal-v1 forwarding gate');

const check = (label, cond) => (cond ? pass(label) : fail(label));

try {
  const {
    planQueue, parsePendingRows, collectEvaluated, parseBatchRows,
    parseForwardThreshold, loadForwardThreshold, formatBatchRows,
  } = await import(pathToFileURL(join(ROOT, 'eval-queue.mjs')).href);

  const pipeline = [
    '## Pending',
    '- [ ] https://x.test/high | Acme | SRE | rank: cal-v1 3.2/5 — strong',
    '- [ ] https://x.test/edge | Beta | SRE | rank: cal-v1 2.5/5 — at the cutoff',
    '- [ ] https://x.test/low | Gamma | SRE | rank: cal-v1 2.1/5 — weak',
    '- [ ] https://x.test/unranked | Delta | SRE',
    '- [ ] https://x.test/legacy | Eps | SRE | rank: 4.8/5 — pre-calibration',
    '- [ ] https://www.linkedin.com/comm/jobs/view/4460239794/?trackingId=a%3D&trk=eml-x | Zeta | SRE | rank: cal-v1 5.0/5 — top',
    '- [ ] https://x.test/high?utm_source=digest | Acme | SRE | rank: cal-v1 3.2/5 — same posting again',
    '- [ ] https://x.test/queued | Eta | SRE | rank: cal-v1 4.0/5 — queued earlier',
    '- [ ] https://x.test/tracked | Theta | SRE | rank: cal-v1 4.0/5 — tracked',
    '- [ ] local:jds/iota-sre.md | Iota | SRE | rank: cal-v1 2.8/5 — archived JD',
    '- [x] #12 | https://x.test/done | Kappa | SRE | 3.9/5 | PDF ✅',
    '',
    '## Processed',
  ].join('\n');
  const rows = parsePendingRows(pipeline);
  const evaluated = collectEvaluated({
    applicationsText: '| 1 | 2026-09-01 | Theta | SRE | 3.0/5 | Evaluated | ❌ | — | https://x.test/tracked |',
    reports: [
      { name: '3025-zeta-2026-09-23.md', text: '# Zeta\n\n**URL:** https://br.linkedin.com/jobs/view/sre-at-zeta-4460239794?trk=public_jobs\n' },
      { name: '3026-no-url.md', text: '# No header\n' },
    ],
  });
  const queued = parseBatchRows('id\turl\tsource\tnotes\n7\thttps://x.test/queued\tmanual\t\n').byKey;
  const plan = planQueue({ rows, threshold: 2.5, evaluated, queued });
  const reasonFor = url => [...plan.forwarded, ...plan.held].find(r => r.url === url)?.reason ?? '';
  const forwardedUrls = plan.forwarded.map(r => r.url);

  check('only [ ] rows are considered', rows.length === 10);
  check('every pending row lands on exactly one side',
    plan.forwarded.length + plan.held.length === rows.length);
  check('a rank at or above the cutoff is forwarded',
    forwardedUrls.includes('https://x.test/high') && forwardedUrls.includes('https://x.test/edge'));
  check('a rank below the cutoff is held with its score',
    reasonFor('https://x.test/low') === 'cal-v1 2.1 below cutoff 2.5');
  check('an unranked row waits for the daily rank run',
    /no cal-v1 rank yet/.test(reasonFor('https://x.test/unranked')));
  check('a pre-calibration rank counts as unranked',
    /no cal-v1 rank yet/.test(reasonFor('https://x.test/legacy')));
  check('a LinkedIn tracking URL matches the report of the same job id',
    reasonFor('https://www.linkedin.com/comm/jobs/view/4460239794/?trackingId=a%3D&trk=eml-x')
      === 'already evaluated (reports/3025-zeta-2026-09-23.md)');
  check('a URL already in the tracker is held',
    reasonFor('https://x.test/tracked') === 'already evaluated (the tracker)');
  check('a URL already in batch-input.tsv is held',
    reasonFor('https://x.test/queued') === 'already queued (batch-input id 7)');
  check('a second spelling of a pending posting is held as a duplicate',
    reasonFor('https://x.test/high?utm_source=digest') === 'duplicate of pipeline.md line 2');
  check('forwarded rows come out highest rank first',
    forwardedUrls.join(' ') === 'https://x.test/high local:jds/iota-sre.md https://x.test/edge');
  const duplicateRows = parsePendingRows([
    '- [ ] https://www.linkedin.com/comm/jobs/view/4460239795/?trk=old | Acme | SRE',
    '- [ ] https://www.linkedin.com/jobs/view/4460239795 | Acme | SRE | rank: cal-v1 3.2/5',
  ].join('\n'));
  const duplicatePlan = planQueue({ rows: duplicateRows, threshold: 2.5, evaluated: new Map(), queued: new Map() });
  check('the highest-ranked duplicate represents a posting',
    duplicatePlan.forwarded.length === 1 && duplicatePlan.forwarded[0].rank === 3.2
      && duplicatePlan.held[0].reason === 'duplicate of pipeline.md line 2');

  const forced = planQueue({
    rows, threshold: 2.5, evaluated, queued,
    force: ['https://x.test/low', 'https://x.test/unranked', 'https://x.test/tracked', 'https://x.test/absent'],
  });
  const forcedReason = url => [...forced.forwarded, ...forced.held].find(r => r.url === url)?.reason ?? '';
  check('--force forwards a row below the cutoff and says so',
    forcedReason('https://x.test/low') === 'forced: cal-v1 2.1 below cutoff 2.5');
  check('--force forwards an unranked row',
    forcedReason('https://x.test/unranked') === 'forced: no cal-v1 rank');
  check('--force does not re-queue an evaluated posting',
    /^already evaluated/.test(forcedReason('https://x.test/tracked')));
  check('--force naming no pending row is reported',
    forced.unknownForce.length === 1 && forced.unknownForce[0] === 'https://x.test/absent');

  check('a blank cutoff means "not configured"', [undefined, null, '', '  '].every(v => parseForwardThreshold(v, 't') === null));
  check('a numeric-string cutoff parses', parseForwardThreshold('3.0', 't') === 3);
  for (const bad of ['abc', '-0.1', '5.1', '3,0']) {
    let threw = false;
    try { parseForwardThreshold(bad, 't'); } catch { threw = true; }
    check(`an invalid cutoff "${bad}" is rejected`, threw);
  }

  const lines = formatBatchRows(plan.forwarded, 8);
  check('batch rows are numbered from the first free id', lines.map(l => l.split('\t')[0]).join(',') === '8,9,10');
  check('a local: JD is handed to the runner as jd=<path>',
    lines[1].split('\t')[3].startsWith('jd=jds/iota-sre.md '));

  // ── end to end: config, write path, ids, pipeline.md untouched ──
  const root = mkdtempSync(join(tmpdir(), 'career-ops-eval-queue-'));
  const repoBatchInput = join(ROOT, 'batch', 'batch-input.tsv');
  const previousBatchInput = existsSync(repoBatchInput) ? readFileSync(repoBatchInput, 'utf8') : null;
  try {
    mkdirSync(join(root, 'data'));
    mkdirSync(join(root, 'config'));
    mkdirSync(join(root, 'reports'));
    mkdirSync(join(root, 'batch'));
    const pipelinePath = join(root, 'data', 'pipeline.md');
    writeFileSync(pipelinePath, pipeline);
    writeFileSync(join(root, 'data', 'applications.md'), '# Applications\n');
    writeFileSync(join(root, 'reports', '3025-zeta-2026-09-23.md'), '**URL:** https://www.linkedin.com/jobs/view/4460239794\n');
    writeFileSync(join(root, 'config', 'profile.yml'), 'rank_forward_threshold: 3.0\n');
    const run = (...args) => execFileSync(NODE, [join(ROOT, 'eval-queue.mjs'), ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CAREER_OPS_ROOT: root },
    });

    check('config/profile.yml sets the cutoff', loadForwardThreshold(join(root, 'config', 'profile.yml')) === 3);
    check('an absent profile falls back to 2.5', loadForwardThreshold(join(root, 'config', 'missing.yml')) === 2.5);

    const dry = run('--dry-run');
    check('the configured cutoff reaches the plan',
      dry.includes('Forwarding cutoff: cal-v1 >= 3.0')
        && dry.includes('Forwarded to the long evaluation (3):'));
    check('--dry-run leaves the queue file untouched',
      previousBatchInput === null ? !existsSync(repoBatchInput) : readFileSync(repoBatchInput, 'utf8') === previousBatchInput);

    const out = run('--force', 'https://x.test/low');
    const queueText = readFileSync(repoBatchInput, 'utf8');
    const queue = queueText.trim().split('\n');
    check('a fresh queue file gets the runner header', queue[0] === 'id\turl\tsource\tnotes');
    check('ids start at the first free id', queue[1].startsWith('1\t'));
    check('the queue holds exactly the forwarded rows',
      queue.slice(1).map(l => l.split('\t')[1]).join(' ')
        === 'https://x.test/queued https://x.test/tracked https://x.test/high https://x.test/low');
    check('the printed plan names both sides', /Forwarded to the long evaluation \(4\)/.test(out) && /Held \(6\)/.test(out));
    check('pipeline.md is never written', readFileSync(pipelinePath, 'utf8') === pipeline);

    const again = run('--dry-run');
    check('a second run holds what the first one queued',
      again.includes('Forwarded to the long evaluation (0)') && (again.match(/already queued/g) ?? []).length === 4);

    let status = 0;
    try { run('--dry-run', '--force', 'https://x.test/absent'); } catch (err) { status = err.status; }
    check('--force naming no pending row exits non-zero', status === 2);
    writeFileSync(join(root, 'config', 'profile.yml'), 'rank_forward_threshold: high\n');
    status = 0;
    try { run('--dry-run'); } catch (err) { status = err.status; }
    check('an invalid profile cutoff exits non-zero', status === 2);
  } finally {
    if (previousBatchInput === null) rmSync(repoBatchInput, { force: true });
    else writeFileSync(repoBatchInput, previousBatchInput);
    rmSync(root, { recursive: true, force: true });
  }
} catch (err) {
  fail(`eval-queue test suite threw: ${err?.stack ?? err}`);
}
