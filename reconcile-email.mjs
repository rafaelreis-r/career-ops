#!/usr/bin/env node

/**
 * reconcile-email.mjs — reconcile the trackers of every track with Gmail.
 *
 * Reads the last N days of job mail through `gog` (read-only, never sends),
 * has Jev classify each e-mail and pick the tracker row it is about among the
 * rows of ALL tracks listed in the shared trilhas.yml (lib/tracks.mjs), and
 * proposes forward-only status changes. Dry-run by default; --apply writes
 * them through set-status.mjs after backing up each touched tracker.
 * Pipeline and rules: lib/email-reconcile.mjs.
 *
 * Usage:
 *   node reconcile-email.mjs [--days 40] [--apply]
 *
 * Exit: 0 done · 1 usage, gog, Jev or tracker failure · 2 some writes failed.
 */

import fs from 'node:fs';
import path from 'node:path';
import * as yaml from 'js-yaml';
import { flagValue, hasFlag, safeIntFlag, validateFlags } from './lib/cli-flags.mjs';
import { isJevEnabled } from './lib/jev-client.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { assertTrackerScope, readTrackerRows, trackList } from './lib/tracks.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import {
  DEFAULT_DAYS, MATCH_THRESHOLD, applyChanges, fetchEmails, judgeEmails, planReconciliation,
} from './lib/email-reconcile.mjs';

const USAGE = `Usage: node reconcile-email.mjs [--days N] [--apply]

Reconciles data/applications.md of every track (shared trilhas.yml) with the
Gmail inbox. Dry-run by default: prints the proposed changes and writes nothing.

  --days N         Search window in days (default ${DEFAULT_DAYS})
  --apply          Write the changes (backs up each touched tracker first)
  --help, -h       This help

Needs gog authenticated for the account and TYPESAFE_API_KEY for Jev.
A change is written only when Jev's match probability is >= ${MATCH_THRESHOLD};
anything below goes to the review list.`;

/** candidate.email from the first track profile that has one. */
function profileAccount(tracks) {
  for (const t of tracks) {
    const file = path.join(t.root, 'config', 'profile.yml');
    if (!fs.existsSync(file)) continue;
    const email = yaml.load(fs.readFileSync(file, 'utf8'))?.candidate?.email;
    if (typeof email === 'string' && email.includes('@')) return email.trim();
  }
  return null;
}

const rowLabel = (c) => `${c.track} #${c.num} ${c.company} — ${c.role}`;
const emailLabel = (e) => `e-mail ${e.date} from ${e.from}`;

function printReport(report) {
  const { window, searched, jev, plan, applied } = report;
  const out = [];
  out.push(`Email reconciliation — ${window.days} days (since ${window.since}), account ${window.account}`);
  out.push(`Tracks: ${report.tracks.map((t) => `${t.id} (${t.rows} rows)`).join(', ')}`);
  out.push(`Gmail: ${searched.threads} threads (ATS search ${searched.ats}, person search ${searched.person}); Jev: ${jev.emails} e-mails, ${jev.input_tokens + jev.output_tokens} tokens, ${jev.seconds.toFixed(1)} s${jev.errors ? `, ${jev.errors} errors` : ''}`);
  out.push('');
  const section = (title, items, fmt) => {
    out.push(`${title} (${items.length})`);
    for (const it of items) out.push(`  ${fmt(it)}`);
    if (!items.length) out.push('  none');
    out.push('');
  };
  if (applied) {
    section('Changes applied', applied.results, (r) => `${r.ok ? (r.changed ? 'written' : 'already current') : `FAILED: ${r.error}`} · ${rowLabel(r)}: ${r.before} → ${r.after} · ${emailLabel(r)}`);
    if (applied.backups.length) out.push(`Backups: ${applied.backups.join(', ')}`, '');
  } else {
    section('Proposed changes (dry-run; --apply writes them)', plan.changes, (c) => `${rowLabel(c)}: ${c.before} → ${c.after} · ${emailLabel(c)} · "${c.subject}"`);
  }
  section('Recruiter requests', plan.recruiterRequests, (r) => `${r.date} ${r.from} · "${r.subject}"${r.row ? ` · ${rowLabel(r.row)}` : ''} · deadline ${r.deadline ?? 'none stated'}`);
  section('Pending actions', plan.pendingActions, (a) => `${a.action} · deadline ${a.deadline ?? 'none stated'} · ${a.date} ${a.from} · "${a.subject}"${a.row ? ` · ${rowLabel(a.row)}` : ''}`);
  section('Live processes', plan.live, (l) => `${rowLabel(l)}: ${l.status} · last e-mail ${l.lastEmail} (${l.lastKind})`);
  const stale = plan.refused.filter((r) => r.stale).length;
  section(`Refused (would move a row backwards; ${stale} stale ones not listed)`, plan.refused.filter((r) => !r.stale), (r) => `${rowLabel(r)}: ${r.reason} · ${r.kind} ${emailLabel(r)} · "${r.subject}"`);
  section(`Review (not written: match below ${MATCH_THRESHOLD}, no row, changed status, or error)`, [...plan.review, ...(applied?.review || [])], (r) => `${r.kind ?? '?'} · ${r.reason}${r.row ? ` · best row ${rowLabel(r.row)}` : ''} · ${emailLabel(r)} · "${r.subject}"`);
  console.log(out.join('\n'));
}

async function main(argv) {
  validateFlags(argv, ['--days', '--apply', '--help', '-h'], USAGE, { valueFlags: ['--days'], requireOperand: true });
  const days = safeIntFlag(flagValue(argv, '--days'), DEFAULT_DAYS);
  if (hasFlag(argv, '--days') && days < 1) {
    console.error('Error: --days expects a positive integer');
    return 1;
  }
  const apply = hasFlag(argv, '--apply');
  const tracks = trackList(getCareerOpsRoot());
  assertTrackerScope(tracks);
  const rows = [];
  const trackInfo = [];
  for (const t of tracks) {
    const { rows: trackRows } = readTrackerRows(t.root);
    trackInfo.push({ id: t.id, root: t.root, rows: trackRows.length });
    for (const row of trackRows) rows.push({ track: t.id, row });
  }
  const withRows = trackInfo.filter((t) => t.rows > 0);
  if (!withRows.length) {
    console.error('Error: no tracker rows found in any track (data/applications.md)');
    return 1;
  }

  const account = profileAccount(tracks);
  if (!account) {
    console.error('Error: no Gmail account: set candidate.email in config/profile.yml');
    return 1;
  }
  if (!isJevEnabled()) {
    console.error('Error: TYPESAFE_API_KEY is not set; the reconciliation needs Jev to classify and match e-mails');
    return 1;
  }

  const { emails, searched } = await fetchEmails({ account, days });
  const started = Date.now();
  const { judgments, usage, errors } = await judgeEmails(emails, rows);
  const seconds = (Date.now() - started) / 1000;
  const plan = planReconciliation(judgments);
  const applied = apply && plan.changes.length ? applyChanges(plan.changes, tracks) : apply ? { backups: [], results: [] } : null;

  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const report = {
    window: { days, since, account },
    tracks: withRows.map(({ id, rows: n }) => ({ id, rows: n })),
    searched,
    jev: { emails: judgments.length, ...usage, seconds, errors },
    dryRun: !apply,
    plan,
    applied,
  };
  printReport(report);
  return applied?.results.some((r) => !r.ok) ? 2 : 0;
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (err) => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
}

export { main };
