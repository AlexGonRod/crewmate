import { existsSync, readFileSync } from 'node:fs';
import Ajv, { type ValidateFunction } from 'ajv';
import { CrewError } from '../core/errors';
import type { Methodology, ReportPayload } from '../core/types';

function schemaUrl(name: string): URL {
  const direct = new URL(`../../contracts/${name}`, import.meta.url);
  if (existsSync(direct)) {
    return direct;
  }
  return new URL(`../../../contracts/${name}`, import.meta.url);
}

function loadSchema(name: string): object {
  const url = schemaUrl(name);
  if (!existsSync(url)) {
    throw new CrewError('SCHEMA_NOT_FOUND', `Contract schema not found: ${url.pathname}`);
  }
  return JSON.parse(readFileSync(url, 'utf8')) as object;
}

const ajv = new Ajv({ allErrors: true, strict: false });
const validateReportV1: ValidateFunction = ajv.compile(loadSchema('report.v1.schema.json'));
const validateReportV2: ValidateFunction = ajv.compile(loadSchema('report.v2.schema.json'));

export function validateReport(raw: unknown): ReportPayload {
  const schema =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).schema
      : undefined;
  const validate =
    schema === 'crew.report/v2'
      ? validateReportV2
      : schema === 'crew.report/v1' || schema === undefined
        ? validateReportV1
        : null;
  if (!validate) {
    throw new CrewError('REPORT_INVALID', `Unsupported report schema: ${String(schema)}`);
  }
  if (!validate(raw)) {
    throw new CrewError(
      'REPORT_INVALID',
      `Invalid agent report: ${ajv.errorsText(validate.errors, { separator: '; ' })}`,
    );
  }
  return raw as ReportPayload;
}

export function normalizeReport(
  raw: unknown,
  defaults: {
    taskId?: string;
    runId?: string;
    status?: string;
    summary?: string;
    methodology?: Methodology;
  },
): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return raw;
  }
  const record = { ...(raw as Record<string, unknown>) };
  if (record.schema === undefined) {
    record.schema =
      defaults.methodology && defaults.methodology !== 'free'
        ? 'crew.report/v2'
        : 'crew.report/v1';
  }
  if (record.schema === 'crew.report/v2' && record.methodology === undefined) {
    if (defaults.methodology) {
      record.methodology = defaults.methodology;
    }
  }
  if (record.task_id === undefined && defaults.taskId) {
    record.task_id = defaults.taskId;
  }
  if (record.run_id === undefined && defaults.runId) {
    record.run_id = defaults.runId;
  }
  if (record.status === undefined && defaults.status) {
    record.status = defaults.status;
  }
  if (record.summary === undefined && defaults.summary) {
    record.summary = defaults.summary;
  }
  return record;
}

export function parseReportText(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new CrewError(
      'REPORT_MALFORMED',
      `Report is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function parseReportFromOutput(text: string): unknown | null {
  const pattern = /```crew-report\s*([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  let last: string | null = null;
  while ((match = pattern.exec(text)) !== null) {
    last = match[1] ?? null;
  }
  if (!last) {
    return null;
  }
  return parseReportText(last.trim());
}

export function readReportFile(reportPath: string): unknown | null {
  if (!existsSync(reportPath)) {
    return null;
  }
  return parseReportText(readFileSync(reportPath, 'utf8'));
}
