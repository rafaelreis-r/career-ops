import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pass, fail, warn, ROOT } from './helpers.mjs';

console.log('\nArm 1 salary field semantics');

// Dynamic import behind existsSync: a checkout without web/ must skip, not
// crash at module load (#3269). A missing module under a present web/ is a
// move and fails.
const ARM1_SALARY = join(ROOT, 'web', 'scripts', 'arm1-salary.mjs');
if (!existsSync(join(ROOT, 'web', 'src'))) {
  warn('web/ not present in this checkout — skipping the Arm 1 salary checks');
} else if (!existsSync(ARM1_SALARY)) {
  fail('web/ exists but web/scripts/arm1-salary.mjs is missing — the Arm 1 salary checks cannot run (moved?)');
} else {
  const { matchAnswer, resolveFields } = await import(pathToFileURL(ARM1_SALARY).href);

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
}
