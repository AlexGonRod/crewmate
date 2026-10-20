import { CrewError } from '../core/errors';
import type { ReportPayload, Task } from '../core/types';

export function assertReportMeetsMethodology(payload: ReportPayload, task: Task): void {
  if (payload.schema === 'crew.report/v2' && payload.methodology !== undefined) {
    if (payload.methodology !== task.methodology) {
      throw new CrewError(
        'REPORT_METHODOLOGY_MISMATCH',
        `Report methodology ${payload.methodology} does not match task methodology ${task.methodology}`,
      );
    }
  }

  if (task.methodology === 'free') {
    return;
  }

  if (payload.schema !== 'crew.report/v2') {
    throw new CrewError(
      'REPORT_SCHEMA_REQUIRED',
      `The ${task.methodology} methodology requires a crew.report/v2 report`,
    );
  }

  if (!payload.methodology) {
    throw new CrewError(
      'REPORT_METHODOLOGY_REQUIRED',
      `A crew.report/v2 report must declare methodology "${task.methodology}"`,
    );
  }

  if (payload.status !== 'done') {
    return;
  }

  const spec = task.spec;
  if (!spec) {
    throw new CrewError(
      'SPEC_REQUIRED',
      `Task ${task.id} uses the ${task.methodology} methodology but has no spec`,
    );
  }

  const evidence = new Map(
    (payload.acceptance ?? []).map((item) => [item.criterion_id, item]),
  );
  const missing = spec.acceptance_criteria
    .filter((criterion) => evidence.get(criterion.id)?.status !== 'passed')
    .map((criterion) => criterion.id);
  if (missing.length > 0) {
    throw new CrewError(
      'REPORT_INCOMPLETE',
      `Missing acceptance evidence for: ${missing.join(', ')}`,
    );
  }

  if (task.methodology === 'tdd') {
    const phases = new Set((payload.tests ?? []).map((test) => test.phase));
    const missingPhases: string[] = [];
    if (!phases.has('red')) {
      missingPhases.push('red');
    }
    if (!phases.has('green')) {
      missingPhases.push('green');
    }
    if (missingPhases.length > 0) {
      throw new CrewError(
        'REPORT_INCOMPLETE',
        `TDD reports require test evidence for phases: ${missingPhases.join(', ')}`,
      );
    }
  }
}
