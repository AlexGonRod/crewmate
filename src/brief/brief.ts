import type {
  Message,
  Methodology,
  Project,
  Run,
  Task,
  TaskSpec,
} from '../core/types';

export interface BriefInput {
  task: Task;
  project: Project;
  run: Run;
  attempt: number;
  reportPath: string;
  briefPath: string;
  specPath: string;
  cliCommand: string;
  methodology: Methodology;
  spec: TaskSpec | null;
  verifyCommands: string[];
  messages: Message[];
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function renderMessage(message: Message): string {
  return `- [${message.direction}/${message.kind}] ${message.body}`;
}

function renderAcceptance(spec: TaskSpec): string {
  return spec.acceptance_criteria
    .map((criterion) => {
      const verify = criterion.verify ? ` (verify: \`${criterion.verify}\`)` : '';
      return `- [ ] **${criterion.id}**: ${criterion.text}${verify}`;
    })
    .join('\n');
}

function renderList(title: string, items: string[] | undefined): string {
  if (!items || items.length === 0) {
    return '';
  }
  return `\n### ${title}\n\n${items.map((item) => `- ${item}`).join('\n')}\n`;
}

function renderSpec(spec: TaskSpec | null): string {
  if (!spec) {
    return '';
  }
  return `## Acceptance criteria

${renderAcceptance(spec)}
${renderList('Non-goals', spec.non_goals)}${renderList('Constraints', spec.constraints)}`;
}

function renderMethodology(
  methodology: Methodology,
  spec: TaskSpec | null,
): string {
  if (methodology === 'free') {
    return '';
  }
  const criteria = spec?.acceptance_criteria ?? [];
  const criteriaList =
    criteria.length > 0
      ? criteria.map((criterion) => criterion.id).join(', ')
      : 'the acceptance criteria';

  if (methodology === 'tdd') {
    return `## Methodology: TDD

Follow a red-green-refactor loop for every behaviour change:

1. **Red**: write or update a failing test that covers an acceptance criterion.
2. **Green**: implement the smallest change that makes the test pass.
3. **Refactor**: clean up while keeping the tests green.

Record each test run in \`tests\` with a \`phase\` of \`red\`, \`green\`, or
\`refactor\`. A \`done\` report must include at least one \`red\` and one
\`green\` test entry, and evidence for ${criteriaList}. If the task genuinely
has no behaviour to test, the task must use the \`free\` methodology instead.
`;
  }

  return `## Methodology: spec

Work spec-first. Treat the acceptance criteria as the contract:

1. Restate the plan and map it to the acceptance criteria.
2. Implement only what the criteria and goal require.
3. Verify each criterion and record evidence in \`acceptance\`.

A \`done\` report must include a \`passed\` entry for ${criteriaList} in
\`acceptance\`, with a concrete evidence reference (file, test, or command).
`;
}

function renderReportTemplate(
  task: Task,
  run: Run,
  methodology: Methodology,
  spec: TaskSpec | null,
): string {
  if (methodology === 'free') {
    return `{
  "schema": "crew.report/v1",
  "task_id": "${task.id}",
  "run_id": "${run.id}",
  "status": "done",
  "summary": "Short description of what changed and how it was verified",
  "tests": [{"command": "pnpm test", "status": "passed"}],
  "artifacts": [{"kind": "commit", "ref": "abc1234"}],
  "questions": []
}`;
  }

  const acceptance = (spec?.acceptance_criteria ?? [])
    .map(
      (criterion) =>
        `    {"criterion_id": "${criterion.id}", "status": "passed", "evidence": "test or file reference"}`,
    )
    .join(',\n');
  const phases =
    methodology === 'tdd'
      ? `    {"command": "pnpm test", "status": "failed", "phase": "red"},\n    {"command": "pnpm test", "status": "passed", "phase": "green"}`
      : `    {"command": "pnpm test", "status": "passed"}`;

  return `{
  "schema": "crew.report/v2",
  "task_id": "${task.id}",
  "run_id": "${run.id}",
  "methodology": "${methodology}",
  "status": "done",
  "summary": "Short description of what changed and how it was verified",
  "acceptance": [
${acceptance}
  ],
  "tests": [
${phases}
  ],
  "artifacts": [{"kind": "commit", "ref": "abc1234"}],
  "questions": []
}`;
}

export function generateBrief(input: BriefInput): string {
  const {
    task,
    project,
    run,
    attempt,
    reportPath,
    briefPath,
    specPath,
    cliCommand,
    methodology,
    spec,
    messages,
  } = input;
  const frontmatterLines = [
    '---',
    'schema: "crew.brief/v1"',
    `task_id: ${yamlString(task.id)}`,
    `run_id: ${yamlString(run.id)}`,
    `attempt: ${attempt}`,
    `project_id: ${yamlString(project.id)}`,
    `repo_path: ${yamlString(project.rootPath)}`,
    `worktree_path: ${yamlString(task.worktreePath ?? '')}`,
    `branch: ${yamlString(task.branch ?? '')}`,
    `base_branch: ${yamlString(task.baseBranch)}`,
    `delivery_mode: ${yamlString(task.deliveryMode)}`,
    `methodology: ${yamlString(methodology)}`,
  ];
  if (spec) {
    frontmatterLines.push('spec_schema: "crew.spec/v1"');
  }
  frontmatterLines.push('---', '');
  const frontmatter = frontmatterLines.join('\n');

  const goal = spec?.goal ?? task.briefText;

  const priorMessages =
    messages.length > 0
      ? messages.map(renderMessage).join('\n')
      : '- No previous messages.';

  const verify =
    input.verifyCommands.length > 0
      ? input.verifyCommands.map((command) => `- \`${command}\``).join('\n')
      : '- No project verification commands are configured.';

  const specSection = renderSpec(spec);
  const methodologySection = renderMethodology(methodology, spec);
  const reportTemplate = renderReportTemplate(task, run, methodology, spec);
  const methodologyDone =
    methodology === 'free'
      ? ''
      : methodology === 'tdd'
        ? `- Every acceptance criterion is covered in \`acceptance\` with status \`passed\`.
- At least one test entry uses phase \`red\` and one uses \`green\`.
`
        : `- Every acceptance criterion is covered in \`acceptance\` with status \`passed\`.
`;

  return `${frontmatter}# Task: ${task.title}

## Goal

${goal}

${specSection}
${methodologySection}
## Context

- Project: ${project.name}
- Repository: ${project.rootPath}
- Base branch: ${task.baseBranch}
- Worktree: ${task.worktreePath}
- Branch: ${task.branch}
- Attempt: ${attempt}
- Methodology: ${methodology}
- Delivery mode: ${task.deliveryMode}

You are working inside the isolated worktree above. Do not modify the main
checkout, do not push, and do not merge anything.

## Constraints

- Keep all changes inside the worktree.
- Do not read, write, or log secrets.
- Do not change files outside the task's scope without explaining why.
- Do not mark the task done if verification fails.
- If you need a human decision, report \`needs_input\` and stop.

## Verification

${verify}

## Previous messages

${priorMessages}

## Reporting

When the work is finished, you must emit a report. Use one of these two paths:

1. Run the crew CLI:

\`\`\`sh
${cliCommand} report --task ${task.id} --run ${run.id} --file ${reportPath}
\`\`\`

2. Write a JSON report to \`${reportPath}\` and exit normally.

The report must match \`crew.report/v${methodology === 'free' ? '1' : '2'}\`:

\`\`\`json
${reportTemplate}
\`\`\`

Status values:

- \`done\`: work is complete and verified.
- \`failed\`: work could not be completed.
- \`blocked\`: an external blocker prevents progress.
- \`needs_input\`: a human decision is required.
- \`progress\`: an optional intermediate update; it does not finish the task.

If a report is missing, invalid, or only uses \`progress\`, the run is marked as
failed.

## Environment

- \`CREW_TASK_ID\` = ${task.id}
- \`CREW_RUN_ID\` = ${run.id}
- \`CREW_PROJECT_ID\` = ${project.id}
- \`CREW_METHODOLOGY\` = ${methodology}
- \`CREW_WORKTREE\` = ${task.worktreePath}
- \`CREW_BRIEF_PATH\` = ${briefPath}
- \`CREW_SPEC_PATH\` = ${specPath}
- \`CREW_REPORT_PATH\` = ${reportPath}

## Definition of done

- The goal above is implemented.
- Verification commands pass, or failures are explained in \`tests\`.
${methodologyDone}- Any artifacts (commit, PR, file) are listed in the report.
- The report is written before you exit.
`;
}
