import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildCatalog } from '../packages/cli/src/catalog';
import { demoRepos, demoRepoDecide } from '../packages/core/src/demo';

test('Completed GitHub batches survive a later failure and are reused on retry', async () => {
  const out = await mkdtemp(join(tmpdir(), 'jev-recovery-'));
  const repos = Array.from({ length: 13 }, (_, i) => ({ ...demoRepos[0]!, full_name: `fixture/repo${i}`, html_url: `https://github.com/fixture/repo${i}` }));
  let calls = 0;
  try {
    await assert.rejects(buildCatalog(repos, async request => { calls++; if (calls === 2) throw new Error('Rate limited'); return demoRepoDecide(request); }, { out, model: 'fixture' }), /Rate limited/);
    assert.ok((await readdir(out)).includes('.jev-cache.json'));
    assert.ok(!(await readdir(out)).includes('catalog.json'));
    const resumed = await buildCatalog(repos, demoRepoDecide, { out, model: 'fixture' });
    assert.equal(resumed.cached, 10); assert.equal(resumed.classified, 3); assert.equal(resumed.repositories.length, 13);
  } finally { await rm(out, { recursive: true, force: true }); }
});
