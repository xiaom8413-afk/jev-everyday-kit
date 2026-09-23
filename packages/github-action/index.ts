import { appendFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createJev } from '../core/src/jev';
import { GitHubClient, renderCatalog } from '../cli/src/github';
import { buildCatalog } from '../cli/src/catalog';

async function run() {
  const input = (name: string) => process.env[`INPUT_${name.toUpperCase()}`]?.trim() ?? '';
  const username = input('username');
  if (!username) throw new Error('username is required');
  const limit = Number(input('limit') || 100);
  if (!Number.isInteger(limit) || limit < 1 || limit > 10000) throw new Error('limit must be 1–10000');
  const output = input('output-directory') || 'jev-catalog';
  if (/[\r\n]/.test(output)) throw new Error('Invalid output directory');
  const threshold = Number(input('threshold') || 0.75); if (!Number.isFinite(threshold) || threshold < 0.5 || threshold > 0.99) throw new Error('threshold must be 0.5–0.99');
  const model = input('model') || 'jev-latest'; const decide = createJev({ apiKey: input('typesafe-api-key'), model });
  const { repos, limited } = await new GitHubClient(input('github-token')).stars(username, limit);
  const out = resolve(output); const catalog = await buildCatalog(repos, decide, { out, model, limited, threshold, refresh: input('refresh') === 'true' });
  const md = renderCatalog(catalog.repositories, catalog);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `catalog-directory=${out}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, md);
  console.log(`Organized ${catalog.repositories.length} public repositories; ${catalog.cached} cached.${limited ? ' Limit reached.' : ''}`);
}
run().catch(() => { console.error('Jev Star Atlas failed. Check inputs, TypeSafe access, GitHub rate limits, and network access.'); process.exitCode = 1; });
