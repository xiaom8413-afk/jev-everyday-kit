import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startStudio } from '../packages/studio/src/server';
import { FeishuClient } from '../packages/cli/src/feishu';
import { demoFeedbackDecide } from '../packages/core/src/demo';
import type { StudioJob } from '../packages/studio/src/server';
import { request as httpRequest } from 'node:http';
const config = { appToken: 'app1', tableId: 'tbl1', sourceField: '反馈', fields: { category: '分类', priority: '优先级', status: '状态', confidence: '把握' } };
async function setup(extra: object = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'jev-studio-test-'));
  const server = await startStudio({ port: 0, dataDir: dir, assetsDir: resolve('packages/studio/public'), ...extra });
  const html = await (await fetch(server.origin)).text(); const token = html.match(/name="jev-session" content="([a-f0-9]+)"/)![1]!;
  const request = (path: string, body?: unknown, headers = {}) => fetch(`${server.origin}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Jev-Session': token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const api = async (path: string, data?: unknown) => { const response = await request(path, data); return { status: response.status, data: await response.json() }; };
  const wait = async (id: string) => { for (let i = 0; i < 100; i++) { const result = await api(`/api/jobs/${id}`); if (result.data.state !== 'running') return result.data as StudioJob; await new Promise(r => setTimeout(r, 10)); } throw new Error('job did not finish'); };
  return { ...server, dir, request, api, wait, cleanup: async () => { await server.close(); await rm(dir, { recursive: true, force: true }); } };
}
test('Studio rejects cross-origin, forged-host, unauthenticated and invalid writes', async () => {
  const s = await setup();
  try {
    assert.equal((await fetch(`${s.origin}/api/state`)).status, 403);
    assert.equal((await s.request('/api/state', undefined, { Origin: 'https://attacker.invalid' })).status, 403);
    const forgedHost = await new Promise<number>(resolve => { const req = httpRequest(`${s.origin}/api/state`, { headers: { Host: 'attacker.invalid' } }, res => { res.resume(); resolve(res.statusCode!); }); req.end(); });
    assert.equal(forgedHost, 403);
    assert.equal((await s.api('/api/github', { demo: true, limit: -1 })).status, 400);
    assert.equal((await s.api('/api/github', { user: 'octocat', repos: 'a/b' })).status, 400);
    assert.equal((await s.api('/api/jobs/../../.env')).status, 404);
  } finally { await s.cleanup(); }
});
test('Studio session credentials never appear in state, history or files', async () => {
  const s = await setup();
  try {
    const secret = 'fixture-private-key-never-persist'; await s.api('/api/session', { typesafe: secret, feishuSecret: secret });
    const state = await s.api('/api/state'); assert.equal(state.data.credentials.typesafe, true); assert.ok(!JSON.stringify(state).includes(secret));
    const start = await s.api('/api/github', { demo: true }); await s.wait(start.data.id);
    for (const file of (await readdir(join(s.dir, 'jobs'))).filter(f => f.endsWith('.json'))) assert.ok(!(await readFile(join(s.dir, 'jobs', file), 'utf8')).includes(secret));
    await s.api('/api/session', { clear: ['typesafe', 'feishuSecret'] }); assert.equal((await s.api('/api/state')).data.credentials.typesafe, false);
  } finally { await s.cleanup(); }
});
test('Studio supports complete demo workflows, edits, downloads and history', async () => {
  const s = await setup();
  try {
    const start = await s.api('/api/github', { demo: true }); assert.equal(start.status, 202); const job = await s.wait(start.data.id); assert.equal(job.state, 'complete');
    const edited = await s.api(`/api/jobs/${job.id}/edit`, { name: 'example/mystery', category: 'learning', kind: 'resource', note: '<script>private note</script>' }); assert.equal(edited.status, 200);
    const html = await (await s.request(`/api/jobs/${job.id}/download?format=html`)).text(); assert.ok(!html.includes('<script>private note</script>')); assert.ok(html.includes('\\u003cscript'));
    const feedback = await s.api('/api/feishu', { demo: true, config }); const plan = await s.wait(feedback.data.id); assert.equal(plan.state, 'complete');
    const excluded = await s.api(`/api/jobs/${plan.id}/edit`, { recordId: 'demo002', excluded: true }); assert.equal(excluded.data.result.entries[1].excluded, true);
    assert.equal((await s.api(`/api/jobs/${plan.id}/apply`, {})).status, 400);
    assert.equal((await s.api('/api/state')).data.jobs.length, 2);
  } finally { await s.cleanup(); }
});
test('Studio reads, reviews, applies and rolls back real-mode jobs against the full API fixture', async () => {
  const records = [{ record_id: 'r1', fields: { 反馈: '支付故障' } as Record<string, unknown> }];
  const fetcher: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname; const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (path.endsWith('/fields')) return Response.json({ code: 0, data: { items: ['反馈', ...Object.values(config.fields)].map(field_name => ({ field_name, type: 1 })) } });
    if (path.endsWith('/search')) return Response.json({ code: 0, data: { items: records } });
    if (path.endsWith('/batch_get')) return Response.json({ code: 0, data: { records } });
    if (path.endsWith('/batch_update')) { for (const entry of body.records) Object.assign(records[0]!.fields, entry.fields); return Response.json({ code: 0, data: { records } }); }
    throw new Error('Unexpected API endpoint');
  };
  const s = await setup({ createDecision: () => demoFeedbackDecide, feishuClient: async () => new FeishuClient('fixture', fetcher) });
  try {
    const start = await s.api('/api/feishu', { demo: false, config }); const plan = await s.wait(start.data.id); assert.equal(plan.state, 'complete');
    assert.equal((await s.api(`/api/jobs/${plan.id}/apply`, {})).status, 202); const applied = await s.wait(plan.id); assert.equal(applied.receipt?.updated.length, 1); assert.equal(records[0]!.fields.分类, '故障反馈');
    assert.equal((await s.api(`/api/jobs/${plan.id}/edit`, { recordId: 'r1', excluded: true })).status, 400);
    assert.equal((await s.api(`/api/jobs/${plan.id}/rollback`, {})).status, 202); const undone = await s.wait(plan.id); assert.equal(undone.state, 'complete'); assert.equal(records[0]!.fields.分类, '');
  } finally { await s.cleanup(); }
});
test('Studio cancellation ends the active job and prevents overlapping jobs or credential changes', async () => {
  const client = new FeishuClient('fixture', async url => {
    if (String(url).includes('/fields?')) return Response.json({ code: 0, data: { items: ['反馈', ...Object.values(config.fields)].map(field_name => ({ field_name, type: 1 })) } });
    return Response.json({ code: 0, data: { items: [{ record_id: 'r1', fields: { 反馈: 'Feedback' } }] } });
  });
  const s = await setup({ feishuClient: async () => client, createDecision: (_: unknown, signal: AbortSignal) => async () => new Promise((_resolve, reject) => { if (signal.aborted) reject(new Error('cancelled')); else signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }); }) });
  try {
    const start = await s.api('/api/feishu', { config });
    assert.equal((await s.api('/api/feishu', { config })).status, 400);
    assert.equal((await s.api('/api/session', { typesafe: 'new-key' })).status, 400);
    await s.api(`/api/jobs/${start.data.id}/cancel`, {}); const job = await s.wait(start.data.id); assert.equal(job.state, 'cancelled');
  } finally { await s.cleanup(); }
});
test('Studio reloads saved results and marks abandoned running tasks as interrupted', async () => {
  const s = await setup(); let restarted: Awaited<ReturnType<typeof startStudio>> | undefined;
  try {
    const start = await s.api('/api/github', { demo: true }); const job = await s.wait(start.data.id);
    await s.close();
    const file = join(s.dir, 'jobs', `${job.id}.json`); const saved = JSON.parse(await readFile(file, 'utf8')); saved.state = 'running'; await writeFile(file, JSON.stringify(saved));
    restarted = await startStudio({ port: 0, dataDir: s.dir, assetsDir: resolve('packages/studio/public') });
    const html = await (await fetch(restarted.origin)).text(); const token = html.match(/name="jev-session" content="([a-f0-9]+)"/)![1]!;
    const result = await (await fetch(`${restarted.origin}/api/jobs/${job.id}`, { headers: { 'X-Jev-Session': token } })).json();
    assert.equal(result.state, 'interrupted'); assert.equal(result.result.repositories.length, 4);
    const state = await (await fetch(`${restarted.origin}/api/state`, { headers: { 'X-Jev-Session': token } })).json(); assert.equal(state.credentials.typesafe, false);
  } finally { await restarted?.close(); if (s.server.listening) await s.close(); await rm(s.dir, { recursive: true, force: true }); }
});
