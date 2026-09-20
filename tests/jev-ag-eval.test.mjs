// tests/jev-ag-eval.test.mjs — the A-G evaluation as a Jev fan-out.
//
// Four things here can break silently and be noticed only much later, in a
// tracker full of wrong numbers, so each is pinned:
//
//   1. The SCORE_SUMMARY contract. Every driver parses it with its own regex
//      (batch-evaluate-gemini.mjs, openai-eval.mjs, gemini-eval.mjs,
//      eval-golden.mjs). A renamed key or a reordered block would leave the
//      fan-out "working" while every downstream consumer reads `unknown`.
//   2. The two-pass rule of modes/oferta.md § Block B. Importance must be
//      judged from the posting ALONE. It is enforced structurally here — the
//      pass-1 request has no CV in it — and a refactor that merged the passes
//      to save a round trip would silently invert the feature.
//   3. The importance gate: a requirement the posting does not state can never
//      be `critical` or `high`, because those bands are what create the
//      mandatory interview-prep obligations. A guessed band that trips that
//      threshold manufactures prep work out of speculation.
//   4. Never defaulting to Suspicious without evidence, and never letting a
//      Block A hard stop land above the apply line.

import { pass, fail } from './helpers.mjs';
import {
  IMPORTANCE_BANDS,
  REQUIREMENT_AXES,
  buildConstraintQuestions,
  buildCvState,
  buildJdState,
  buildPass1Questions,
  buildPass2Questions,
  composeEvaluation,
  composeLegitimacy,
  evaluateWithJevFanout,
  extractPostingIdentity,
  jevFanoutEnabled,
  renderReport,
  renderSummaryBlock,
  toFiveScale,
} from '../jev-ag-eval.mjs';

console.log('\njev-ag-eval.mjs — A-G evaluation as a Jev fan-out');

function ok(label, cond) {
  if (cond) pass(label);
  else fail(label);
}

const CV_MARKER = 'RAFAEL-CV-SENTINEL-STRING';
const JD = '---\ntitle: "Senior Site Reliability Engineer"\ncompany: "Braze"\n---\n\nKubernetes, Terraform, on-call rotation. Must have 5+ years.';

/** Build a full answer map at a fixed level, so a test can perturb one key. */
function answersAt({ dimension = 2, importance = 4, stated = 0.9, match = 2, gate = 0.05, signal = 0.9 } = {}) {
  const answers = {
    archetype: { enabled: true, choice: 'Platform / SRE / Infrastructure', confidence: 1, probabilities: null },
    dim_cv_match: { enabled: true, score: dimension, confidence: 0.8, probabilities: null },
    dim_north_star: { enabled: true, score: dimension, confidence: 0.8, probabilities: null },
    dim_comp: { enabled: true, score: dimension, confidence: 0.8, probabilities: null },
    dim_culture: { enabled: true, score: dimension, confidence: 0.8, probabilities: null },
    dim_red_flags: { enabled: true, score: dimension, confidence: 0.8, probabilities: null },
    gate_no_sponsorship: { enabled: true, probability: gate },
    gate_onsite_unworkable: { enabled: true, probability: gate },
    gate_language: { enabled: true, probability: gate },
    gate_comp_below_minimum: { enabled: true, probability: gate },
    gate_geo_mismatch: { enabled: true, probability: gate },
    g_tech_specificity: { enabled: true, probability: signal },
    g_scope_clarity: { enabled: true, probability: signal },
    g_requirements_realistic: { enabled: true, probability: signal },
    g_salary_transparency: { enabled: true, probability: 0.02 },
    g_boilerplate: { enabled: true, probability: 0.1 },
    g_contradictions: { enabled: true, probability: 0.1 },
    g_ghost_markers: { enabled: true, probability: 0.05 },
    g_employment_classification: { enabled: true, probability: 0.05 },
    g_prompt_injection: { enabled: true, probability: 0.02 },
  };
  for (const axis of REQUIREMENT_AXES) {
    answers[`imp_${axis.id}`] = { enabled: true, score: importance, confidence: 0.8, probabilities: null };
    answers[`stated_${axis.id}`] = { enabled: true, probability: stated };
    answers[`match_${axis.id}`] = { enabled: true, score: match, confidence: 0.8, probabilities: null };
  }
  return answers;
}

// --- 1. The machine-readable contract every driver parses --------------------

const evaluation = composeEvaluation(answersAt(), extractPostingIdentity(JD, 'https://example.com/jobs/1'));
const block = renderSummaryBlock(evaluation);

