// Exercise the built server with runtime-only configuration and synthetic data.
// No production environment, credentials, database, or source files are used.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import Database from 'better-sqlite3';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mot-ticket-only-smoke-'));
const socket = net.createServer();
socket.listen(0, '127.0.0.1');
await once(socket, 'listening');
const port = socket.address().port;
await new Promise(resolve => socket.close(resolve));
const base = `http://127.0.0.1:${port}`;
const graphPath = path.join(dir, 'graph.jsonl');
const fixture = JSON.stringify({ id: 'synthetic-smoke-entity', type: 'Fact', label: 'Synthetic fixture',
  properties: {}, confidence: 0.9, confirmed: false, superseded_by: null,
  valid_from: '2026-01-01T00:00:00Z', valid_until: null, source: 'manual' }) + '\n';
fs.writeFileSync(graphPath, fixture);
const apiKey = 'synthetic-ticket-only-smoke-api-key';
const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '-p', String(port)], {
  cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    PATH: process.env.PATH, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1',
    DATABASE_URL: path.join(dir, 'smoke.db'), MOT_GRAPH_PATH: graphPath,
    MOT_PROFILE_DIR: dir, BACKUP_PATH: path.join(dir, 'backups'),
    MOT_API_KEY: apiKey, MOT_UI_USERNAME: 'smoke', MOT_UI_PASSWORD: 'synthetic-smoke-password',
    MOT_SESSION_SECRET: 'synthetic-smoke-session-secret-long-enough',
    MOT_MEMORY_DISABLE: '1', SURFACING_ENABLE: '1',
    // Deliberately no MOT_EMBED_DISABLE: the master switch alone prevents warm-up.
  },
});
let logs = '';
child.stdout.on('data', chunk => { logs += chunk; });
child.stderr.on('data', chunk => { logs += chunk; });
let spawnError;
child.on('error', error => { spawnError = error; });
const exited = once(child, 'exit');
const auth = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };

async function request(route, options = {}) {
  return fetch(base + route, { ...options, signal: AbortSignal.timeout(5000) });
}
try {
  let ready = false;
  for (let n = 0; n < 100; n++) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) throw new Error('Server exited before ready');
    try { ready = (await request('/api/status')).status === 200; } catch { /* starting */ }
    if (ready) break;
    await delay(200);
  }
  assert(ready, 'Server never became healthy');
  assert([301, 302, 303, 307, 308].includes((await request('/', { redirect: 'manual' })).status));
  assert.equal((await request('/api/memory')).status, 401);
  for (const [route, method] of [['/api/memory', 'GET'], ['/api/conversation', 'POST']]) {
    const response = await request(route, { method, headers: auth, ...(method === 'POST' ? { body: 'invalid JSON' } : {}) });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'memory_disabled' });
  }
  const rpc = async (method, params) => (await (await request('/api/mcp', {
    method: 'POST', headers: auth, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })).json()).result;
  const tools = (await rpc('tools/list', {})).tools.map(tool => tool.name).sort();
  assert.deepEqual(tools, ['mot_list_tickets', 'mot_get_ticket', 'mot_create_ticket', 'mot_update_ticket',
    'mot_get_status', 'mot_get_ministry_config', 'notify_robin', 'deploy_drift_check'].sort());
  assert.deepEqual(await rpc('tools/call', { name: 'chat_log_turn', arguments: { content: 'Denied fixture' } }), {
    isError: true, content: [{ type: 'text', text: 'M.O.T. memory is disabled' }],
  });
  const created = await request('/api/tickets', { method: 'POST', headers: auth,
    body: JSON.stringify({ title: 'Synthetic smoke ticket', ministry: 'works', severity: 'normal',
      ticket_type: 'infra-alert', provenance: 'manual', body: 'Synthetic smoke body' }),
  });
  assert.equal(created.status, 201);
  const { id } = await created.json();
  const updated = await request(`/api/tickets/${id}`, { method: 'PATCH', headers: auth, body: JSON.stringify({ status: 'watching' }) });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).ticket.status, 'watching');
  assert.equal((await request(`/api/tickets/${id}`, { headers: auth })).status, 200);
  const login = await request('/api/auth/login', { method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'smoke', password: 'synthetic-smoke-password' }),
  });
  assert.equal(login.status, 303);
  assert(!login.headers.get('location').includes('error'), 'Synthetic login was refused');
  const cookie = login.headers.get('set-cookie').split(';')[0];
  for (const route of ['/memory/entities', '/memory/procedural', '/memory/topics']) {
    const page = await request(route, { headers: { Cookie: cookie } });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert(html.includes('M.O.T. memory is disabled.'));
    assert(!html.includes('Synthetic fixture'));
  }
  assert.equal(fs.readFileSync(graphPath, 'utf8'), fixture);
  const database = new Database(path.join(dir, 'smoke.db'), { readonly: true });
  try {
    for (const table of ['conversation', 'session_digest', 'memory_items', 'procedural_notes',
      'topic_thread', 'surfaced_ledger', 'vec_meta', 'tool_call_log']) {
      assert.equal(database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, table);
    }
  } finally { database.close(); }
  assert(!logs.includes('[MOT/embed] boot warmup'), 'Disabled boot attempted model warm-up');
  console.log('Ticket-only built-server smoke passed: memory refused; tickets, auth and health active; source fixture unchanged.');
} catch (error) {
  // All captured output belongs to this isolated synthetic server.
  console.error(logs);
  throw error;
} finally {
  if (child.exitCode === null && !spawnError) {
    child.kill('SIGTERM');
    const forceStop = setTimeout(() => child.kill('SIGKILL'), 5000);
    await exited;
    clearTimeout(forceStop);
  }
  fs.rmSync(dir, { recursive: true, force: true });
}
