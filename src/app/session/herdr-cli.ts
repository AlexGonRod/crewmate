import { spawnSync } from 'node:child_process';
import { readReportFile, validateReport } from '../../protocol/report';
import type { InteractiveReportState } from './interactive';
import type { HerdrResponse } from './herdr-types';

export function runHerdr(args: string[]): HerdrResponse {
  const result = spawnSync('herdr', args, { encoding: 'utf8' });
  if (result.error) {
    return {
      ok: false,
      stdout: '',
      stderr: result.error.message,
      json: null,
    };
  }
  const stdout = result.stdout ?? '';
  let json: any = null;
  try {
    json = JSON.parse(stdout);
  } catch {
    json = null;
  }
  return {
    ok: (result.status ?? 1) === 0,
    stdout,
    stderr: result.stderr ?? '',
    json,
  };
}

/**
 * The state of the run report, for the interactive completion decision. A file
 * that exists but does not validate is `invalid`, so a broken report is not
 * mistaken for a finished run.
 */
export function reportState(reportPath: string | null | undefined): InteractiveReportState {
  if (!reportPath) {
    return 'missing';
  }
  try {
    const raw = readReportFile(reportPath);
    if (raw === null) {
      return 'missing';
    }
    validateReport(raw);
    return 'valid';
  } catch {
    return 'invalid';
  }
}
