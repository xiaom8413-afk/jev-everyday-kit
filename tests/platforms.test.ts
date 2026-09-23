import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubClient, parseRepo, repoSlug, renderCatalog } from '../packages/cli/src/github';
import { FeishuClient, configSchema, makePlan, applyPlan, planSchema, fieldText } from '../packages/cli/src/feishu';
import { demoFeedbackDecide, demoRepoDecide, demoRepos } from '../packages/core/src/demo';
import { classifyRepos } from '../packages/core/src/classify';
const githubRepo = (i: number, privateRepo = false) => ({ full_name: `owner/repo${i}`, description: 'Tool', language: 'TypeScript', topics: ['tools'], archived: false, stargazers_count: 10, private: privateRepo });
test('GitHub pagination reads all pages, excludes private repos, and reports caps', async () => {
  let calls = 0;
  const client = new GitHubClient('test-token', async url => {
    const page = new URL(String(url)).searchParams.get('page'); calls++;
    return Response.json(page === '1' ? Array.from({ length: 100 }, (_, i) => githubRepo(i, i === 0)) : [githubRepo(100)]);
  });
  const all = await client.stars('octocat', 500);
  assert.equal(all.repos.length, 100); assert.equal(all.limited, false); assert.equal(calls, 2);
  const capped = await client.stars('octocat', 3); assert.equal(capped.repos.length, 3); assert.equal(capped.limited, true);
});
test('GitHub validates repo references and constructs canonical links', () => {
  assert.equal(repoSlug('https://github.com/a/b.git'), 'a/b');
  for (const value of ['https://evil.com/a/b', '../secrets', 'https://github.com/a/b/issues', 'https://user:pass@github.com/a/b', 'https://github.com/a/b?x=1']) assert.throws(() => repoSlug(value));
  assert.equal(parseRepo({ ...githubRepo(1), html_url: 'javascript:alert(1)' })?.html_url, 'https://github.com/owner/repo1');
});
test('Catalog escapes untrusted descriptions and marks demo and truncation', async () => {
  const result = await classifyRepos([{ ...demoRepos[0]!, description: '<script>alert(1)</script> | [link](javascript:bad)\n# Title' }], demoRepoDecide);
  const md = renderCatalog(result, { demo: true, limited: true });
  assert.ok(!md.includes('<script>')); assert.ok(md.includes('\\|')); assert.ok(md.includes('演示数据')); assert.ok(md.includes('上限'));
});
const config = configSchema.parse({ appToken: 'app123', tableId: 'tbl123', sourceField: '反馈', fields: { category: '分类', priority: '优先级', status: '状态', confidence: '把握' } });
const records = [
  { record_id: 'rec1', fields: { 反馈: [{ type: 'text', text: '所有用户付款失败' }] } },
  { record_id: 'rec2', fields: { 反馈: '增加深色模式', 分类: '人工分类' } },
  { record_id: 'rec3', fields: { 反馈: ' ' } },
];
test('Feishu only plans nonempty records with entirely blank output fields', async () => {
  const plan = await makePlan(records, config, demoFeedbackDecide);
  assert.equal(plan.entries.length, 1); assert.equal(plan.skipped, 2); assert.equal(plan.entries[0]?.fields.分类, '故障反馈');
  assert.equal(fieldText([{ text: 'hello' }, { text: ' world' }]), 'hello world');
  assert.throws(() => fieldText(99));
  assert.throws(() => configSchema.parse({ ...config, sourceField: '分类' }));
});
test('Feishu apply is idempotent, detects stale input, and preserves human edits', async () => {
  const plan = await makePlan([records[0]!], config, demoFeedbackDecide);
  let current: { record_id: string; fields: Record<string, unknown> } = structuredClone(records[0]!);
  let writes = 0;
  const client = { validateFields: async () => {}, record: async () => current, update: async (_: unknown, entries: typeof plan.entries) => {
    writes++; current.fields = { ...current.fields, ...entries[0]!.fields };
  } };
  const first = await applyPlan(plan, client); assert.deepEqual(first.updated, ['rec1']);
  const second = await applyPlan(plan, client); assert.deepEqual(second.alreadyApplied, ['rec1']); assert.equal(writes, 1);
  current.fields.反馈 = '内容已经修改';
  assert.deepEqual((await applyPlan(plan, client)).conflicts, ['rec1']); assert.equal(writes, 1);
  current = { record_id: 'rec1', fields: { ...records[0]!.fields, 分类: '人工处理' } };
  assert.deepEqual((await applyPlan(plan, client)).conflicts, ['rec1']); assert.equal(writes, 1);
});
test('Demo plans and unexpected write fields are rejected', async () => {
  const plan = await makePlan([records[0]!], config, demoFeedbackDecide, true);
  const client = { validateFields: async () => { throw new Error('should not call'); }, record: async () => records[0]!, update: async () => {} };
  await assert.rejects(applyPlan(plan, client), /演示计划/);
  const extra = structuredClone(plan); extra.entries[0]!.fields.负责人 = 'someone'; assert.throws(() => planSchema.parse(extra));
  const duplicate = structuredClone(plan); duplicate.entries.push(duplicate.entries[0]!); assert.throws(() => planSchema.parse(duplicate));
});
test('Feishu API token, field validation, record paging and write payload match the documented contract', async () => {
  const requests: { url: string; body: unknown }[] = [];
  const mock: typeof fetch = async (url, init) => {
    const address = String(url); requests.push({ url: address, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (address.includes('/auth/')) return Response.json({ code: 0, tenant_access_token: 'test-only-token' });
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer test-only-token');
    if (address.includes('/fields?')) return Response.json({ code: 0, data: { items: ['反馈', '分类', '优先级', '状态', '把握'].map(field_name => ({ field_name, type: 1 })), has_more: false } });
    if (address.includes('/batch_update')) return Response.json({ code: 0, data: { records: [{ record_id: 'rec1' }] } });
    if (address.includes('/records/search?')) {
      assert.equal(init?.method, 'POST');
      assert.deepEqual(JSON.parse(String(init?.body)).field_names, ['反馈', '分类', '优先级', '状态', '把握']);
      return Response.json({ code: 0, data: { items: [records[0]], has_more: false } });
    }
    assert.ok(address.endsWith('/records/batch_get'));
    assert.deepEqual(JSON.parse(String(init?.body)), { record_ids: ['rec1'] });
    return Response.json({ code: 0, data: { records: [records[0]] } });
  };
  const client = await FeishuClient.login('app-id', 'app-secret', mock);
  await client.validateFields(config); const data = await client.records(config, 10); assert.equal(data.records.length, 1);
  const plan = await makePlan(data.records, config, demoFeedbackDecide); await applyPlan(plan, client);
  const write = requests.find(r => r.url.endsWith('batch_update')); assert.deepEqual(write?.body, { records: [{ record_id: 'rec1', fields: plan.entries[0]!.fields }] });
});
test('Feishu rejects business errors even when HTTP returns 200', async () => {
  const client = new FeishuClient('test', async () => Response.json({ code: 99991672, msg: 'private details' }));
  await assert.rejects(client.records(config, 10), /99991672/);
  const incomplete = new FeishuClient('test', async () => Response.json({ code: 0, data: { records: [] } }));
  const plan = await makePlan([records[0]!], config, demoFeedbackDecide);
  await assert.rejects(incomplete.update(config, plan.entries), /未确认全部写入/);
  await assert.rejects(incomplete.record(config, 'rec1'), /已被删除/);
});
