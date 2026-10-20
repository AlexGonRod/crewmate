import { describe, expect, it } from 'vitest';
import { newId } from '../../src/core/ids';
import {
  normalizeReport,
  parseReportFromOutput,
  parseReportText,
  validateReport,
} from '../../src/protocol/report';

function validReport() {
  return {
    schema: 'crew.report/v1',
    task_id: newId('tsk'),
    run_id: newId('run'),
    status: 'done',
    summary: 'Finished the task',
    tests: [{ command: 'pnpm test', status: 'passed' }],
  };
}

describe('report protocol', () => {
  it('accepts a valid report', () => {
    const report = validateReport(validReport());
    expect(report.status).toBe('done');
  });

  it('rejects an incomplete report', () => {
    expect(() =>
      validateReport({
        schema: 'crew.report/v1',
        task_id: newId('tsk'),
        run_id: newId('run'),
        status: 'done',
      }),
    ).toThrow('Invalid agent report');
  });

  it('rejects an unknown status', () => {
    expect(() =>
      validateReport({
        ...validReport(),
        status: 'maybe',
      }),
    ).toThrow('Invalid agent report');
  });

  it('fills defaults before validation', () => {
    const taskId = newId('tsk');
    const runId = newId('run');
    const normalized = normalizeReport(
      {
        status: 'blocked',
        summary: 'Blocked externally',
      },
      { taskId, runId },
    );
    const report = validateReport(normalized);
    expect(report.task_id).toBe(taskId);
    expect(report.run_id).toBe(runId);
    expect(report.schema).toBe('crew.report/v1');
  });

  it('accepts a valid v2 report with acceptance evidence', () => {
    const report = validateReport({
      schema: 'crew.report/v2',
      task_id: newId('tsk'),
      run_id: newId('run'),
      methodology: 'spec',
      status: 'done',
      summary: 'Finished the task',
      acceptance: [
        { criterion_id: 'AC1', status: 'passed', evidence: 'test/example.test.ts' },
      ],
      tests: [{ command: 'pnpm test', status: 'passed' }],
    });
    expect(report.schema).toBe('crew.report/v2');
    expect(report.methodology).toBe('spec');
  });

  it('rejects a v2 report without methodology', () => {
    expect(() =>
      validateReport({
        schema: 'crew.report/v2',
        task_id: newId('tsk'),
        run_id: newId('run'),
        status: 'done',
        summary: 'Missing methodology',
      }),
    ).toThrow('Invalid agent report');
  });

  it('normalizes a report to v2 for spec tasks', () => {
    const taskId = newId('tsk');
    const runId = newId('run');
    const normalized = normalizeReport(
      {
        status: 'done',
        summary: 'Finished',
        acceptance: [],
      },
      { taskId, runId, methodology: 'spec' },
    ) as Record<string, unknown>;
    expect(normalized.schema).toBe('crew.report/v2');
    expect(normalized.methodology).toBe('spec');
  });

  it('accepts and normalizes a tester v3 report', () => {
    const taskId = newId('tsk');
    const runId = newId('run');
    const normalized = normalizeReport(
      {
        schema: 'crew.report/v3',
        task_id: taskId,
        run_id: runId,
        methodology: 'free',
        role: 'tester',
        verdict: 'approve',
        status: 'done',
        summary: 'Looks good',
      },
      { taskId, runId, role: 'tester', reviewIteration: 2, methodology: 'free' },
    );
    const report = validateReport(normalized);
    expect(report.role).toBe('tester');
    expect(report.verdict).toBe('approve');
    expect(report.review_iteration).toBe(2);
  });

  it('extracts the last fenced report block', () => {
    const report = validReport();
    const output = [
      'some output',
      '```crew-report',
      JSON.stringify({ ...report, status: 'failed' }),
      '```',
      '```crew-report',
      JSON.stringify(report),
      '```',
    ].join('\n');
    const parsed = parseReportFromOutput(output) as { status: string };
    expect(parsed.status).toBe('done');
  });

  it('reports malformed JSON clearly', () => {
    expect(() => parseReportText('{nope')).toThrow('Report is not valid JSON');
  });
});