// The same regex + key extractor batch-evaluate-gemini.mjs uses on model output.
const summaryMatch = renderReport(evaluation, { url: 'https://example.com/jobs/1' })
  .match(/---SCORE_SUMMARY---\s*([\s\S]*?)---END_SUMMARY---/);
const extract = (key) => {
  const m = summaryMatch[1].match(new RegExp(`^\\s*${key}:\\s*(.+)$`, 'mi'));
  return m ? m[1].trim() : 'unknown';
};

ok('report carries a parseable SCORE_SUMMARY block', Boolean(summaryMatch));
ok('COMPANY comes from the posting, not a model retyping it', extract('COMPANY') === 'Braze');
ok('ROLE comes from the posting frontmatter', extract('ROLE') === 'Senior Site Reliability Engineer');
ok('SCORE parses as a 0-5 decimal', /^\d\.\d$/.test(extract('SCORE')) && Number(extract('SCORE')) <= 5);
ok('ARCHETYPE is the Choice answer', extract('ARCHETYPE') === 'Platform / SRE / Infrastructure');
ok('LEGITIMACY is one of the three tiers', ['High Confidence', 'Proceed with Caution', 'Suspicious'].includes(extract('LEGITIMACY')));
ok('block key order matches the prose contract', block.split('\n').slice(1, 6).map((l) => l.split(':')[0]).join(',') === 'COMPANY,ROLE,SCORE,ARCHETYPE,LEGITIMACY');

// openrouter-runner.mjs scrapes the score out of the report with its own regex,
// and takes the FIRST "score"-then-digits it finds.
const report = renderReport(evaluation, { url: null });
const runnerScore = report.match(/(?:score|puntuaci[oó]n)[^\d]*(\d+\.?\d*)/i);
ok('openrouter-runner score regex finds the global score first', runnerScore && parseFloat(runnerScore[1]) === evaluation.score);
ok('report carries the **Legitimacy:** line the runner copies', /\*\*Legitimacy:\*\*\s*\S/.test(report));

// --- 2. The two-pass rule is structural, not a promise -----------------------

const pass1 = buildPass1Questions();
const pass2 = buildPass2Questions();
const pass1State = buildJdState({ url: null, jdText: JD });
const cvState = buildCvState({ url: null, jdText: JD, cv: `Rafael Reis. ${CV_MARKER}` });

ok('pass-1 state contains the posting', pass1State.includes('Kubernetes'));
ok('pass-1 state contains no CV at all', !pass1State.includes(CV_MARKER) && !pass1State.includes('candidate_cv'));
ok('pass-2 CV state does carry the CV', cvState.includes(CV_MARKER));
ok('importance is asked only in pass 1', Object.keys(pass1).some((k) => k.startsWith('imp_')) && !Object.keys(pass2).some((k) => k.startsWith('imp_')));
ok('match is asked only in pass 2', Object.keys(pass2).some((k) => k.startsWith('match_')) && !Object.keys(pass1).some((k) => k.startsWith('match_')));
ok('the CV-match dimension is not asked against the JD-only state', !('dim_cv_match' in pass1) && !('dim_cv_match' in buildConstraintQuestions()));

// The ordering is also observable: pass 1 must be answered before any request
// carrying candidate data goes out.
const order = [];
const recordingAsk = async ({ state, questions }) => {
  order.push(state.includes(CV_MARKER) ? 'cv' : state.includes('candidate_constraints') ? 'constraints' : 'jd');
  const answers = {};
  const all = answersAt();
  for (const id of Object.keys(questions)) answers[id] = all[id];
  return { enabled: true, usage: { input_tokens: 10, output_tokens: 5 }, answers };
};
const fanout = await evaluateWithJevFanout({
  jdText: JD,
  profile: { country: 'Brazil' },
  cv: `Rafael Reis. ${CV_MARKER}`,
  ask: recordingAsk,
});
ok('fan-out composes a usable evaluation from typed answers', fanout.ok && typeof fanout.evaluation.score === 'number');
ok('the JD-only pass is requested first', order[0] === 'jd');
ok('the candidate passes both follow it', order.slice(1).sort().join(',') === 'constraints,cv');
ok('fan-out sums usage across passes', fanout.usage.total_tokens === 45);

// --- 3. The importance gate --------------------------------------------------

const unstated = composeEvaluation(answersAt({ importance: 4, stated: 0.05 }), { company: 'x', role: 'y' });
ok('an unstated requirement cannot hold critical or high', unstated.requirements.every((r) => !['critical', 'high'].includes(r.band)));
ok('an unstated requirement is labelled inferred', unstated.requirements.every((r) => r.tier === 'inferred'));

