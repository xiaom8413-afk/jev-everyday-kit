import type { StudioJob } from './server';
import type { Catalog } from '../../cli/src/catalog';
import type { FeishuPlan, FeishuConfig } from '../../cli/src/feishu';
import type { RepoDecision } from '../../core/src/classify';
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const value = (id: string) => el<HTMLInputElement>(id).value.trim();
const checked = (id: string) => el<HTMLInputElement>(id).checked;
const token = document.querySelector<HTMLMetaElement>('meta[name=jev-session]')!.content;
interface State { credentials: { typesafe: boolean; github: boolean; feishuId: boolean; feishuSecret: boolean; model: string }; jobs: StudioJob[]; labels: { repos: Record<string, string>; kinds: Record<string, string>; feedback: Record<string, string>; priority: Record<string, string> }; demoConfig: FeishuConfig }
let state: State; let view = 'home'; const current: Partial<Record<'github' | 'feishu', StudioJob>> = {}; let editingRepo = ''; let toastTimer: ReturnType<typeof setTimeout>;
const labels: Record<string, string> = { home: '概览', github: 'GitHub 工具箱', feishu: '飞书分诊', chrome: '标签页整理', settings: '连接设置' };
function node<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = '') { const n = document.createElement(tag); n.textContent = text; n.className = className; return n; }
function toast(message: string, error = false) { clearTimeout(toastTimer); el('toast').textContent = message; el('toast').className = error ? 'error' : ''; el('toast').hidden = false; toastTimer = setTimeout(() => { el('toast').hidden = true; }, error ? 10000 : 5000); }
async function api<T = any>(path: string, data?: unknown): Promise<T> {
  let response: Response;
  try { response = await fetch(path, { method: data === undefined ? 'GET' : 'POST', headers: { 'X-Jev-Session': token, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) }); }
  catch { throw new Error('操作台连接已断开，请检查本地服务是否仍在运行。'); }
  const result = await response.json(); if (!response.ok) throw new Error(result.error || '操作失败。'); return result;
}
function safe(fn: () => void | Promise<void>) { return () => { void Promise.resolve().then(fn).catch(e => toast(e instanceof Error ? e.message : '操作失败', true)); }; }
async function busy(button: HTMLButtonElement, fn: () => Promise<void>) { button.disabled = true; try { await fn(); } finally { button.disabled = false; } }
function showView(next: string) {
  if (!Object.hasOwn(labels, next)) next = 'home'; view = next;
  for (const section of document.querySelectorAll<HTMLElement>('.view')) section.hidden = section.id !== `view-${next}`;
  for (const b of document.querySelectorAll<HTMLElement>('.nav[data-view]')) b.classList.toggle('active', b.dataset.view === next);
  el('breadcrumb').replaceChildren(node('span', '工作台'), node('span', '/'), node('span', labels[next]));
  window.location.hash = next;
}
for (const button of document.querySelectorAll<HTMLElement>('[data-view]')) button.addEventListener('click', () => showView(button.dataset.view!));
el('open-settings').addEventListener('click', () => showView('settings'));
window.addEventListener('hashchange', () => showView(location.hash.slice(1)));
function options(id: string, items: Record<string, string>, placeholder?: string) {
  const select = el<HTMLSelectElement>(id), before = select.value; select.replaceChildren();
  if (placeholder) { const option = node('option', placeholder); option.value = ''; select.append(option); }
  for (const [key, title] of Object.entries(items)) { const option = node('option', title); option.value = key; select.append(option); }
  if ([...select.options].some(o => o.value === before)) select.value = before;
}
const stateNames = { running: '运行中', complete: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断' };
async function refreshState() {
  state = await api<State>('/api/state');
  el('ready-status').textContent = state.credentials.typesafe ? 'Jev 已配置 · 可以开始整理' : '本地工作台已就绪 · 可先体验样例';
  el('cred-typesafe').textContent = state.credentials.typesafe ? '已配置' : '未配置';
  el('cred-github').textContent = state.credentials.github ? '已配置' : '可选';
  el('cred-feishu').textContent = state.credentials.feishuId && state.credentials.feishuSecret ? '已配置' : '未配置';
  if (document.activeElement !== el('model')) el<HTMLInputElement>('model').value = state.credentials.model;
  const history = el('history'); history.replaceChildren();
  for (const job of state.jobs.slice(0, 14)) {
    const button = node('button', job.title); button.title = job.title; button.append(node('span', `${stateNames[job.state]} · ${new Date(job.createdAt).toLocaleDateString('zh-CN')}`));
    button.addEventListener('click', safe(() => selectJob(job.id))); history.append(button);
  }
  if (!state.jobs.length) history.append(node('p', '完成一次整理，就会出现在这里。'));
  options('repo-category', state.labels.repos, '全部分类'); options('repo-kind', state.labels.kinds, '全部形态');
  options('edit-category', state.labels.repos); options('edit-kind', state.labels.kinds);
}
async function selectJob(id: string) {
  const job = await api<StudioJob>(`/api/jobs/${id}`); current[job.type] = job; showView(job.type); renderJob(job);
  const request = job.request as any;
  if (job.type === 'github' && !request.demo) {
    el<HTMLInputElement>('github-user').value = request.user || ''; el<HTMLTextAreaElement>('github-repos').value = request.repos || '';
    const source = document.querySelector<HTMLInputElement>(`input[name=github-source][value=${request.user ? 'user' : 'repos'}]`)!; source.checked = true; source.dispatchEvent(new Event('change'));
  }
  if (job.type === 'feishu' && !request.demo) fillConfig(request.config);
}
function renderJob(job: StudioJob) {
  const box = el(`${job.type}-progress`); box.replaceChildren(); box.hidden = false; box.classList.toggle('error', job.state === 'failed' || job.state === 'interrupted');
  const info = node('div', job.error || job.stage, 'progress-info');
  info.append(node('small', `${stateNames[job.state]}${job.total ? ` · ${job.done} / ${job.total}` : ''}`));
  if (job.state === 'running') { const track = node('div', '', 'progress-track'), bar = node('div'); bar.style.width = `${job.total ? Math.min(100, job.done / job.total * 100) : 5}%`; track.append(bar); info.append(track); }
  box.append(info);
  if (job.state === 'running') { const cancel = node('button', '取消任务', 'secondary'); cancel.addEventListener('click', safe(() => busy(cancel, async () => { await api(`/api/jobs/${job.id}/cancel`, {}); toast('已请求取消。正在进行的写入会先确认结果，再停止。'); }))); box.append(cancel); }
  else if (job.state === 'failed' || job.state === 'cancelled' || job.state === 'interrupted') {
    const retry = node('button', job.rollback ? '继续撤销' : job.receipt ? '继续未完成回填' : '重新生成', 'secondary');
    retry.addEventListener('click', safe(() => busy(retry, async () => {
      if (job.rollback) { await api(`/api/jobs/${job.id}/rollback`, {}); }
      else if (job.receipt) { await api(`/api/jobs/${job.id}/apply`, {}); }
      else { const result = await api(`/api/${job.type}`, job.request); await selectJob(result.id); }
      await refreshState();
    }))); box.append(retry);
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>(`#${job.type}-form button`)) button.disabled = job.state === 'running';
  el<HTMLButtonElement>(`${job.type}-demo`).disabled = job.state === 'running';
  el(`${job.type}-empty`).hidden = !!job.result || job.state === 'running';
  el(`${job.type}-result`).hidden = !job.result;
  if (job.result) { if (job.type === 'github') renderRepos(); else renderFeedback(); }
}
function renderRepos() {
  const job = current.github; if (!job?.result) return; const data = job.result as Catalog;
  el('repo-demo-badge').hidden = !data.demo;
  el('github-summary').textContent = `${data.repositories.length} 个工具 · ${data.repositories.filter(r => r.review).length} 个待确认 · ${data.cached} 个复用${data.limited ? ' · 已达到读取上限' : ''}`;
  const languages = Object.fromEntries([...new Set(data.repositories.map(r => r.language).filter((v): v is string => !!v))].sort().map(s => [s, s])); options('repo-language', languages, '全部语言');
  const q = value('repo-search').toLowerCase();
  const rows = data.repositories.filter(r => (!value('repo-category') || r.category === value('repo-category')) && (!value('repo-kind') || r.kind === value('repo-kind')) && (!value('repo-language') || r.language === value('repo-language')) && (!checked('repo-hide-archived') || !r.archived) && [r.full_name, r.description, r.note || '', ...r.topics].join(' ').toLowerCase().includes(q));
  rows.sort((a, b) => value('repo-sort') === 'name' ? a.full_name.localeCompare(b.full_name) : value('repo-sort') === 'review' ? Number(b.review) - Number(a.review) || b.stargazers_count - a.stargazers_count : b.stargazers_count - a.stargazers_count);
  el('repo-count').textContent = `${rows.length} / ${data.repositories.length} 个工具`;
  const grid = el('repo-grid'); grid.replaceChildren();
  for (const repo of rows) {
    const card = node('article', '', 'repo-card'), link = node('a', repo.full_name); link.href = `https://github.com/${repo.full_name}`; link.target = '_blank'; link.rel = 'noopener noreferrer';
    const meta = node('div', '', 'repo-meta'); meta.append(node('span', state.labels.repos[repo.category]), node('span', state.labels.kinds[repo.kind]));
    if (repo.review) meta.append(node('span', '待确认', 'review-badge')); if (repo.archived) meta.append(node('span', '已归档'));
    const bottom = node('div', '', 'repo-bottom'); bottom.append(node('span', `★ ${repo.stargazers_count.toLocaleString()} · ${repo.language || '—'}${repo.manual ? ' · 人工确认' : ''}`));
    const edit = node('button', '调整分类'); edit.addEventListener('click', () => openEdit(repo)); bottom.append(edit);
    card.append(link, node('p', repo.description || '暂无简介。可手动添加备注与分类。'), meta);
    if (repo.note) card.append(node('div', repo.note, 'note')); card.append(bottom); grid.append(card);
  }
  if (!rows.length) grid.append(node('div', '没有匹配的工具，试试调整关键词或筛选条件。', 'empty'));
}
for (const id of ['repo-search', 'repo-category', 'repo-kind', 'repo-language', 'repo-sort', 'repo-hide-archived']) el(id).addEventListener('input', renderRepos);
function openEdit(repo: RepoDecision) { editingRepo = repo.full_name; el('edit-name').textContent = repo.full_name; el<HTMLSelectElement>('edit-category').value = repo.category; el<HTMLSelectElement>('edit-kind').value = repo.kind; el<HTMLTextAreaElement>('edit-note').value = repo.note || ''; el<HTMLDialogElement>('edit-dialog').showModal(); }
el('close-edit').addEventListener('click', () => el<HTMLDialogElement>('edit-dialog').close());
el('edit-form').addEventListener('submit', e => { e.preventDefault(); safe(async () => { await busy(el<HTMLButtonElement>('edit-form').querySelector<HTMLButtonElement>('[type=submit]')!, async () => { current.github = await api(`/api/jobs/${current.github!.id}/edit`, { name: editingRepo, category: value('edit-category'), kind: value('edit-kind'), note: value('edit-note') }); el<HTMLDialogElement>('edit-dialog').close(); renderRepos(); toast('已保存人工修正，下次整理会保留。'); }); })(); });
async function download(job: StudioJob, format: string) {
  const response = await fetch(`/api/jobs/${job.id}/download?format=${format}`, { headers: { 'X-Jev-Session': token } });
  if (!response.ok) { const data = await response.json(); throw new Error(data.error); }
  const blob = await response.blob(), url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = response.headers.get('content-disposition')?.match(/filename="([^"]+)"/)?.[1] || 'result.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
for (const button of document.querySelectorAll<HTMLElement>('[data-download]')) button.addEventListener('click', safe(() => download(current.github!, button.dataset.download!)));
for (const radio of document.querySelectorAll<HTMLInputElement>('input[name=github-source]')) radio.addEventListener('change', () => { const byUser = document.querySelector<HTMLInputElement>('input[name=github-source]:checked')?.value === 'user'; el('github-user-wrap').hidden = !byUser; el('github-repos-wrap').hidden = byUser; });
async function githubRun(demo = false) {
  const byUser = document.querySelector<HTMLInputElement>('input[name=github-source]:checked')?.value === 'user';
  const result = await api('/api/github', { demo, user: demo || !byUser ? '' : value('github-user'), repos: demo || byUser ? '' : value('github-repos'), limit: Number(value('github-limit')), threshold: Number(value('github-threshold')), refresh: checked('github-refresh') });
  await selectJob(result.id); await refreshState();
}
el('github-form').addEventListener('submit', e => { e.preventDefault(); safe(() => githubRun())(); });
el('github-demo').addEventListener('click', safe(() => githubRun(true))); el('home-demo').addEventListener('click', safe(() => githubRun(true)));
function config(): FeishuConfig { return { appToken: value('feishu-appToken'), tableId: value('feishu-tableId'), ...(value('feishu-viewId') ? { viewId: value('feishu-viewId') } : {}), sourceField: value('feishu-sourceField'), threshold: Number(value('feishu-threshold')), fields: { category: value('feishu-category'), priority: value('feishu-priority'), status: value('feishu-status'), confidence: value('feishu-confidence') } }; }
function fillConfig(c: FeishuConfig) { for (const key of ['appToken', 'tableId', 'viewId', 'sourceField'] as const) el<HTMLInputElement>(`feishu-${key}`).value = c[key] || ''; for (const [k, v] of Object.entries(c.fields)) el<HTMLInputElement>(`feishu-${k}`).value = v; }
el('feishu-url').addEventListener('change', safe(() => {
  if (!value('feishu-url')) return; const url = new URL(value('feishu-url'));
  if (!url.hostname.endsWith('.feishu.cn') || !url.pathname.startsWith('/base/')) throw new Error('请使用飞书 /base/ 多维表格链接；Wiki 链接请填写对应 Base Token。');
  const token = url.pathname.split('/')[2] || ''; if (!token || !url.searchParams.get('table')) throw new Error('链接需包含 Base Token 和 table 参数。');
  el<HTMLInputElement>('feishu-appToken').value = token; el<HTMLInputElement>('feishu-tableId').value = url.searchParams.get('table')!; el<HTMLInputElement>('feishu-viewId').value = url.searchParams.get('view') || ''; toast('表格信息已填写。');
}));
async function feishuRun(demo = false) { const result = await api('/api/feishu', { demo, config: demo ? state.demoConfig : config(), limit: Number(value('feishu-limit')) }); await selectJob(result.id); await refreshState(); }
el('feishu-form').addEventListener('submit', e => { e.preventDefault(); safe(() => feishuRun())(); }); el('feishu-demo').addEventListener('click', safe(() => feishuRun(true)));
function confirmAction(title: string, text: string): Promise<boolean> {
  const dialog = el<HTMLDialogElement>('confirm-dialog'); el('confirm-title').textContent = title; el('confirm-text').textContent = text; dialog.showModal();
  return new Promise(resolve => { const finish = (answer: boolean) => { dialog.close(); el('confirm-ok').onclick = null; el('confirm-cancel').onclick = null; dialog.oncancel = null; resolve(answer); }; el('confirm-ok').onclick = () => finish(true); el('confirm-cancel').onclick = () => finish(false); dialog.oncancel = e => { e.preventDefault(); finish(false); }; });
}
el('check-fields').addEventListener('click', safe(() => busy(el<HTMLButtonElement>('check-fields'), async () => {
  const c = config(); const result = await api('/api/feishu/check', c); const names = [c.sourceField, ...Object.values(c.fields)];
  const missing = names.filter(n => !result.fields.some((f: any) => f.field_name === n)); const wrong = names.filter(n => result.fields.some((f: any) => f.field_name === n && f.type !== 1));
  el('field-result').textContent = missing.length || wrong.length ? `${missing.length ? `缺少列：${missing.join('、')}。` : ''}${wrong.length ? `请改为多行文本：${wrong.join('、')}` : ''}` : '字段检查通过，五列均为多行文本。可以生成分诊计划。';
})));
el('setup-fields').addEventListener('click', safe(() => busy(el<HTMLButtonElement>('setup-fields'), async () => {
  const c = config(); const result = await api('/api/feishu/check', c); const missing = Object.values(c.fields).filter(n => !result.fields.some((f: any) => f.field_name === n));
  if (!missing.length) { toast('四个输出列均已存在。'); return; }
  if (!await confirmAction('创建输出列', `将在当前表中创建 ${missing.length} 个多行文本列：${missing.join('、')}。`)) return;
  const created = await api('/api/feishu/setup', c); el('field-result').textContent = `已创建：${created.created.join('、') || '无需新增列'}。`;
})));
function renderFeedback() {
  const job = current.feishu; if (!job?.result) return; const plan = job.result as FeishuPlan;
  el('feishu-demo-badge').hidden = !plan.demo; const selected = plan.entries.filter(e => !e.excluded);
  el('feishu-summary').textContent = `${plan.entries.length} 条反馈 · ${selected.length} 条已选 · ${plan.entries.filter(e => e.review).length} 条待确认${plan.limited ? ' · 已达到读取上限' : ''}`;
  const apply = el<HTMLButtonElement>('feishu-apply'); apply.disabled = plan.demo || !selected.length || job.state === 'running' || !!job.rollback;
  apply.textContent = job.receipt ? '继续未完成回填' : '回填选中记录';
  const q = value('feedback-search').toLowerCase(), rows = plan.entries.filter(e => (!checked('feedback-only-review') || e.review) && `${e.recordId} ${e.preview}`.toLowerCase().includes(q));
  el('feedback-count').textContent = `${rows.length} 条显示`; const list = el('feedback-list'); list.replaceChildren();
  for (const entry of rows) {
    const row = node('article', '', `feedback-row${entry.excluded ? ' excluded' : ''}`), check = node('input'); check.type = 'checkbox'; check.checked = !entry.excluded; check.setAttribute('aria-label', `选择 ${entry.recordId}`); check.disabled = !!job.receipt || job.state === 'running';
    const text = node('div', '', 'feedback-text'); text.append(node('small', entry.recordId), node('div', entry.preview)); text.append(node('div', `${entry.manual ? '人工已确认' : entry.review ? '需要人工确认' : '判断明确'} · 模型把握 ${entry.fields[plan.config.fields.confidence]}`, `status-line${!entry.review ? ' good' : ''}`));
    const category = node('select'), priority = node('select');
    for (const [k, v] of Object.entries(state.labels.feedback)) { const opt = node('option', v); opt.value = k; category.append(opt); }
    for (const [k, v] of Object.entries(state.labels.priority)) { const opt = node('option', v); opt.value = k; priority.append(opt); }
    category.value = entry.suggestedCategory; priority.value = entry.suggestedPriority; category.disabled = priority.disabled = check.disabled;
    const categoryLabel = node('label', '类型'), priorityLabel = node('label', '优先级'); categoryLabel.append(category); priorityLabel.append(priority);
    const edit = async (change: object) => { for (const input of [check, category, priority]) input.disabled = true; try { current.feishu = await api(`/api/jobs/${job.id}/edit`, { recordId: entry.recordId, ...change }); renderFeedback(); } catch (e) { renderFeedback(); throw e; } };
    check.addEventListener('change', safe(() => edit({ excluded: !check.checked })));
    category.addEventListener('change', safe(() => edit({ category: category.value, priority: priority.value })));
    priority.addEventListener('change', safe(() => edit({ category: category.value, priority: priority.value })));
    row.append(check, text, categoryLabel, priorityLabel); list.append(row);
  }
  if (!rows.length) list.append(node('div', '没有匹配的记录。', 'empty'));
  const receipt = el('receipt'); receipt.replaceChildren(); receipt.hidden = !job.receipt;
  if (job.receipt) {
    const r = job.receipt; receipt.append(node('strong', '本次回填回执'), node('p', `${r.updated.length} 条写入成功 / ${r.alreadyApplied.length} 条已处理 / ${r.conflicts.length} 条内容冲突 / ${r.failed.length} 条失败 / ${r.pending.length} 条未处理`));
    const actions = node('div', '', 'button-group'), save = node('button', '下载回填回执', 'secondary'); save.addEventListener('click', safe(() => download(job, 'receipt'))); actions.append(save);
    if (!plan.demo && r.operations.length) { const retryUndo = !!job.rollback && !!((job.rollback as any).failed?.length || (job.rollback as any).pending?.length); const undo = node('button', retryUndo ? '继续撤销' : '撤销本次回填', 'secondary'); undo.disabled = job.state === 'running' || !!job.rollback && !retryUndo; undo.addEventListener('click', safe(async () => { if (await confirmAction('撤销本次回填', `只清空本次成功写入且未再修改的 ${r.operations.length} 条记录的四个输出列。内容或输出有变化的记录会跳过。`)) { await api(`/api/jobs/${job.id}/rollback`, {}); await selectJob(job.id); } })); actions.append(undo); }
    receipt.append(actions); if (r.failed.length || r.conflicts.length) receipt.append(node('pre', JSON.stringify({ failed: r.failed, conflicts: r.conflicts }, null, 2)));
    if (job.rollback) { receipt.append(node('p', '撤销结果'), node('pre', JSON.stringify(job.rollback, null, 2))); const downloadRollback = node('button', '下载撤销回执', 'secondary'); downloadRollback.addEventListener('click', safe(() => download(job, 'rollback'))); receipt.append(downloadRollback); }
  }
}
for (const id of ['feedback-only-review', 'feedback-search']) el(id).addEventListener('input', renderFeedback);
el('feishu-download').addEventListener('click', safe(() => download(current.feishu!, 'json')));
el('feishu-apply').addEventListener('click', safe(async () => {
  const job = current.feishu!, plan = job.result as FeishuPlan, count = plan.entries.filter(e => !e.excluded).length;
  if (!await confirmAction('回填这份已审阅的计划', `将更新 ${count} 条选中记录的「${Object.values(plan.config.fields).join('、')}」四列。已有人工修改或输入变化的记录会跳过。`)) return;
  await api(`/api/jobs/${job.id}/apply`, {}); await selectJob(job.id); await refreshState();
}));
el('settings-form').addEventListener('submit', e => { e.preventDefault(); safe(async () => {
  const data: Record<string, string> = { model: value('model') };
  for (const key of ['typesafe', 'github', 'feishuId', 'feishuSecret']) if (value(`key-${key}`)) data[key] = value(`key-${key}`);
  await api('/api/session', data); for (const key of ['typesafe', 'github', 'feishuId', 'feishuSecret']) el<HTMLInputElement>(`key-${key}`).value = '';
  await refreshState(); toast('已保存到本次会话，不写入文件。');
}) (); });
el('clear-credentials').addEventListener('click', safe(async () => { await api('/api/session', { clear: ['typesafe', 'github', 'feishuId', 'feishuSecret'] }); for (const key of ['typesafe', 'github', 'feishuId', 'feishuSecret']) el<HTMLInputElement>(`key-${key}`).value = ''; await refreshState(); toast('会话凭据已清除。'); }));
async function poll() {
  try {
    if (state?.jobs.some(j => j.state === 'running') || Object.values(current).some(j => j?.state === 'running')) {
      await refreshState();
      for (const type of ['github', 'feishu'] as const) { const job = current[type]; if (!job) continue; const fresh = state.jobs.find(j => j.id === job.id); if (fresh && (job.state === 'running' || fresh.updatedAt !== job.updatedAt)) { current[type] = await api(`/api/jobs/${job.id}`); renderJob(current[type]!); } }
    }
  } catch (error) { toast(error instanceof Error ? error.message : '连接中断', true); }
  finally { setTimeout(poll, 1200); }
}
void refreshState().then(() => { showView(location.hash.slice(1) || 'home'); void poll(); }).catch(e => toast(e.message, true));
