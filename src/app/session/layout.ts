/**
 * Task layout for the interactive Herdr backend.
 *
 * Instead of one tab per run, a task gets ONE tab with three panes: the left
 * column holds the interactive developer (top) and tester (bottom) agents, and
 * the right column is reserved for the reviewer (the reviewr plugin pane is
 * opened there when the task reaches review).
 *
 * The geometry is built with two splits, in this order (Herdr splits divide
 * the pane they are given):
 *
 * 1. `pane split --direction right` on the root pane -> full-height right
 *    column (the reviewer placeholder).
 * 2. `pane split --direction down` on the root pane again -> the left column
 *    divides into developer (top) and tester (bottom).
 *
 * Everything is created with `--no-focus`: the calling pane keeps its focus
 * (ADR 0046). Pure helpers live here so they can be tested without Herdr.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export interface TaskLayout {
  schema: 'crew.herdr-layout/v1';
  taskId: string;
  workspaceId: string;
  tabId: string;
  developerPaneId: string;
  testerPaneId: string;
  /**
   * The full-height right pane. While no review is running it is an empty
   * shell; when the task reaches review, the review plugin pane is opened by
   * splitting this pane and the placeholder half is closed, so the plugin
   * pane ends up as the full right column.
   */
  reviewerPaneId: string;
  createdAt: string;
}

/** Layout state lives next to the session states: `layout-<taskId>.json`. */
export function layoutFileName(taskId: string): string {
  return `layout-${taskId}.json`;
}

export function isLayoutFileName(name: string): boolean {
  return name.startsWith('layout-') && name.endsWith('.json');
}

export function layoutPath(stateDir: string, taskId: string): string {
  return path.join(stateDir, layoutFileName(taskId));
}

export function readTaskLayout(stateDir: string, taskId: string): TaskLayout | null {
  const file = layoutPath(stateDir, taskId);
  if (!existsSync(file)) {
    return null;
  }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as TaskLayout;
    return raw.schema === 'crew.herdr-layout/v1' && raw.tabId ? raw : null;
  } catch {
    return null;
  }
}

/** `herdr pane split` with `--no-focus`: the caller keeps its focus. */
export function paneSplitArgs(paneId: string, direction: 'right' | 'down', cwd: string): string[] {
  return [
    'pane',
    'split',
    '--pane',
    paneId,
    '--direction',
    direction,
    '--cwd',
    cwd,
    '--no-focus',
  ];
}

/**
 * Opens the review plugin pane as the full right column: it splits the
 * reserved placeholder pane to its right, and the caller closes the
 * placeholder afterwards so the plugin pane takes over the whole column.
 */
export function reviewPaneOpenArgs(input: {
  pluginId: string;
  entrypointId: string;
  reviewerPaneId: string;
  worktreePath: string;
}): string[] {
  return [
    'plugin',
    'pane',
    'open',
    '--plugin',
    input.pluginId,
    '--entrypoint',
    input.entrypointId,
    '--placement',
    'split',
    '--direction',
    'right',
    '--target-pane',
    input.reviewerPaneId,
    '--cwd',
    input.worktreePath,
    '--no-focus',
  ];
}

export interface LayoutPaneRect {
  pane_id: string;
  rect: { x: number; y: number; width: number; height: number };
}

/**
 * Verifies the observed geometry of a tab: developer and tester stacked in
 * the left column, reviewer as the full-height right column. Tolerances
 * absorb the splitter borders between panes.
 */
export function layoutGeometryMatches(
  panes: LayoutPaneRect[],
  layout: Pick<TaskLayout, 'developerPaneId' | 'testerPaneId' | 'reviewerPaneId'>,
): boolean {
  const byId = new Map(panes.map((pane) => [pane.pane_id, pane]));
  const developer = byId.get(layout.developerPaneId);
  const tester = byId.get(layout.testerPaneId);
  const reviewer = byId.get(layout.reviewerPaneId);
  if (!developer || !tester || !reviewer) {
    return false;
  }
  const near = (a: number, b: number): boolean => Math.abs(a - b) <= 2;
  const leftColumn =
    near(developer.rect.x, tester.rect.x) &&
    developer.rect.y < tester.rect.y &&
    !near(developer.rect.y, tester.rect.y);
  const rightColumn =
    reviewer.rect.x > developer.rect.x &&
    near(reviewer.rect.y, developer.rect.y) &&
    near(reviewer.rect.y + reviewer.rect.height, tester.rect.y + tester.rect.height);
  return leftColumn && rightColumn;
}
