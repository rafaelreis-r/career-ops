import { pass, fail } from './helpers.mjs';
import { matchAnswer, resolveFields } from '../web/scripts/arm1-salary.mjs';

console.log('\nArm 1 salary field semantics');

const commissionField = '(FOR COMMISSIONED ROLES ONLY) What is your average monthly variable compensation or commission? (In reais).';
const desiredAnswer = {
  label: 'Compensation',
  value: 'USD 8000/month',
  kind: 'desired-compensation',
};

if (matchAnswer(commissionField, [desiredAnswer]) == null) {
  pass('Wellhub commission field refuses synthetic desired compensation');
} else {
  fail('Wellhub commission field accepted synthetic desired compensation');
}

const desiredCompensation = { ...desiredAnswer, label: 'Desired Compensation' };
const resolved = resolveFields({
  desired: { role: 'textbox', name: 'Desired Compensation' },
}, [desiredCompensation]);
if (resolved[0]?.value === desiredAnswer.value) {
  pass('Desired Compensation keeps the synthetic salary answer');
} else {
  fail(`Desired Compensation resolved to ${JSON.stringify(resolved[0]?.value)}`);
}

const reportCommission = {
  label: commissionField,
  value: 'R$ 12.000',
};
if (matchAnswer(commissionField, [reportCommission, desiredAnswer]) === reportCommission.value) {
  pass('exact report answer survives the commission guard');
} else {
  fail('commission guard shadowed an exact report answer');
}
