import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCatalog, editCatalog, saveCatalog, repoCacheKey } from '../packages/cli/src/catalog';
import { demoRepos, demoRepoDecide, demoFeedbackDecide } from '../packages/core/src/demo';
import { configSchema, makePlan, editPlan, applyPlan, rollbackPlan, FeishuClient, type ApplyReceipt } from '../packages/cli/src/feishu';

test('Catalog cache reuses decisions, invalidates changed content, and preserves manual edits', async () => {
  const out = await mkdtemp(join(tmpdir(), 'jev-cache-test-')); let calls = 0;
  const decide: typeof demoRepoDecide = async request => { calls++; return demoRepoDecide(request); };
  try {
    const first = await buildCatalog(demoRepos.slice(0, 1), decide, { out, model: 'test' }); assert.equal(first.classified, 1);
    const second = await buildCatalog(demoRepos.slice(0, 1), decide, { out, model: 'test' }); assert.equal(second.cached, 1); assert.equal(calls, 1);
    await buildCatalog([{ ...demoRepos[0]!, stargazers_count: 9999 }], decide, { out, model: 'test' }); assert.equal(calls, 1);
    const changed = await buildCatalog([{ ...demoRepos[0]!, description: 'new description' }], decide, { out, model: 'test' }); assert.equal(calls, 2);
    await saveCatalog(out, editCatalog(changed, { name: demoRepos[0]!.full_name, category: 'developer', kind: 'cli', note: 'My note' }));
    const edited = await buildCatalog(demoRepos.slice(0, 1), decide, { out, model: 'other', refresh: true }); assert.equal(calls, 2); assert.equal(edited.repositories[0]?.manual, true); assert.equal(edited.repositories[0]?.category, 'developer');
    assert.ok((await readFile(join(out, 'catalog.html'), 'utf8')).includes('My note'));
    assert.notEqual(repoCacheKey(demoRepos[0]!, 'a'), repoCacheKey(demoRepos[0]!, 'b'));
  } finally { await rm(out, { recursive: true, force: true }); }
});
test('Demo decisions never populate the live model cache', async () => {
  const out = await mkdtemp(join(tmpdir(), 'jev-demo-cache-'));
  try { await buildCatalog(demoRepos, demoRepoDecide, { out, model: 'test', demo: true }); assert.ok(!(await readdir(out)).includes('.jev-cache.json')); }
  finally { await rm(out, { recursive: true, force: true }); }
});
const config = configSchema.parse({ appToken: 'app1', tableId: 'tbl1', viewId: 'vew1', sourceField: '内容', fields: { category: '分类', priority: '优先级', status: '状态', confidence: '把握' } });
test('Feishu fetches pending records using the server filter and preserves view paging', async () => {
  let calls = 0;
  const client = new FeishuClient('test', async (url, init) => {
    const data = JSON.parse(String(init?.body)); assert.equal(data.view_id, 'vew1'); assert.equal(data.filter.conjunction, 'and');
    assert.deepEqual(data.filter.conditions.map((c: any) => c.operator), ['isNotEmpty', 'isEmpty', 'isEmpty', 'isEmpty', 'isEmpty']);
    calls++; if (calls === 2) assert.equal(new URL(String(url)).searchParams.get('page_token'), 'next');
    return Response.json({ code: 0, data: { items: [{ record_id: `rec${calls}`, fields: { 内容: 'Feedback' } }], has_more: calls === 1, page_token: 'next' } });
  });
  const result = await client.records(config, 10); assert.equal(result.records.length, 2); assert.equal(result.limited, false);
});
test('Feishu review excludes records; successful writes can be rolled back without clearing human changes', async () => {
  const records = ['a', 'b', 'c'].map((id, i) => ({ record_id: id, fields: { 内容: `Feedback ${i}` } as Record<string, unknown> }));
  let plan = await makePlan(records, config, demoFeedbackDecide);
  plan = editPlan(plan, { recordId: 'b', excluded: true });
  plan = editPlan(plan, { recordId: 'c', category: 'question', priority: 'low' });
  assert.equal(plan.entries[2]?.fields.状态, '人工已确认'); assert.equal(plan.entries[2]?.review, false);
  const client = { validateFields: async () => {}, record: async (_: unknown, id: string) => records.find(r => r.record_id === id)!, update: async (_: unknown, entries: { recordId: string; fields: Record<string, string> }[]) => { for (const e of entries) Object.assign(records.find(r => r.record_id === e.recordId)!.fields, e.fields); } };
  const receipt = await applyPlan(plan, client); assert.deepEqual(receipt.updated, ['a', 'c']); assert.equal(records[1]!.fields.分类, undefined);
  records[2]!.fields.分类 = '人工重新改过';
  const rollback = await rollbackPlan(plan, receipt, client); assert.deepEqual(rollback.restored, ['a']); assert.deepEqual(rollback.conflicts, ['c']); assert.equal(records[0]!.fields.分类, ''); assert.equal(records[2]!.fields.分类, '人工重新改过');
});
test('Feishu keeps durable receipts on partial failure and resumes with ownership history', async () => {
  const records = ['a', 'b', 'c'].map((id, i) => ({ record_id: id, fields: { 内容: `Feedback ${i}` } as Record<string, unknown> }));
  const plan = await makePlan(records, config, demoFeedbackDecide); let fail = true; let latest: ApplyReceipt | undefined;
  const client = { validateFields: async () => {}, record: async (_: unknown, id: string) => records.find(r => r.record_id === id)!, update: async (_: unknown, entries: { recordId: string; fields: Record<string, string> }[]) => { for (const e of entries) { if (fail && e.recordId === 'b') throw new Error('Temporary failure'); Object.assign(records.find(r => r.record_id === e.recordId)!.fields, e.fields); } } };
  const receipt = await applyPlan(plan, client, async value => { latest = value; });
  assert.equal(latest?.failed.length, 1); assert.equal(receipt.operations.length, 2); fail = false;
  const retry = await applyPlan(plan, client, async () => {}, { previous: receipt }); assert.equal(retry.operations.length, 3); assert.equal(retry.failed.length, 0); assert.equal(retry.updated.length, 3);
  await assert.rejects(applyPlan(editPlan(plan, { recordId: 'a', excluded: true }), client, async () => {}, { previous: receipt }), /计划已修改/);
});
test('Feishu cancellation retains pending records and performs no new writes', async () => {
  const plan = await makePlan([{ record_id: 'a', fields: { 内容: 'test' } }], config, demoFeedbackDecide); const controller = new AbortController(); controller.abort();
  const receipt = await applyPlan(plan, { validateFields: async () => {}, record: async () => { throw new Error('must not read'); }, update: async () => { throw new Error('must not write'); } }, async () => {}, { signal: controller.signal });
  assert.equal(receipt.cancelled, true); assert.deepEqual(receipt.pending, ['a']); assert.equal(receipt.updated.length, 0);
});
