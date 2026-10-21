import { describe, expect, it } from 'vitest';
import { editorCommand, resolveEditor } from '../../src/app/editor';
import {
  buildAnswerBuffer,
  buildReviewBuffer,
  parseAnswer,
  parseReviewDecision,
} from '../../src/app/review';
import type { TaskDetail } from '../../src/core/types';

const detail = {
  task: {
    id: 'tsk_1',
    projectId: 'prj_1',
    title: 'Add a feature',
    briefText: 'The feature should do X',
    state: 'review',
    stage: 'develop',
    deliveryMode: 'pr',
    baseBranch: 'main',
    branch: 'crew/tsk_1',
    commitSha: 'abc1234',
    reviewIterations: 0,
    methodology: 'free',
  },
  project: { id: 'prj_1', name: 'demo', rootPath: '/repo' },
  runs: [],
  report: null,
  reports: [],
  messages: [],
  artifacts: [],
  verifications: [],
  dependencies: [],
  events: [],
} as unknown as TaskDetail;

describe('editor resolution', () => {
  it('prefers CREW_EDITOR, then VISUAL, then EDITOR, then nvim', () => {
    expect(resolveEditor({ CREW_EDITOR: 'a', VISUAL: 'b', EDITOR: 'c' })).toBe('a');
    expect(resolveEditor({ VISUAL: 'b', EDITOR: 'c' })).toBe('b');
    expect(resolveEditor({ EDITOR: 'c' })).toBe('c');
    expect(resolveEditor({})).toBe('nvim');
  });

  it('keeps the arguments of the editor command', () => {
    const command = editorCommand({ CREW_EDITOR: 'nvim -p' });
    expect(command.binary).toBe('nvim');
    expect(command.args).toEqual(['-p']);
  });

  it('waits for the GUI editors to close', () => {
    const command = editorCommand({ CREW_EDITOR: 'code' });
    expect(command.args).toContain('--wait');
  });

  it('does not add --wait to a terminal editor', () => {
    const command = editorCommand({ CREW_EDITOR: 'nvim' });
    expect(command.args).not.toContain('--wait');
  });
});

describe('review decision', () => {
  it('reads an accept decision with its reason', () => {
    const decision = parseReviewDecision(
      'crew-decision: accept\ncrew-reason: it matches the brief\n',
    );
    expect(decision).toEqual({ decision: 'accept', reason: 'it matches the brief' });
  });

  it('reads a reject decision', () => {
    expect(parseReviewDecision('crew-decision: reject\n').decision).toBe('reject');
  });

  it('treats an empty decision as no decision', () => {
    expect(parseReviewDecision('crew-decision: \ncrew-reason: \n').decision).toBe('none');
  });

  it('treats an unknown value as no decision', () => {
    expect(parseReviewDecision('crew-decision: maybe\n').decision).toBe('none');
  });

  it('ignores decision lines that are part of a diff', () => {
    const text = [
      'crew-decision: ',
      '+crew-decision: accept',
      ' crew-decision: accept',
    ].join('\n');
    expect(parseReviewDecision(text).decision).toBe('none');
  });
});

describe('answer parsing', () => {
  it('reads the answer', () => {
    expect(parseAnswer('crew-answer: use the existing adapter\n')).toBe(
      'use the existing adapter',
    );
  });

  it('returns null for an empty answer', () => {
    expect(parseAnswer('crew-answer: \n')).toBeNull();
    expect(parseAnswer('nothing here')).toBeNull();
  });
});

describe('review buffer', () => {
  const buffer = buildReviewBuffer(detail, {
    diff: 'diff --git a/a.txt b/a.txt\n+hello\n',
    log: 'abc1234 crew: Add a feature',
    pr: {
      url: 'https://github.com/acme/demo/pull/1',
      state: 'OPEN',
      merged: false,
      draft: false,
      mergeable: 'MERGEABLE',
    },
  });

  it('carries the context needed to decide', () => {
    expect(buffer).toContain('Add a feature');
    expect(buffer).toContain('The feature should do X');
    expect(buffer).toContain('https://github.com/acme/demo/pull/1');
    expect(buffer).toContain('abc1234 crew: Add a feature');
    expect(buffer).toContain('+hello');
    expect(buffer).toContain('crew-decision:');
    expect(buffer).toContain('crew-reason:');
  });

  it('starts with the decision block so it is the first thing to read', () => {
    expect(buffer.indexOf('crew-decision:')).toBeLessThan(
      buffer.indexOf('# Brief'),
    );
  });

  it('truncates a huge diff', () => {
    const long = buildReviewBuffer(detail, {
      diff: Array.from({ length: 50 }, (_, index) => `+line ${index}`).join('\n'),
      log: '',
      maxDiffLines: 10,
    });
    expect(long).toContain('40 more line(s) truncated');
  });
});

describe('answer buffer', () => {
  it('lists the questions of the agent', () => {
    const buffer = buildAnswerBuffer(detail, {
      questions: ['Which adapter should we use?', 'Should it be optional?'],
    });
    expect(buffer).toContain('Which adapter should we use?');
    expect(buffer).toContain('Should it be optional?');
    expect(buffer).toContain('crew-answer:');
  });
});
