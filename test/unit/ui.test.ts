import { get } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { startUiServer, type UiServer } from '../../src/app/ui';
import { Store } from '../../src/store/store';

const stores: Store[] = [];
const servers: UiServer[] = [];

function createStore(): Store {
  const store = new Store(':memory:');
  stores.push(store);
  return store;
}

function fetchJson(url: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    get(url, (response) => {
      let payload = '';
      response.on('data', (chunk) => {
        payload += chunk;
      });
      response.on('end', () => {
        let body: any = null;
        try {
          body = JSON.parse(payload);
        } catch {
          body = payload;
        }
        resolve({ status: response.statusCode ?? 0, body });
      });
    }).on('error', reject);
  });
}

function seed(store: Store): string {
  const project = store.createProject({
    name: 'demo',
    rootPath: '/tmp/demo',
    defaultBranch: 'main',
    remoteUrl: null,
    forge: null,
  });
  const task = store.createTask({
    projectId: project.id,
    title: 'UI task',
    briefText: 'Do the thing',
    methodology: 'free',
    spec: null,
    deliveryMode: 'local',
  });
  store.queueTask(task.id);
  store.addMemory({
    projectId: project.id,
    kind: 'convention',
    title: 'Use pnpm',
    body: 'Never npm install.',
  });
  return task.id;
}

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (server) {
      await server.close();
    }
  }
  while (stores.length > 0) {
    stores.pop()?.close();
  }
});

describe('crew ui', () => {
  it('serves the dashboard and the summary', async () => {
    const store = createStore();
    const taskId = seed(store);
    const server = await startUiServer(store, { port: 0 });
    servers.push(server);

    const page = await fetchJson(`${server.url}/`);
    expect(page.status).toBe(200);
    expect(String(page.body)).toContain('crew');

    const summary = await fetchJson(`${server.url}/api/summary`);
    expect(summary.status).toBe(200);
    expect(summary.body.totalTasks).toBe(1);
    expect(summary.body.counts.queued).toBe(1);
    expect(summary.body.memory[0].title).toBe('Use pnpm');
    expect(summary.body.tasks[0].taskId).toBe(taskId);

    const tasks = await fetchJson(`${server.url}/api/tasks`);
    expect(tasks.status).toBe(200);
    expect(tasks.body.tasks).toHaveLength(1);

    const detail = await fetchJson(`${server.url}/api/tasks/${taskId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.summary.taskId).toBe(taskId);
    expect(Array.isArray(detail.body.events)).toBe(true);

    const missing = await fetchJson(`${server.url}/api/tasks/tsk_missing`);
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe('TASK_NOT_FOUND');

    const events = await fetchJson(`${server.url}/api/events?task=${taskId}`);
    expect(events.status).toBe(200);
    expect(events.body.events.length).toBeGreaterThan(0);

    const notFound = await fetchJson(`${server.url}/nope`);
    expect(notFound.status).toBe(404);
  });
});
