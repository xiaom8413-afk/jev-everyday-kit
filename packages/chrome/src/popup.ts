import { TAB_LABELS, tabHost } from '../../core/src/classify';
import { certainty } from '../../core/src/jev';
import type { Plan, WindowState, Preferences } from './background';
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
let windowId = -1, latest: (WindowState & { hasKey: boolean; busy: boolean; preferences?: Preferences }) | undefined;
let pollTimer: ReturnType<typeof setTimeout> | undefined, selectionTimer: ReturnType<typeof setTimeout> | undefined;
let mutationQueue: Promise<unknown> = Promise.resolve();
let selected = new Set<number>(), preferencesDirty = false;
function status(text: string, error = false) { el('status').textContent = text; el('status').classList.toggle('error', error); }
async function send(action: string, extra: object = {}) {
  const result = await chrome.runtime.sendMessage({ action, windowId, ...extra });
  if (!result?.ok) throw new Error(result?.error ?? '扩展未响应，请重新打开。'); return result.data;
}
function countSelection() {
  el('selected-count').textContent = `已选 ${selected.size} 个页面`;
  el<HTMLButtonElement>('apply').disabled = !selected.size || !!latest?.busy;
}
function renderPreview() {
  const state = latest!; const items = state.plan?.items ?? []; const q = el<HTMLInputElement>('search').value.toLowerCase().trim();
  const results = el('results'); results.replaceChildren(); let shown = 0;
  for (const category of Object.keys(TAB_LABELS)) {
    const group = items.filter(t => (t.eligible ? t.category : 'other') === category && `${t.title} ${tabHost(t.url)}`.toLowerCase().includes(q));
    if (!group.length) continue; shown += group.length;
    const section = document.createElement('section'); section.className = 'group'; const head = document.createElement('div'); head.className = 'group-head';
    const dot = document.createElement('span'); dot.className = 'dot'; const title = document.createElement('span'); title.textContent = TAB_LABELS[category]!; const count = document.createElement('span'); count.textContent = `${group.length} 个页面`;
    head.append(dot, title, count); section.append(head);
    for (const item of group) {
      const row = document.createElement('div'); row.className = 'tab-row';
      const check = document.createElement('input'); check.type = 'checkbox'; check.value = String(item.id); check.checked = selected.has(item.id); check.disabled = !item.eligible || !!state.plan?.demo || state.busy; check.setAttribute('aria-label', `选择 ${item.title}`);
      check.addEventListener('change', () => { if (check.checked) selected.add(item.id); else selected.delete(item.id); countSelection(); scheduleSelection(); });
      const meta = document.createElement('span'); meta.className = 'tab-meta'; const name = document.createElement('span'); name.className = 'tab-title'; name.textContent = item.title; name.title = item.title;
      const host = document.createElement('span'); host.className = 'tab-host'; host.textContent = tabHost(item.url) ?? ''; meta.append(name, host);
      const score = document.createElement('span'); score.className = item.manual ? 'manual' : 'confidence'; score.textContent = item.manual ? '手动' : `${Math.round(certainty(item.answer) * 100)}%`;
      const select = document.createElement('select'); select.className = 'tab-category'; select.setAttribute('aria-label', `分类 ${item.title}`); select.disabled = state.busy || !!state.plan?.demo;
      for (const [key, label] of Object.entries(TAB_LABELS)) { const option = document.createElement('option'); option.value = key; option.textContent = label; select.append(option); }
      select.value = item.eligible ? item.category : 'other'; select.addEventListener('change', () => void run('edit', { id: item.id, category: select.value }).catch(showError));
      row.append(check, meta, score, select); section.append(row);
    }
    results.append(section);
  }
  if (!shown && items.length) { const text = document.createElement('p'); text.className = 'empty-search'; text.textContent = '没有匹配的页面，换个关键词试试。'; results.append(text); }
  countSelection();
}
function showError(e: unknown) { status(e instanceof Error ? e.message : '操作失败。', true); }
function scheduleSelection() { clearTimeout(selectionTimer); selectionTimer = setTimeout(() => { const ids = [...selected]; mutationQueue = mutationQueue.catch(() => {}).then(() => send('selection', { ids })).catch(showError); }, 250); }
async function refresh() {
  clearTimeout(pollTimer); const state = await send('state'); latest = state;
  selected = new Set(state.plan?.selected ?? state.plan?.items?.filter((t: { eligible: boolean }) => t.eligible).map((t: { id: number }) => t.id) ?? []);
  el('key-status').textContent = state.hasKey ? '本次会话已设置' : '未设置';
  if (state.preferences && !preferencesDirty) { const p = state.preferences; el<HTMLInputElement>('model').value = p.model; el<HTMLSelectElement>('threshold').value = String(p.threshold); el<HTMLInputElement>('max-tabs').value = String(p.maxTabs); el<HTMLInputElement>('prefix').value = p.prefix; el<HTMLInputElement>('collapsed').checked = p.collapsed; el<HTMLTextAreaElement>('excluded-domains').value = p.excludedDomains.join('\n'); }
  const hasItems = !!state.plan?.items?.length, pending = !!state.plan?.pending?.length;
  el('preview-tools').hidden = !hasItems; el('applybar').hidden = !hasItems || state.plan?.demo || !!state.undo?.length || state.busy || pending; el('undo-bar').hidden = !state.undo?.length;
  el('progress-area').hidden = !state.progress || state.progress.status === 'complete';
  el<HTMLProgressElement>('progress').max = state.progress?.total || 1; el<HTMLProgressElement>('progress').value = state.progress?.done || 0;
  el('cancel').hidden = !state.busy || state.progress?.status !== 'running'; el('resume').hidden = state.busy || !pending; el('accept-partial').hidden = state.busy || !pending || !hasItems;
  el<HTMLButtonElement>('cancel').disabled = !state.busy; el<HTMLButtonElement>('resume').disabled = state.busy; el<HTMLButtonElement>('accept-partial').disabled = state.busy;
  status(state.busy ? `正在后台分析 ${state.progress?.done ?? 0} / ${state.progress?.total ?? '…'} 个页面；关闭面板后仍可继续。` : state.note || '准备好后，点击分析。');
  for (const id of ['analyze', 'demo', 'undo', 'keep', 'save-key', 'clear-key', 'save-preferences', 'select-all', 'select-none']) el<HTMLButtonElement>(id).disabled = !!state.busy;
  renderPreview();
  if (state.busy) pollTimer = setTimeout(() => { void refresh().catch(showError); }, 1000);
}
function run(action: string, extra: object = {}) {
  const next = mutationQueue.catch(() => {}).then(() => runAction(action, extra)); mutationQueue = next; return next;
}
async function runAction(action: string, extra: object = {}) {
  clearTimeout(selectionTimer); clearTimeout(pollTimer);
  if (action !== 'cancel' && latest?.plan && !['selection', 'analyze', 'demo', 'resume'].includes(action)) await send('selection', { ids: [...selected] });
  for (const button of document.querySelectorAll('button')) button.disabled = true;
  el('applybar').hidden = true;
  if (action === 'analyze' || action === 'resume') { status('Jev 正在判断每个页面的用途…'); pollTimer = setTimeout(() => { void refresh().catch(showError); }, 500); }
  let failure: unknown;
  try { await send(action, extra); } catch (error) { failure = error; }
  finally { for (const button of document.querySelectorAll('button')) button.disabled = false; }
  await refresh(); if (failure) throw failure;
}
for (const action of ['analyze', 'demo', 'undo', 'keep', 'resume', 'accept-partial']) el(action).addEventListener('click', () => void run(action).catch(showError));
el('cancel').addEventListener('click', () => void send('cancel').then(() => status('正在停止，已完成结果会保留。')).catch(showError));
el('apply').addEventListener('click', () => void run('apply', { ids: [...selected] }).catch(showError));
el('search').addEventListener('input', () => { if (latest) renderPreview(); });
for (const id of ['select-all', 'select-none']) el(id).addEventListener('click', () => {
  for (const input of document.querySelectorAll<HTMLInputElement>('.tab-row input:not(:disabled)')) { if (id === 'select-all') selected.add(Number(input.value)); else selected.delete(Number(input.value)); }
  renderPreview(); scheduleSelection();
});
el('save-key').addEventListener('click', () => {
  const key = el<HTMLInputElement>('key').value.trim(); if (!key) { status('请先输入 TypeSafe API Key。', true); return; }
  el<HTMLInputElement>('key').value = ''; void run('key', { key }).then(() => status('密钥已保存至本次浏览器会话。')).catch(showError);
});
el('clear-key').addEventListener('click', () => void run('key', { key: '' }).then(() => status('密钥已清除。')).catch(showError));
for (const input of document.querySelectorAll('.preferences input,.preferences textarea,.preferences select')) input.addEventListener('input', () => { preferencesDirty = true; });
el('save-preferences').addEventListener('click', () => {
  const p = { model: el<HTMLInputElement>('model').value.trim(), threshold: Number(el<HTMLSelectElement>('threshold').value), maxTabs: Number(el<HTMLInputElement>('max-tabs').value), prefix: el<HTMLInputElement>('prefix').value.trim(), collapsed: el<HTMLInputElement>('collapsed').checked, excludedDomains: el<HTMLTextAreaElement>('excluded-domains').value.split(/\s+/).map(s => s.trim()).filter(Boolean) };
  void run('preferences', { preferences: p }).then(() => { preferencesDirty = false; status('整理偏好已保存，下次分析时生效。'); }).catch(showError);
});
void chrome.windows.getCurrent().then(async window => { windowId = window.id!; await refresh(); }).catch(showError);
