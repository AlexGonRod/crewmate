export type TaskState =
  | 'draft'
  | 'queued'
  | 'starting'
  | 'running'
  | 'waiting_input'
  | 'blocked'
  | 'review'
  | 'delivering'
  | 'done'
  | 'failed'
  | 'cancelled';

export type RunState = 'starting' | 'running' | 'exited' | 'failed' | 'lost' | 'cancelled';

export type ReportStatus = 'done' | 'failed' | 'blocked' | 'needs_input' | 'progress';

export type DeliveryMode = 'local' | 'pr' | 'auto_merge' | 'scout';

export type Methodology = 'free' | 'spec' | 'tdd';

export type AgentRole = 'developer' | 'tester';

export type PipelineStage = 'develop' | 'test' | 'git' | 'review';

export type ReportVerdict = 'approve' | 'reject';

export type FindingSeverity = 'blocking' | 'warning' | 'info';

export interface ReportFinding {
  severity: FindingSeverity;
  message: string;
  criterion_id?: string;
  ref?: string;
}

export type TestPhase = 'red' | 'green' | 'refactor';

export type VerificationState = 'passed' | 'failed' | 'error';

export interface VerificationResult {
  id: string;
  taskId: string;
  runId: string;
  command: string;
  state: VerificationState;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  output: string;
  logPath: string;
  error?: string;
  createdAt: string;
}

export type AcceptanceStatus = 'passed' | 'failed' | 'not_verified';

export interface AcceptanceCriterion {
  id: string;
  text: string;
  verify?: string;
}

export interface TaskSpec {
  schema: 'crew.spec/v1';
  goal: string;
  acceptance_criteria: AcceptanceCriterion[];
  non_goals?: string[];
  constraints?: string[];
}

export interface Project {
  id: string;
  name: string;
  rootPath: string;
  defaultBranch: string;
  remoteUrl: string | null;
  forge: string | null;
  createdAt: string;
}

export interface Task {
  id: string;
  projectId: string;
  title: string;
  slug: string;
  briefText: string;
  methodology: Methodology;
  spec: TaskSpec | null;
  stage: PipelineStage;
  reviewIterations: number;
  commitSha: string | null;
  prUrl: string | null;
  state: TaskState;
  deliveryMode: DeliveryMode;
  baseBranch: string;
  branch: string | null;
  worktreePath: string | null;
  harnessId: string | null;
  priority: number;
  lastSeq: number;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface Run {
  id: string;
  taskId: string;
  attempt: number;
  harnessId: string;
  role: AgentRole;
  stage: PipelineStage;
  backend: string;
  state: RunState;
  pid: number | null;
  exitCode: number | null;
  logPath: string;
  startedAt: string;
  endedAt: string | null;
}

export interface TestResult {
  command: string;
  status: 'passed' | 'failed' | 'skipped' | 'unknown';
  phase?: TestPhase;
  duration_ms?: number;
  output?: string;
}

export interface AcceptanceEvidence {
  criterion_id: string;
  status: AcceptanceStatus;
  evidence: string;
}

export interface ReportArtifact {
  kind: 'commit' | 'pr' | 'file' | 'url' | 'other';
  ref: string;
  label?: string;
}

export interface ReportQuestion {
  id: string;
  text: string;
  blocking?: boolean;
}

export interface ReportPayload {
  schema: 'crew.report/v1' | 'crew.report/v2' | 'crew.report/v3';
  task_id: string;
  run_id: string;
  methodology?: Methodology;
  role?: AgentRole;
  verdict?: ReportVerdict;
  review_iteration?: number;
  status: ReportStatus;
  summary: string;
  details?: string;
  acceptance?: AcceptanceEvidence[];
  findings?: ReportFinding[];
  tests?: TestResult[];
  artifacts?: ReportArtifact[];
  questions?: ReportQuestion[];
  follow_ups?: string[];
}

export interface Report {
  id: string;
  taskId: string;
  runId: string;
  schema: string;
  role: AgentRole;
  status: ReportStatus;
  summary: string;
  payload: ReportPayload;
  createdAt: string;
}

export interface Message {
  id: string;
  taskId: string;
  runId: string | null;
  direction: 'in' | 'out';
  kind: string;
  body: string;
  createdAt: string;
  consumedAt: string | null;
}

export interface Artifact {
  id: string;
  taskId: string;
  runId: string | null;
  kind: string;
  ref: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface EventRecord {
  seq: number;
  id: string;
  aggregateType: string;
  aggregateId: string;
  taskId: string | null;
  type: string;
  actor: string;
  payload: Record<string, unknown>;
  createdAt: string;
  correlationId: string | null;
  causationId: string | null;
}

export interface TaskDetail {
  task: Task;
  project: Project | null;
  runs: Run[];
  report: Report | null;
  messages: Message[];
  artifacts: Artifact[];
  verifications: VerificationResult[];
  events: EventRecord[];
}
