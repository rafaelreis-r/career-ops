import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { applyPlan, parseIdMap, planTrack, writePlan } from '../renumber-ids.mjs';
import { rmSync } from './helpers.mjs';

// Track A uses #25, #56, #222, #264, #333, #444, #555, #600, #614, #728 and
// #1014, so every colour, issue number and slug number below is also a number
// of the track. Each fixture file is the minimal copy of a case that the first
// real migration got wrong.
const ROWS = [25, 56, 64, 222, 264, 333, 444, 555, 600, 614, 728, 1014, 1872];
const TRACKER = [
  '| # | Date | Company | Via | Role | Score | Status | PDF | Report | Notes |',
  '|---|------|---------|-----|------|-------|--------|-----|--------|-------|',
  ...ROWS.map((n) => `| ${n} | 2026-08-04 | ${n === 64 ? 'Acme' : `Co${n}`} | — | SRE | 3.0/5 | Applied | ✅ | [${String(n).padStart(3, '0')}](../reports/${String(n).padStart(3, '0')}-${n === 64 ? 'acme' : `co${n}`}-2026-08-04.md) | |`),
  '',
].join('\n');

function write(root, rel, content) {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), content);
}

const CV_HTML = [
  '<!DOCTYPE html>',
  '<html><head>',
  '<!-- Template notes: see #264 for the layout bug,',
  '     and #614 in the multi-line comment -->',
  '<style>',
  '  body { color: #333; border: 1px solid #444; background: #100333; }',
  '  /* #555 */ h1 { color: #222 }',
  '</style>',
  '</head>',
  '<body style="background:#555" bgcolor=#444>',
  '<svg><rect fill="#222" stroke=\'#333\'/></svg>',
  '<p title="job #614">CV for #056 and #614 (report reports/614-co614-2026-08-04.md)</p>',
  '<script>var x = "<!-- #333"; // not a comment</script>',
  '<p>after the script: #056</p>',
  '</body></html>',
  '',
].join('\n');

function trackA(dir) {
  const root = join(dir, 'A');
  write(root, 'data/applications.md', TRACKER);
  for (const n of ROWS) write(root, `reports/${String(n).padStart(3, '0')}-${n === 64 ? 'acme' : `co${n}`}-2026-08-04.md`, `# Co${n}\n`);
  write(root, 'output/cv-candidate-acme.html', CV_HTML);
  write(root, 'data/notes.md', 'Compare with #1014 B and #056 A, then #056, then #1014 C.\n- the one for #614 in B? ask #614 B\n');
  write(root, 'output/cv-rafael-reis-ethos-infra-80-hr-up-to-1-600-week-614-2026-09-22.html', '<p>x</p>\n');
  write(root, 'output/cv-rafael-reis-ethos-infra-80-hr-up-to-1-600-week-614-2026-09-22.pdf', 'pdf');
  write(root, 'output/cv-rafael-reis-ethos-sre-up-to-1-600-week-2026-09-22.pdf', 'pdf');
  write(root, 'output/cv-candidate-acme-614.html', '<p>y</p>\n');
  write(root, 'output/cv-candidate-acme-614.results.json', '{}\n');
  write(root, 'data/outputs.md', [
    'PDF: output/cv-rafael-reis-ethos-infra-80-hr-up-to-1-600-week-614-2026-09-22.pdf',
    'Other: output/cv-rafael-reis-ethos-sre-up-to-1-600-week-2026-09-22.pdf',
    '',
  ].join('\n'));
  write(root, 'jds/056-co56.md', 'jd\n');
  write(root, 'jds/64-acme.md', 'jd\n');
  write(root, 'jds/728-co728-devops-brazil.md', 'jd\n');
  write(root, 'jds/99-product-ops-manager-6f11c6f8c4.md', 'jd\n');
  write(root, 'jds/7-brew-coffee-ops.md', 'jd\n');
  write(root, 'jds/1872-consulting-ops.md', 'jd\n');
  write(root, 'data/jd-refs.md', 'See jds/99-product-ops-manager-6f11c6f8c4.md and jds/64-acme.md and jds/728-co728-devops-brazil.md and jds/1872-consulting-ops.md and [#1872](jds/1872-consulting-ops.md)\n');
  return root;
}

