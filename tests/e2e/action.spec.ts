import { test, expect } from '@playwright/test';
import { mkdtemp, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
test('Built GitHub Action accepts workflow inputs, exports artifacts and reuses its cache', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jev-action-test-'));
  try {
    const fixture = join(dir, 'fixture.cjs');
    await writeFile(fixture, `globalThis.fetch = async (url, init) => {
      if (String(url).startsWith('https://api.github.com/')) return Response.json([{full_name:'fixture/tool', description:'A developer library', topics:['sdk'], language:'TypeScript', archived:false, stargazers_count:100, private:false}]);
      if (String(url) === 'https://api.typesafe.ai/v1/systemone') {
        if (process.env.TEST_FAIL_ON_MODEL) throw new Error('cache was not reused');
        const request = JSON.parse(init.body);
        return Response.json({answers:Object.fromEntries(Object.entries(request.questions).map(([id,q]) => { const selected = id.startsWith('category') ? 'developer' : 'library'; const keys=Object.keys(q.criteria); return [id,{type:'choice',choice:selected,confidence:0.94,probabilities:Object.fromEntries(keys.map(k=>[k,k===selected?0.94:0.06/(keys.length-1)]))}]; }))});
      }
      throw new Error('Unexpected endpoint');
    };`);
    const out = join(dir, 'catalog'); const env = { ...process.env, INPUT_USERNAME: 'fixture', 'INPUT_TYPESAFE-API-KEY': 'fixture-private-key', INPUT_LIMIT: '100', 'INPUT_OUTPUT-DIRECTORY': out, GITHUB_OUTPUT: join(dir, 'action-output'), GITHUB_STEP_SUMMARY: join(dir, 'summary') };
    const args = ['--require', fixture, resolve('dist/github-action/index.cjs')];
    const first = await exec(process.execPath, args, { env }); expect(first.stdout).toContain('1 public repositories');
    expect(await readdir(out)).toEqual(expect.arrayContaining(['catalog.md', 'catalog.html', 'catalog.json', '.jev-cache.json']));
    expect(await readFile(join(dir, 'action-output'), 'utf8')).toContain('catalog-directory=');
    expect(await readFile(join(dir, 'summary'), 'utf8')).toContain('fixture/tool');
    const second = await exec(process.execPath, args, { env: { ...env, TEST_FAIL_ON_MODEL: '1' } }); expect(second.stdout).toContain('1 cached');
    expect(await readFile(join(out, 'catalog.json'), 'utf8')).not.toContain('fixture-private-key');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
