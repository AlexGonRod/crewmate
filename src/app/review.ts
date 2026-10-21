import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CrewError } from '../core/errors';
import type { TaskDetail } from '../core/types';
import { summarizeDetail } from './summary';

export const DECISION_KEY = 'crew-decision';
export const REASON_KEY = 'crew-reason';
export const ANSWER_KEY = 'crew-answer';

export type ReviewDecisionKind = 'accept' | 'reject' | 'none';

export interface ReviewDecision {
  decision: ReviewDecisionKind;
  reason: string | null;
}

function readKey(text: string, key: string): string | null {
  const pattern = new RegExp(`^${key}:[ \\t]*(.*)$`, 'gm');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const value = (match[1] ?? '').trim();
    if (value !== '') {
      return value;
    }
  }
  return null;
}

/**
 * Reads the decision from a review buffer. Anything that is not exactly
 * "accept" or "reject" means "no decision", so closing the editor without
 * touching the buffer never changes anything.
 */
export function parseReviewDecision(text: string): ReviewDecision {
  const raw = (readKey(text, DECISION_KEY) ?? '').toLowerCase();
  const reason = readKey(text, REASON_KEY);
  if (raw === 'accept' || raw === 'reject') {
    return {
      decision: raw,
      reason: reason && reason.length > 0 ? reason : null,
    };
  }
  return { decision: 'none', reason: null };
}

/**
 * Reads the answer from an answer buffer. An empty answer means the human
 * did not want to answer.
 */
export function parseAnswer(text: string): string | null {
  const raw = readKey(text, ANSWER_KEY);
  if (raw === null) {
    return null;
  }
  const answer = raw.trim();
  return answer.length > 0 ? answer : null;
}

export interface ReviewBufferOptions {
  diff: string;
  log: string;
  pr?: { url: string; state: string; merged: boolean; draft: boolean; mergeable: string } | null;
  maxDiffLines?: number;
}

function truncate(text: string, maxLines: number): string {
  const lines = text.split('\n');
  if (lines.length <= maxLines) {
    return text;
  }
  const omitted = lines.length - maxLines;
  return [
    ...lines.slice(0, maxLines),
    `... (${omitted} more line(s) truncated; use --max-diff to see more)`,
  ].join('\n');
}

/**
 * Builds the review buffer: everything the human needs to decide, and the two
 * lines the crew reads back.
 */
export function buildReviewBuffer(
  detail: TaskDetail,
  options: ReviewBufferOptions,
): string {
  const { task } = detail;
  const summary = summarizeDetail(detail);
  const maxDiffLines = options.maxDiffLines ?? 2000;
  const gates = [
    `verification ${summary.verification.state}`,
    summary.tester ? `tester ${summary.tester.verdict ?? summary.tester.status}` : 'tester none',
    summary.ci ? `CI ${summary.ci.state}` : 'CI none',
  ].join(' · ');
  const pr = options.pr;
  const risk = summary.risk;

  const header = [
    '# ===============================================================',
    `#  crew review · ${task.id}`,
    '# ===============================================================',
    `#  Task      ${task.title}`,
    `#  Project   ${detail.project?.name ?? task.projectId}`,
    `#  Branch    ${task.branch ?? '-'}`,
    `#  Base      ${task.baseBranch}`,
    `#  Commit    ${task.commitSha ?? '-'}`,
    `#  State     ${task.state}`,
    `#  Delivery  ${task.deliveryMode}`,
    `#  Risk      ${
      risk ? `${risk.level} (score ${risk.score}): ${risk.reasons.join('; ')}` : 'unknown'
    }`,
    `#  Gates     ${gates}`,
    `#  PR        ${
      pr ? `${pr.url} (${pr.state}${pr.draft ? ', draft' : ''}, ${pr.mergeable})` : '-'
    }`,
    '#',
    '#  Decide by editing the line below, then save and quit (:wq in nvim).',
    '#  Values: accept | reject. Leave it empty to close without deciding.',
    '# ===============================================================',
    '',
    `${DECISION_KEY}: `,
    `${REASON_KEY}: `,
    '',
  ].join('\n');

  const brief = [
    '# ---------------------------------------------------------------',
    '# Brief',
    '# ---------------------------------------------------------------',
    task.briefText || task.title,
    '',
  ].join('\n');

  const logSection = [
    '# ---------------------------------------------------------------',
    '# Commits (base..head)',
    '# ---------------------------------------------------------------',
    options.log.trim() || '(no commits)',
    '',
  ].join('\n');

  const diffSection = [
    '# ---------------------------------------------------------------',
    '# Diff (base...head)',
    '# ---------------------------------------------------------------',
    truncate(options.diff, maxDiffLines).trimEnd(),
    '',
  ].join('\n');

  return `${header}${brief}${logSection}${diffSection}`;
}

export interface AnswerBufferOptions {
  questions: string[];
}

/**
 * Builds the answer buffer for a task that is waiting for the human.
 */
export function buildAnswerBuffer(detail: TaskDetail, options: AnswerBufferOptions): string {
  const { task } = detail;
  const questions = options.questions.length > 0
    ? options.questions
    : ['(the agent did not leave a question)'];
  const questionLines = questions
    .map((question, index) => `#  ${index + 1}. ${question}`)
    .join('\n');
  return [
    '# ===============================================================',
    `#  crew answer · ${task.id}`,
    '# ===============================================================',
    `#  Task      ${task.title}`,
    '#',
    '#  The agent asked:',
    questionLines,
    '#',
    '#  Write your answer below, then save and quit (:wq in nvim).',
    '#  Leave it empty to answer nothing.',
    '# ===============================================================',
    '',
    `${ANSWER_KEY}: `,
    '',
  ].join('\n');
}

export interface ReviewFile {
  path: string;
  content: string;
}

export function writeReviewFile(
  baseDir: string,
  name: string,
  content: string,
): ReviewFile {
  mkdirSync(baseDir, { recursive: true });
  const filePath = path.join(baseDir, name);
  writeFileSync(filePath, content, 'utf8');
  return { path: filePath, content };
}

export function readReviewFile(filePath: string): string {
  try {
    return readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new CrewError(
      'REVIEW_FILE_MISSING',
      `Could not read ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