function treeOf(root) {
  const out = {};
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const rel = relative(root, full).split(sep).join('/');
      if (lstatSync(full).isDirectory()) { out[`${rel}/`] = 'dir'; walk(full); } else out[rel] = readFileSync(full).toString('base64');
    }
  };
  walk(root);
  return out;
}

async function migrate(t) {
  const dir = mkdtempSync(join(tmpdir(), 'renumber-fp-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = trackA(dir);
  const before = treeOf(root);
  const out = join(dir, 'plan');
  const plan = planTrack({ root, track: 'A', base: 100000 });
  assert.deepEqual(plan.errors, []);
  writePlan(plan, out);
  await applyPlan(join(out, 'plan.json'));
  const read = (rel) => readFileSync(join(root, rel), 'utf8');
  return { dir, root, before, out, read };
}

test('F1/F2: colours, style attributes and HTML comments keep their #NNN', async (t) => {
  const { read } = await migrate(t);
  assert.equal(read('output/cv-candidate-acme.html'), CV_HTML
    .replace('title="job #614">CV for #056 and #614', 'title="job #100614">CV for #100056 and #100614')
    .replace('reports/614-co614', 'reports/100614-co614')
    .replace('after the script: #056', 'after the script: #100056'));
});

test('F3: #NNN followed by another track\'s letter stays', async (t) => {
  const { read } = await migrate(t);
  assert.equal(read('data/notes.md'),
    'Compare with #1014 B and #100056 A, then #100056, then #1014 C.\n- the one for #100614 in B? ask #614 B\n');
});

test('F4: only the vacancy number of an output name moves, not a number inside the slug', async (t) => {
  const { root, read } = await migrate(t);
  const out = readdirSync(join(root, 'output')).sort();
  assert.deepEqual(out, [
    'cv-candidate-acme-100614.html',
    'cv-candidate-acme-100614.results.json',
    'cv-candidate-acme.html',
    'cv-rafael-reis-ethos-infra-80-hr-up-to-1-600-week-100614-2026-09-22.html',
    'cv-rafael-reis-ethos-infra-80-hr-up-to-1-600-week-100614-2026-09-22.pdf',
    'cv-rafael-reis-ethos-sre-up-to-1-600-week-2026-09-22.pdf',
  ]);
  assert.equal(read('data/outputs.md'), [
    'PDF: output/cv-rafael-reis-ethos-infra-80-hr-up-to-1-600-week-100614-2026-09-22.pdf',
    'Other: output/cv-rafael-reis-ethos-sre-up-to-1-600-week-2026-09-22.pdf',
    '',
  ].join('\n'));
});

test('F5: a JD moves only when its prefix and company match a track vacancy', async (t) => {
  const { root, read, out } = await migrate(t);
  assert.deepEqual(readdirSync(join(root, 'jds')).sort(), [
    '100056-co56.md',
    '100064-acme.md',
    '100728-co728-devops-brazil.md',
    '1872-consulting-ops.md',
    '7-brew-coffee-ops.md',
    '99-product-ops-manager-6f11c6f8c4.md',
  ]);
  assert.equal(read('data/jd-refs.md'),
    'See jds/99-product-ops-manager-6f11c6f8c4.md and jds/100064-acme.md and jds/100728-co728-devops-brazil.md and jds/1872-consulting-ops.md and [#1872](jds/1872-consulting-ops.md)\n');
  const pending = JSON.parse(readFileSync(join(out, 'manual-pending.json'), 'utf8'));
  assert.ok(pending.some((entry) => entry.file === 'jds/1872-consulting-ops.md' && entry.token === '1872'));
});

test('reverse of the migration restores every byte, false-positive cases included', async (t) => {
  const { dir, root, before, out } = await migrate(t);
  assert.notDeepEqual(treeOf(root), before);
  const idMapRows = parseIdMap(readFileSync(join(out, 'id-map.tsv'), 'utf8'));
  assert.ok(!idMapRows.some((r) => r.antigo === '99' || r.antigo === '7'), 'unmatched JD company numbers are not in the id-map');
  const back = planTrack({ root, reverse: true, idMapRows });
  assert.deepEqual(back.errors, []);
  writePlan(back, join(dir, 'reverse'));
  await applyPlan(join(dir, 'reverse', 'plan.json'));
  assert.deepEqual(treeOf(root), before);
  assert.ok(existsSync(join(root, 'jds/99-product-ops-manager-6f11c6f8c4.md')));
});
