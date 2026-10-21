import type {
  ChangeStats,
  CiResult,
  MergeResult,
  Report,
  TaskDetail,
  TaskSummary,
  VerificationResult,
} from '../core/types';
import { assessRisk } from '../risk/risk';

function latestArtifact<T>(detail: TaskDetail, kind: string): T | null {
  const artifacts = detail.artifacts.filter((artifact) => artifact.kind === kind);
  const artifact = artifacts.at(-1);
  if (!artifact || !artifact.metadata) {
    return null;
  }
  return artifact.metadata as T;
}

function parseChange(detail: TaskDetail): ChangeStats | null {
  const raw = latestArtifact<ChangeStats>(detail, 'change');
  if (!raw || typeof raw.files !== 'number' || !Array.isArray(raw.paths)) {
    return null;
  }
  return {
    files: raw.files,
    additions: Number(raw.additions ?? 0),
    deletions: Number(raw.deletions ?? 0),
    paths: raw.paths,
  };
}

function latestTesterReport(detail: TaskDetail): Report | null {
  const reports = detail.reports.filter((report) => report.role === 'tester');
  return reports.at(-1) ?? null;
}

function latestVerifications(detail: TaskDetail): VerificationResult[] {
  const developerRun = detail.runs.filter((run) => run.role === 'developer').at(-1);
  if (!developerRun) {
    return [];
  }
  return detail.verifications.filter((verification) => verification.runId === developerRun.id);
}

export function summarizeDetail(detail: TaskDetail): TaskSummary {
  const { task } = detail;

  const change = parseChange(detail);
  const testerReport = latestTesterReport(detail);
  const verifications = latestVerifications(detail);
  const ci = latestArtifact<CiResult>(detail, 'ci');
  const merge = latestArtifact<MergeResult>(detail, 'merge');

  const failedVerifications = verifications.filter((verification) => verification.state !== 'passed');
  const verificationState: TaskSummary['verification']['state'] =
    failedVerifications.length > 0 ? 'failed' : verifications.length > 0 ? 'passed' : 'none';

  const findings = testerReport?.payload.findings ?? [];
  const tester: TaskSummary['tester'] = testerReport
    ? {
        verdict: testerReport.payload.verdict ?? null,
        status: testerReport.status,
        findings: findings.length,
        blocking: findings.filter((finding) => finding.severity === 'blocking').length,
        warnings: findings.filter((finding) => finding.severity === 'warning').length,
        summary: testerReport.summary,
      }
    : null;

  let pr: TaskSummary['pr'] = null;
  if (task.prUrl) {
    let state: 'open' | 'merged' | 'merge_failed' | 'unknown' = 'open';
    if (merge) {
      state = merge.state === 'merged' ? 'merged' : 'merge_failed';
    } else if (task.state === 'done') {
      state = 'unknown';
    }
    pr = { url: task.prUrl, state };
  }

  const risk = change
    ? assessRisk({
        change,
        testerReport,
        verifications,
        ci: ci ? { state: ci.state } : null,
      })
    : null;

  return {
    taskId: task.id,
    title: task.title,
    state: task.state,
    stage: task.stage,
    deliveryMode: task.deliveryMode,
    risk,
    verification: {
      state: verificationState,
      passed: verifications.length - failedVerifications.length,
      failed: failedVerifications.length,
      total: verifications.length,
    },
    ci: ci
      ? {
          state: ci.state,
          summary: ci.summary,
          url: ci.url,
        }
      : null,
    tester,
    pr,
    commitSha: task.commitSha,
    updatedAt: task.updatedAt,
  };
}
