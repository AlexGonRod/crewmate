import { Store } from '../src/store/store';
import { loadContext } from '../src/config/config';
import { resolveWorkspace, diffText, logText } from '../src/app/workspace';

const context = loadContext({});
const store = new Store(context.paths.dbPath);
const id = process.argv[2]!;
const detail = store.getTaskDetail(id);
console.log('worktreePath', detail.task.worktreePath);
console.log('base', detail.task.baseBranch);
const resolution = resolveWorkspace({
  project: detail.project!,
  projectConfig: null,
  task: detail.task,
  worktreesDir: context.paths.worktreesDir,
});
console.log('workspace kind', resolution.workspace.kind, resolution.workspace.worktreePath);
const raw = resolution.workspace.git(['diff', `${detail.task.baseBranch}...HEAD`], resolution.workspace.worktreePath);
console.log('raw status', raw.status, 'len', raw.stdout.length, JSON.stringify(raw.stderr).slice(0, 200));
console.log('diffText len', diffText(resolution.workspace, detail.task.baseBranch).length);
console.log('logText', logText(resolution.workspace, detail.task.baseBranch));
