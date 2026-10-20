import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const scenario = process.env.CREW_FAKE_SCENARIO ?? 'success';
const taskId = process.env.CREW_TASK_ID;
const runId = process.env.CREW_RUN_ID;
const reportPath = process.env.CREW_REPORT_PATH;
const worktree = process.env.CREW_WORKTREE ?? process.cwd();
const specPath = process.env.CREW_SPEC_PATH;
const methodology = process.env.CREW_METHODOLOGY ?? 'spec';
const spec =
  specPath && existsSync(specPath)
    ? JSON.parse(readFileSync(specPath, 'utf8'))
    : null;

if (!taskId || !runId || !reportPath) {
  console.error('fake agent: missing CREW_TASK_ID, CREW_RUN_ID, or CREW_REPORT_PATH');
  process.exit(2);
}

function writeReport(status, summary, extra = {}) {
  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        schema: 'crew.report/v1',
        task_id: taskId,
        run_id: runId,
        status,
        summary,
        ...extra,
      },
      null,
      2,
    ),
  );
}

function writeReportV2(status, summary, extra = {}) {
  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        schema: 'crew.report/v2',
        task_id: taskId,
        run_id: runId,
        methodology,
        status,
        summary,
        ...extra,
      },
      null,
      2,
    ),
  );
}

function acceptanceFor(spec, skipLast = false) {
  const criteria = spec?.acceptance_criteria ?? [];
  return criteria
    .filter((_, index) => !(skipLast && index === criteria.length - 1))
    .map((criterion) => ({
      criterion_id: criterion.id,
      status: 'passed',
      evidence: `fake:${criterion.id}`,
    }));
}

function writeMarker(text) {
  writeFileSync(path.join(worktree, 'FAKE_AGENT_OUTPUT.txt'), text);
}

function commitMarker() {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Crew Fake Agent',
    GIT_AUTHOR_EMAIL: 'fake@crew.local',
    GIT_COMMITTER_NAME: 'Crew Fake Agent',
    GIT_COMMITTER_EMAIL: 'fake@crew.local',
  };
  execFileSync('git', ['add', '.'], { cwd: worktree, env });
  execFileSync('git', ['commit', '-m', 'fake agent change'], { cwd: worktree, env });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktree, env }).toString().trim();
}

console.log(`fake agent: scenario=${scenario}`);

switch (scenario) {
  case 'success': {
    writeMarker('fake agent success\n');
    writeReport('done', 'Fake agent completed the task', {
      tests: [{ command: 'fake-test', status: 'passed' }],
    });
    break;
  }
  case 'spec_success': {
    writeMarker('fake agent spec success\n');
    writeReportV2('done', 'Fake agent satisfied the spec', {
      acceptance: acceptanceFor(spec),
      tests: [{ command: 'fake-test', status: 'passed' }],
    });
    break;
  }
  case 'spec_missing_evidence': {
    writeMarker('fake agent spec missing evidence\n');
    writeReportV2('done', 'Fake agent claimed done without full evidence', {
      acceptance: acceptanceFor(spec, true),
      tests: [{ command: 'fake-test', status: 'passed' }],
    });
    break;
  }
  case 'tdd_success': {
    writeMarker('fake agent tdd success\n');
    writeReportV2('done', 'Fake agent followed red-green-refactor', {
      acceptance: acceptanceFor(spec),
      tests: [
        { command: 'fake-test', status: 'failed', phase: 'red' },
        { command: 'fake-test', status: 'passed', phase: 'green' },
      ],
    });
    break;
  }
  case 'tdd_missing_red': {
    writeMarker('fake agent tdd without red\n');
    writeReportV2('done', 'Fake agent skipped the red phase', {
      acceptance: acceptanceFor(spec),
      tests: [{ command: 'fake-test', status: 'passed', phase: 'green' }],
    });
    break;
  }
  case 'commit': {
    writeMarker('fake agent committed\n');
    const commit = commitMarker();
    writeReport('done', 'Fake agent created a commit', {
      tests: [{ command: 'fake-test', status: 'passed' }],
      artifacts: [{ kind: 'commit', ref: commit, label: 'Fake commit' }],
    });
    break;
  }
  case 'failed': {
    writeReport('failed', 'Fake agent failed on purpose', {
      tests: [{ command: 'fake-test', status: 'failed', output: 'intentional failure' }],
    });
    break;
  }
  case 'blocked': {
    writeReport('blocked', 'Fake agent is blocked by an external dependency');
    break;
  }
  case 'needs_input': {
    writeReport('needs_input', 'Fake agent needs a decision', {
      questions: [
        {
          id: 'q1',
          text: 'Should the fake agent use the existing design system?',
          blocking: true,
        },
      ],
    });
    break;
  }
  case 'crash': {
    console.error('fake agent: crashing without a report');
    process.exit(3);
  }
  case 'malformed': {
    mkdirSync(path.dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, '{"schema": "crew.report/v1",');
    break;
  }
  case 'progress': {
    writeReport('progress', 'Fake agent is still working');
    break;
  }
  case 'timeout': {
    console.log('fake agent: sleeping until killed');
    setInterval(() => {}, 1000);
    break;
  }
  default: {
    console.error(`fake agent: unknown scenario ${scenario}`);
    process.exit(2);
  }
}
