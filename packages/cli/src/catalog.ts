import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { classifyRepos, REPO_CATEGORIES, REPO_KINDS, REPO_LABELS, type RepoInput, type RepoDecision } from '../../core/src/classify';
import { parseAnswers, trusted, type ChoiceAnswer, type Decide } from '../../core/src/jev';
import { readJson, saveJson, saveFile } from './files';
import { renderCatalog, kindLabels } from './github';
import { renderCatalogHtml } from './catalog-html';

const category = z.string().refine(s => Object.hasOwn(REPO_LABELS, s));
const kind = z.string().refine(s => Object.hasOwn(REPO_KINDS, s));
const answerSchema = z.object({ type: z.literal('choice'), choice: z.string(), confidence: z.number().min(0).max(1), probabilities: z.record(z.string(), z.number().min(0).max(1)) });
export const repoDecisionSchema = z.object({
  full_name: z.string().regex(/^[\w.-]+\/[\w.-]+$/), description: z.string(), topics: z.array(z.string()), language: z.string().nullable(), archived: z.boolean(), stargazers_count: z.number().nonnegative(), html_url: z.string().url(),
  category, kind, review: z.boolean(), answer: answerSchema, kindAnswer: answerSchema, manual: z.boolean().optional(), note: z.string().max(1000).optional(),
});
export const catalogSchema = z.object({ version: z.literal(2), demo: z.boolean(), generatedAt: z.iso.datetime(), model: z.string(), limited: z.boolean(), repositories: z.array(repoDecisionSchema).max(10000), cached: z.number().int().nonnegative(), classified: z.number().int().nonnegative() });
export type Catalog = z.infer<typeof catalogSchema>;
export const repoEditSchema = z.object({ name: z.string(), category, kind, note: z.string().max(1000).default('') }).strict();
const cacheQuestions = { category: { type: 'choice' as const, instructions: '', criteria: REPO_CATEGORIES }, kind: { type: 'choice' as const, instructions: '', criteria: REPO_KINDS } };
export function repoCacheKey(repo: RepoInput, model: string): string {
  return createHash('sha256').update(JSON.stringify({ recipe: 2, model, criteria: [REPO_CATEGORIES, REPO_KINDS], name: repo.full_name.toLowerCase(), description: repo.description.slice(0, 1500), topics: repo.topics.slice(0, 20), language: repo.language })).digest('hex');
}
async function optionalJson(path: string): Promise<unknown> {
  try { return await readJson(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return undefined; throw error; }
}
export async function saveCatalog(out: string, catalog: Catalog): Promise<void> {
  catalog = catalogSchema.parse(catalog);
  for (const repo of catalog.repositories) repo.html_url = `https://github.com/${repo.full_name}`;
  const manualPath = join(out, catalog.demo ? '.manual-demo.json' : '.manual-overrides.json');
  const stored = z.record(z.string(), repoDecisionSchema).safeParse(await optionalJson(manualPath));
  const manual = stored.success ? stored.data : {};
  for (const repo of catalog.repositories.filter(r => r.manual)) manual[repo.full_name.toLowerCase()] = repo;
  if (Object.keys(manual).length) await saveJson(manualPath, manual);
  await saveFile(join(out, 'catalog.md'), renderCatalog(catalog.repositories, catalog));
  await saveFile(join(out, 'catalog.html'), renderCatalogHtml(catalog));
  await saveJson(join(out, 'catalog.json'), catalog);
}
export async function buildCatalog(repos: RepoInput[], decide: Decide, options: {
  out: string; model: string; demo?: boolean; limited?: boolean; refresh?: boolean; threshold?: number; signal?: AbortSignal;
  progress?: (done: number, total: number, cached: number) => void | Promise<void>;
}): Promise<Catalog> {
  const threshold = options.threshold ?? 0.75;
  const cachePath = join(options.out, '.jev-cache.json');
  const raw = options.demo || options.refresh ? undefined : await optionalJson(cachePath);
  const cache = z.record(z.string(), z.unknown()).safeParse(raw);
  const entries = cache.success ? cache.data : {};
  const old = catalogSchema.safeParse(await optionalJson(join(options.out, 'catalog.json')));
  const savedManual = z.record(z.string(), repoDecisionSchema).safeParse(await optionalJson(join(options.out, options.demo ? '.manual-demo.json' : '.manual-overrides.json')));
  const overrides = new Map([
    ...(old.success && old.data.demo === !!options.demo ? old.data.repositories.filter(r => r.manual) : []).map(r => [r.full_name.toLowerCase(), r] as const),
    ...Object.entries(savedManual.success ? savedManual.data : {}),
  ]);
  const results = new Map<string, RepoDecision>(); const pending: RepoInput[] = []; let cached = 0;
  const unique = [...new Map(repos.map(r => [r.full_name.toLowerCase(), r])).values()];
  for (const repo of unique) {
    const manual = overrides.get(repo.full_name.toLowerCase());
    if (manual) { results.set(repo.full_name, { ...manual, ...repo }); cached++; continue; }
    const key = repoCacheKey(repo, options.model);
    try {
      const answers = parseAnswers({ answers: entries[key] }, cacheQuestions);
      const answer = answers.category!, kindAnswer = answers.kind!;
      const review = !trusted(answer, threshold) || answer.choice === 'other';
      results.set(repo.full_name, { ...repo, category: review ? 'other' : answer.choice, kind: trusted(kindAnswer, threshold) ? kindAnswer.choice : 'other', review, answer, kindAnswer }); cached++;
    } catch { pending.push(repo); }
  }
  await options.progress?.(cached, unique.length, cached);
  for (let i = 0; i < pending.length; i += 10) {
    options.signal?.throwIfAborted();
    const batch = await classifyRepos(pending.slice(i, i + 10), decide, { threshold, signal: options.signal });
    for (const repo of batch) {
      results.set(repo.full_name, repo);
      entries[repoCacheKey(repo, options.model)] = { category: repo.answer, kind: repo.kindAnswer };
    }
    // A completed batch survives cancellation or a failure in a later batch.
    if (!options.demo) await saveJson(cachePath, entries);
    await options.progress?.(results.size, unique.length, cached);
  }
  options.signal?.throwIfAborted();
  const catalog: Catalog = { version: 2, demo: !!options.demo, generatedAt: new Date().toISOString(), model: options.model, limited: !!options.limited, repositories: unique.map(r => results.get(r.full_name)!), cached, classified: pending.length };
  await saveCatalog(options.out, catalog);
  return catalog;
}
export function editCatalog(catalog: Catalog, edit: z.infer<typeof repoEditSchema>): Catalog {
  edit = repoEditSchema.parse(edit);
  const repo = catalog.repositories.find(r => r.full_name === edit.name);
  if (!repo) throw new Error('未找到该仓库。');
  return { ...catalog, repositories: catalog.repositories.map(r => r === repo ? { ...r, category: edit.category, kind: edit.kind, note: edit.note, manual: true, review: edit.category === 'other' } : r) };
}
