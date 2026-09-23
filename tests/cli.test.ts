import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const exec = promisify(execFile);
test('CLI creates all three offline artifacts without credentials', async () => {
  const out = await mkdtemp(join(tmpdir(), 'jev-cli-test-'));
  try {
    const { stdout } = await exec(process.execPath, ['--import', 'tsx', 'packages/cli/src/main.ts', 'demo', '--out', out], { env: { ...process.env, TYPESAFE_API_KEY: '', FEISHU_APP_SECRET: '', GITHUB_TOKEN: '' } });
    assert.ok(stdout.includes('没有访问网络'));
    const plan = JSON.parse(await readFile(join(out, 'feishu-plan.json'), 'utf8'));
    assert.equal(plan.demo, true); assert.equal(plan.entries.length, 3); assert.equal(plan.entries[2].review, true);
    assert.ok((await readFile(join(out, 'catalog.md'), 'utf8')).includes('演示数据'));
    assert.equal(JSON.parse(await readFile(join(out, 'tabs.json'), 'utf8')).items.length, 7);
  } finally { await rm(out, { recursive: true, force: true }); }
});
test('CLI rejects conflicting sources and non-applicable flags', async () => {
  await assert.rejects(exec(process.execPath, ['--import', 'tsx', 'packages/cli/src/main.ts', 'github', '--user', 'octocat', '--repos', 'examples/repos.txt']), error => (error as { stderr: string }).stderr.includes('只能提供一个'));
  await assert.rejects(exec(process.execPath, ['--import', 'tsx', 'packages/cli/src/main.ts', 'feishu', 'apply', '--user', 'octocat']), error => (error as { stderr: string }).stderr.includes('不支持'));
});
