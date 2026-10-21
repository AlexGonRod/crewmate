import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Store } from '../store/store';
import { buildCaptainBrief } from './captain';
import { summarizeDetail } from './summary';

export interface UiServerOptions {
  port?: number;
  host?: string;
}

export interface UiServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(payload);
}

function sendHtml(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(body);
}

const DASHBOARD = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>crew</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif; margin: 0; padding: 24px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .meta { opacity: 0.7; margin-bottom: 20px; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 28px; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid rgba(128,128,128,0.25); }
  th { font-weight: 600; opacity: 0.75; }
  .pill { display: inline-block; padding: 1px 8px; border-radius: 999px; border: 1px solid rgba(128,128,128,0.4); font-size: 12px; }
  .low { color: #2e7d32; } .medium { color: #b26a00; } .high { color: #c62828; }
  .attention { border-left: 3px solid #c62828; padding-left: 10px; }
  code { font-family: ui-monospace, SFMono-Regular, monospace; }
</style>
</head>
<body>
<h1>crew</h1>
<div class="meta" id="meta">loading…</div>
<div id="attention"></div>
<table id="tasks"><thead><tr>
  <th>ID</th><th>State</th><th>Risk</th><th>CI</th><th>Verify</th><th>Tester</th><th>PR</th><th>Title</th>
</tr></thead><tbody></tbody></table>
<script>
async function refresh() {
  const response = await fetch('/api/summary');
  const data = await response.json();
  document.getElementById('meta').textContent =
    data.totalTasks + ' tasks · ' + data.activeRuns.length + ' active runs · lease ' +
    (data.lease ? data.lease.owner + (data.lease.active ? ' (active)' : ' (expired)') : 'none') +
    ' · updated ' + data.generatedAt;
  const attention = document.getElementById('attention');
  attention.innerHTML = '';
  if (data.attention.length) {
    const box = document.createElement('div');
    box.className = 'attention';
    box.innerHTML = '<strong>Needs attention</strong>';
    for (const item of data.attention) {
      const line = document.createElement('div');
      line.textContent = item.taskId + ' [' + item.state + '] ' + item.title + ' — ' + item.reason;
      box.appendChild(line);
    }
    attention.appendChild(box);
  }
  const body = document.querySelector('#tasks tbody');
  body.innerHTML = '';
  for (const task of data.tasks) {
    const row = document.createElement('tr');
    const risk = task.risk ? task.risk.level : '-';
    row.innerHTML =
      '<td><code>' + task.taskId + '</code></td>' +
      '<td>' + task.state + '</td>' +
      '<td><span class="pill ' + risk + '">' + risk + '</span></td>' +
      '<td>' + (task.ci ? task.ci.state : '-') + '</td>' +
      '<td>' + task.verification.state + '</td>' +
      '<td>' + (task.tester ? (task.tester.verdict || task.tester.status) : '-') + '</td>' +
      '<td>' + (task.pr ? task.pr.state : '-') + '</td>' +
      '<td>' + task.title + '</td>';
    body.appendChild(row);
  }
}
refresh();
setInterval(refresh, 3000);
</script>
</body>
</html>
`;

function readParam(url: URL, name: string): string | null {
  return url.searchParams.get(name);
}

function handleRequest(store: Store, request: IncomingMessage, response: ServerResponse): void {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const path = url.pathname;

  if (path === '/' || path === '/index.html') {
    sendHtml(response, 200, DASHBOARD);
    return;
  }

  if (path === '/api/summary') {
    sendJson(response, 200, buildCaptainBrief(store, { limit: 50 }));
    return;
  }

  if (path === '/api/tasks') {
    const tasks = store.listTasks().map((task) => summarizeDetail(store.getTaskDetail(task.id)));
    sendJson(response, 200, { tasks });
    return;
  }

  const taskMatch = /^\/api\/tasks\/([^/]+)$/.exec(path);
  if (taskMatch) {
    const taskId = decodeURIComponent(taskMatch[1] as string);
    const task = store.getTask(taskId);
    if (!task) {
      sendJson(response, 404, { error: 'TASK_NOT_FOUND', taskId });
      return;
    }
    const detail = store.getTaskDetail(taskId);
    sendJson(response, 200, {
      summary: summarizeDetail(detail),
      events: detail.events.slice(-200),
      verifications: detail.verifications,
      artifacts: detail.artifacts,
      reports: detail.reports.map((report) => ({
        id: report.id,
        role: report.role,
        status: report.status,
        summary: report.summary,
        createdAt: report.createdAt,
      })),
    });
    return;
  }

  if (path === '/api/events') {
    const taskId = readParam(url, 'task');
    const limit = Number(readParam(url, 'limit') ?? '100');
    const events = store.listEvents({
      taskId: taskId ?? undefined,
      limit: Number.isFinite(limit) ? limit : 100,
    });
    sendJson(response, 200, { events });
    return;
  }

  sendJson(response, 404, { error: 'NOT_FOUND', path });
}

export async function startUiServer(
  store: Store,
  options: UiServerOptions = {},
): Promise<UiServer> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 4173;

  const server: Server = createServer((request, response) => {
    try {
      handleRequest(store, request, response);
    } catch (error) {
      sendJson(response, 500, {
        error: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const boundPort = typeof address === 'object' && address ? address.port : port;

  return {
    url: `http://${host}:${boundPort}`,
    port: boundPort,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
