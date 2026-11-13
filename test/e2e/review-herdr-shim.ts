export function herdrShim(): string {
  return `#!/usr/bin/env node
const { existsSync, readFileSync, writeFileSync, appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
const log = process.env.HERDR_LOG;
const statePath = process.env.HERDR_STATE;
appendFileSync(log, JSON.stringify(args) + '\\n');
function state() {
  if (!existsSync(statePath)) return { panes: [] };
  return JSON.parse(readFileSync(statePath, 'utf8'));
}
function write(stateValue) {
  writeFileSync(statePath, JSON.stringify(stateValue));
}
function json(value) {
  process.stdout.write(JSON.stringify(value));
  process.exit(0);
}
if (args[0] === 'status' && args[1] === 'server') process.exit(0);
if (args[0] === 'plugin' && args[1] === 'list') {
  json({ result: { plugins: [{
    plugin_id: 'persiyanov.reviewr',
    name: 'reviewr',
    enabled: true,
    panes: [{ id: 'pane', title: 'reviewr', placement: 'split' }],
  }] } });
}
if (args[0] === 'pane' && args[1] === 'list') {
  json({ result: { panes: state().panes } });
}
if (args[0] === 'plugin' && args[1] === 'pane' && args[2] === 'focus') {
  json({ result: { focused: args[3] } });
}
if (args[0] === 'plugin' && args[1] === 'pane' && args[2] === 'open') {
  const cwd = args[args.indexOf('--cwd') + 1];
  const current = state();
  current.panes.push({ pane_id: 'w1:p9', label: 'reviewr', cwd });
  write(current);
  json({ result: { pane: { pane_id: 'w1:p9' } } });
}
process.stderr.write('herdr shim: unsupported ' + args.join(' ') + '\\n');
process.exit(1);
`;
}