const statedCritical = composeEvaluation(answersAt({ importance: 4, stated: 0.95 }), { company: 'x', role: 'y' });
ok('a stated must-have keeps its critical band', statedCritical.requirements.every((r) => r.band === 'critical' && r.tier === 'stated'));
ok('bands only ever come from the published list', statedCritical.requirements.every((r) => IMPORTANCE_BANDS.includes(r.band)));

// Importance must not move the global score: modes/oferta.md § Score neutrality.
const lowImportance = composeEvaluation(answersAt({ importance: 0 }), { company: 'x', role: 'y' });
ok('importance does not move the global score', lowImportance.score === statedCritical.score);

// --- 4. Gates, caps and the never-guess rules --------------------------------

const gated = composeEvaluation(answersAt({ dimension: 4, gate: 0.95 }), { company: 'x', role: 'y' });
ok('a fired hard gate caps the score below the apply line', gated.score <= 2.5);
ok('a fired hard gate is surfaced as a warning', gated.warnings.some((w) => w.startsWith('Hard stop:')));

const clean = composeEvaluation(answersAt({ dimension: 4 }), { company: 'x', role: 'y' });
ok('no gate means no cap', clean.score > 2.5);
ok('a top ladder answer maps to 5.0, not 4.0', toFiveScale({ score: 4 }, 5) === 5);
ok('a bottom ladder answer maps to 1.0', toFiveScale({ score: 0 }, 5) === 1);
ok('an unusable Score answer is null, never a guessed default', toFiveScale({ score: null }, 5) === null);

const blind = composeLegitimacy({});
ok('no legitimacy evidence never means Suspicious', blind.tier === 'Proceed with Caution');
ok('missing signals render as not evaluated', blind.signals.every((s) => s.finding === '— not evaluated'));

const ghost = composeLegitimacy({ ...answersAt(), g_ghost_markers: { probability: 0.9 } });
ok('ghost markers reach Suspicious', ghost.tier === 'Suspicious');

// A posting with no salary is not a legitimacy concern: modes/_shared.md rates
// salary transparency Low reliability, "many legitimate reasons to omit".
const noSalary = composeLegitimacy(answersAt({ signal: 0.9 }));
ok('an unstated salary alone does not cost the High Confidence tier', noSalary.tier === 'High Confidence');

// Boilerplate is corroborating-only. Every posting on a large job board opens
// with culture copy; that is poor writing, not a ghost signal. It only counts
// where the posting has no technical substance behind it.
const boilerplateWithSubstance = composeLegitimacy({ ...answersAt(), g_boilerplate: { probability: 0.8 } });
ok('boilerplate over a specific JD keeps High Confidence', boilerplateWithSubstance.tier === 'High Confidence');
const hollow = composeLegitimacy({ ...answersAt(), g_boilerplate: { probability: 0.8 }, g_tech_specificity: { probability: 0.2 } });
ok('boilerplate with no technical substance reaches Caution', hollow.tier === 'Proceed with Caution');
const hollowAndContradictory = composeLegitimacy({
  ...answersAt(),
  g_boilerplate: { probability: 0.8 },
  g_tech_specificity: { probability: 0.2 },
  g_contradictions: { probability: 0.8 },
});
ok('a hollow, self-contradicting posting reaches Suspicious', hollowAndContradictory.tier === 'Suspicious');

// --- 5. The opt-in ------------------------------------------------------------

const hadKey = process.env.TYPESAFE_API_KEY;
delete process.env.TYPESAFE_API_KEY;
ok('no key means the fan-out never runs', jevFanoutEnabled() === false);
process.env.TYPESAFE_API_KEY = 'test-key';
ok('a key turns the fan-out on', jevFanoutEnabled() === true);
ok('--legacy-prose forces the prose path even with a key', jevFanoutEnabled({ legacyProse: true }) === false);
const disabled = await evaluateWithJevFanout({ jdText: JD, ask: async () => ({ enabled: false, answers: {} }) });
ok('a disabled client reports failure instead of composing a fake score', disabled.ok === false && /not enabled/.test(disabled.error));
const broken = await evaluateWithJevFanout({ jdText: JD, ask: async () => ({ enabled: true, error: 'Jev HTTP 500', answers: {} }) });
ok('a Jev error is reported so the caller can fall back', broken.ok === false && broken.error === 'Jev HTTP 500');
if (hadKey === undefined) delete process.env.TYPESAFE_API_KEY;
else process.env.TYPESAFE_API_KEY = hadKey;
