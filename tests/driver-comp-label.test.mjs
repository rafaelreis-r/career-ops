import { pass, fail } from './helpers.mjs';
import { matchAnswer, resolveFields } from '../web/scripts/arm1-salary.mjs';

console.log('\nArm 1 salary field semantics');

const desiredAnswer = {
  label: 'Desired Pay',
  value: 'USD 8000/month',
  kind: 'desired-compensation',
  currency: 'USD',
};
const answers = [
  desiredAnswer,
  { ...desiredAnswer, label: 'Desired Salary' },
  { ...desiredAnswer, label: 'Salary' },
  { ...desiredAnswer, label: 'Salary Expectation' },
  { ...desiredAnswer, label: 'Expected Salary' },
  { ...desiredAnswer, label: 'Compensation' },
  { ...desiredAnswer, label: 'Pretensão salarial' },
];
const refs = {
  commission: {
    role: 'textbox',
    name: '(FOR COMMISSIONED ROLES ONLY) What is your average monthly variable compensation or commission? (In reais).',
  },
  desired: {
    role: 'textbox',
    name: 'What are your salary expectations?',
  },
};
refs.reaisDesired = {
  role: 'textbox',
  name: 'What are your salary expectations? (in reais)',
};
refs.currentBase = {
  role: 'textbox',
  name: 'What is your current base salary? (in reais) ',
};
refs.expectedBase = {
  role: 'textbox',
  name: 'What is your expected base salary for this role? (in reais)',
};

const { matched, rejected } = resolveFields(refs, answers);
const commission = matched.find((field) => field.ref === 'commission');
const desired = matched.find((field) => field.ref === 'desired');
if (!commission) pass('Wellhub commissioned-role field refuses the USD desired-pay value');
else fail(`Wellhub commissioned-role field accepted ${commission.value}`);
if (desired?.value === desiredAnswer.value) pass('legitimate salary-expectation field accepts the desired-pay value');
else fail(`salary-expectation field resolved to ${JSON.stringify(desired?.value)}`);

const reaisDesired = matched.find((field) => field.ref === 'reaisDesired');
for (const [ref, reason, label] of [
  ['currentBase', 'incompatible-field-semantics', 'current salary'],
  ['expectedBase', 'currency-mismatch', 'Wellhub expected base salary in reais'],
]) {
  const field = matched.find((item) => item.ref === ref);
  if (!field && rejected.some((item) => item.ref === ref && item.reason === reason)) {
    pass(`${label} field stays blank under the USD-only canonical answer`);
  } else {
    fail(`${label} field was not guarded: ${JSON.stringify({ field, rejected })}`);
  }
}
if (!reaisDesired && rejected.some((field) => field.ref === 'reaisDesired' && field.reason === 'currency-mismatch')) {
  pass('USD desired-pay value is withheld from an explicit reais salary field');
} else {
  fail(`explicit reais salary field was not guarded: ${JSON.stringify({ reaisDesired, rejected })}`);
}

if (matchAnswer(refs.commission.name, answers) == null) pass('commission semantic guard returns no answer');
else fail('commission semantic guard should return no answer');

const reportCommission = {
  label: refs.commission.name,
  value: 'R$ 12.000',
};
const reportBrlSalary = {
  label: refs.reaisDesired.name,
  value: 'R$ 18.000',
};
const reportAnswers = [reportCommission, reportBrlSalary, ...answers];
if (matchAnswer(refs.commission.name, reportAnswers) === reportCommission.value) {
  pass('exact report answer survives the commission semantic guard');
} else {
  fail('commission semantic guard shadowed an exact report answer');
}
if (matchAnswer(refs.reaisDesired.name, reportAnswers) === reportBrlSalary.value) {
  pass('exact report answer survives the synthetic salary currency guard');
} else {
  fail('salary currency guard shadowed an exact report answer');
}
