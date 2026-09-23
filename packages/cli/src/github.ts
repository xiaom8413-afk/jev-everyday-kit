import { z } from 'zod';
import { classifyRepos, REPO_LABELS, REPO_KINDS, type RepoInput, type RepoDecision } from '../../core/src/classify';
import { certainty, type Decide } from '../../core/src/jev';
import { jsonRequest } from './http';

const repoSchema = z.object({ full_name: z.string().regex(/^[\w.-]+\/[\w.-]+$/), description: z.string().nullable(), topics: z.array(z.string()).default([]), language: z.string().nullable(), archived: z.boolean(), stargazers_count: z.number().nonnegative(), private: z.boolean() });
export function parseRepo(data: unknown): RepoInput | null {
  const r = repoSchema.parse(data);
  if (r.private) return null;
  return { full_name: r.full_name, description: r.description ?? '', topics: r.topics, language: r.language, archived: r.archived, stargazers_count: r.stargazers_count, html_url: `https://github.com/${r.full_name}` };
}
export function repoSlug(value: string): string {
  let slug = value.trim();
  if (slug.startsWith('https://')) {
    const url = new URL(slug);
    if (url.hostname !== 'github.com' || url.username || url.password || url.search || url.hash) throw new Error('仓库地址必须是 https://github.com/owner/repo。');
    slug = url.pathname.replace(/^\/|\/$/g, '');
  }
  slug = slug.replace(/\.git$/, '');
  if (!/^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9_.-]+$/.test(slug) || slug.split('/').some(s => s === '.' || s === '..')) throw new Error(`无效的 GitHub 仓库格式。请使用 owner/repo。`);
  return slug;
}
export class GitHubClient {
  constructor(private token = '', private fetcher: typeof fetch = fetch, private signal?: AbortSignal) {}
  private get(path: string) {
    this.signal?.throwIfAborted();
    return jsonRequest(`https://api.github.com${path}`, { signal: this.signal, headers: {
      Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': 'jev-everyday-kit',
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
    } }, this.fetcher);
  }
  async stars(username: string, limit: number, onPage?: (count: number) => void): Promise<{ repos: RepoInput[]; limited: boolean }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 10000) throw new Error('仓库上限必须在 1–10000 之间。');
    if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(username)) throw new Error('GitHub 用户名格式不正确。');
    const repos: RepoInput[] = [], seen = new Set<string>();
    // Fetch an extra public item to distinguish a complete list from a capped one.
    for (let page = 1; page <= 100; page++) {
      const raw = z.array(z.unknown()).parse(await this.get(`/users/${encodeURIComponent(username)}/starred?per_page=100&page=${page}&sort=created&direction=desc`));
      for (const item of raw) {
        const repo = parseRepo(item);
        if (repo && !seen.has(repo.full_name.toLowerCase())) { seen.add(repo.full_name.toLowerCase()); repos.push(repo); }
        if (repos.length > limit) return { repos: repos.slice(0, limit), limited: true };
      }
      onPage?.(repos.length);
      if (raw.length < 100) return { repos, limited: false };
    }
    return { repos, limited: true };
  }
  async repositories(slugs: string[]): Promise<RepoInput[]> {
    const repos: RepoInput[] = [];
    for (const slug of [...new Set(slugs.map(repoSlug))]) {
      const repo = parseRepo(await this.get(`/repos/${slug.split('/').map(encodeURIComponent).join('/')}`));
      if (repo) repos.push(repo);
    }
    return repos;
  }
}
export const markdownText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\\`*_[\]{}()#!|~]/g, '\\$&').replace(/[\r\n]+/g, ' ');
export const kindLabels: Record<keyof typeof REPO_KINDS, string> = { app: '应用', cli: 'CLI', library: '库 / 框架', service: '服务', resource: '资源', other: '待确认' };
export function renderCatalog(repos: RepoDecision[], options: { demo?: boolean; limited?: boolean; generatedAt?: string } = {}): string {
  const lines = ['# 我的 GitHub 工具箱', '', options.demo ? '> 演示数据 · 分类为固定样例，未调用 Jev。' : '> 由 Jev 分类。简介来自 GitHub；分类仅供整理参考。', '',
    `共 ${repos.length} 个仓库 · ${repos.filter(r => r.review).length} 个待确认 · ${options.generatedAt ?? new Date().toISOString()}`, ''];
  if (options.limited) lines.push('> 已达到本次数量上限，目录不代表全部 Star。调高 --limit 可继续扩大范围。', '');
  for (const [key, label] of Object.entries(REPO_LABELS)) {
    const group = repos.filter(r => r.category === key).sort((a, b) => b.stargazers_count - a.stargazers_count || a.full_name.localeCompare(b.full_name));
    if (!group.length) continue;
    lines.push(`## ${label} · ${group.length}`, '', '| 工具 | 用途 | 形态 | 语言 | 判断把握 |', '| --- | --- | --- | --- | --- |');
    for (const r of group) lines.push(`| [${markdownText(r.full_name)}](${r.html_url})${r.archived ? ' · 已归档' : ''} | ${markdownText(r.description || '暂无简介')}${r.note ? ` · 备注：${markdownText(r.note)}` : ''} | ${kindLabels[r.kind as keyof typeof REPO_KINDS] ?? '待确认'} | ${markdownText(r.language ?? '—')} | ${r.manual ? '人工确认' : `${Math.round(certainty(r.answer) * 100)}%${r.review ? ' · 待确认' : ''}`} |`);
    lines.push('');
  }
  return lines.join('\n');
}
export { classifyRepos };
