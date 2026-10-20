import { CrewError } from '../core/errors';
import type { AgentRole, ReportPayload, Task } from '../core/types';

export function assertReportMeetsMethodology(
  payload: ReportPayload,
  task: Task,
  role: AgentRole = 'developer',
): void {
  if (payload.schema === 'crew.report/v3') {
    if (payload.role !== role) {
      throw new CrewError(
        'REPORT_ROLE_MISMATCH',
        `Report role ${payload.role ?? 'missing'} does not match run role ${role}`,
      );
    }
    if (role === 'tester') {
      if (payload.verdict === undefined) {
        throw new CrewError(
          'REPORT_VERDICT_REQUIRED',
          'A tester report must include verdict "approve" or "reject"',
        );
      }
      if (payload.verdict === 'approve' && payload.status !== 'done') {
        throw new CrewError(
          'REPORT_VERDICT_INVALID',
          'An approve verdict requires status "done"',
        );
      }
      if (payload.verdict === 'reject' && payload.status !== 'failed') {
        throw new CrewError(
          'REPORT_VERDICT_INVALID',
          'A reject verdict requires status "failed"',
        );
      }
    }
  } else if (role === 'tester') {
    throw new CrewError(
      'REPORT_SCHEMA_REQUIRED',
      'Tester reports require a crew.report/v3 report',
    );
  }

  if (
    (payload.schema === 'crew.report/v2' || payload.schema === 'crew.report/v3') &&
    payload.methodology !== undefined &&
    payload.methodology !== task.methodology
  ) {
    throw new CrewError(
      'REPORT_METHODOLOGY_MISMATCH',
      `Report methodology ${payload.methodology} does not match task methodology ${task.methodology}`,
    );
  }

  if (task.methodology === 'free' || role === 'tester') {
    return;
  }

  if (payload.schema === 'crew.report/v1' || payload.schema === 'crew.report/v2') {
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
