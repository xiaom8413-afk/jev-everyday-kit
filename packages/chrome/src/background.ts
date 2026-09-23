import { createJev, isObject } from '../../core/src/jev';
import { classifyTabs, TAB_LABELS, type TabInput, type TabDecision } from '../../core/src/classify';
import { demoTabs, demoTabDecide } from '../../core/src/demo';
import { eligibleTab, unchangedTab } from './operations';
export interface Preferences { model: string; threshold: number; maxTabs: number; prefix: string; collapsed: boolean; excludedDomains: string[] }
const defaults: Preferences = { model: 'jev-latest', threshold: 0.75, maxTabs: 300, prefix: 'Jev', collapsed: false, excludedDomains: [] };
export interface Plan { items: (TabDecision & { manual?: boolean })[]; demo: boolean; total: number; scanned: number; pending: TabInput[]; selected: number[]; settings: Preferences }
interface UndoGroup { id: number; tabs: { id: number; url: string }[] }
export interface WindowState { plan?: Plan; undo?: UndoGroup[]; note?: string; progress?: { done: number; total: number; status: 'running' | 'paused' | 'complete' }; beforeOrder?: number[]; afterOrder?: number[] }
const busy = new Map<number, AbortController>();
const stateKey = (windowId: number) => `window_${windowId}`;
async function getState(windowId: number): Promise<WindowState> { return (await chrome.storage.session.get(stateKey(windowId)))[stateKey(windowId)] as WindowState ?? {}; }
async function putState(windowId: number, state: WindowState) { await chrome.storage.session.set({ [stateKey(windowId)]: state }); }
async function preferences(): Promise<Preferences> {
  const stored = (await chrome.storage.local.get('preferences')).preferences;
  try { return parsePreferences({ ...defaults, ...(isObject(stored) ? stored : {}) }); } catch { return { ...defaults }; }
}
const colors: Record<string, chrome.tabGroups.TabGroup['color']> = { work: 'blue', develop: 'green', research: 'purple', life: 'orange', leisure: 'pink' };
export function parsePreferences(raw: unknown): Preferences {
  if (!isObject(raw) || typeof raw.model !== 'string' || !raw.model.trim() || raw.model.length > 100 || typeof raw.threshold !== 'number' || !Number.isFinite(raw.threshold) || raw.threshold < 0.5 || raw.threshold > 0.99 || typeof raw.maxTabs !== 'number' || !Number.isInteger(raw.maxTabs) || raw.maxTabs < 15 || raw.maxTabs > 500 || typeof raw.prefix !== 'string' || !raw.prefix.trim() || raw.prefix.length > 30 || typeof raw.collapsed !== 'boolean' || !Array.isArray(raw.excludedDomains) || raw.excludedDomains.length > 100 || raw.excludedDomains.some(d => typeof d !== 'string' || !/^[a-z0-9.-]+$/i.test(d) || d.length > 253)) throw new Error('请检查模型、阈值（50–99%）、数量（15–500）和排除域名。');
  return { model: raw.model.trim(), threshold: raw.threshold, maxTabs: raw.maxTabs, prefix: raw.prefix.trim(), collapsed: raw.collapsed, excludedDomains: [...new Set((raw.excludedDomains as string[]).map(d => d.toLowerCase()))] };
}
async function analyze(windowId: number, state: WindowState, controller: AbortController) {
  const plan = state.plan!; const stored = (await chrome.storage.session.get('apiKey')).apiKey;
  const decide = plan.demo ? demoTabDecide : createJev({ apiKey: typeof stored === 'string' ? stored : '', model: plan.settings.model, signal: controller.signal });
  const started = Date.now();
  state.progress = { done: plan.items.length, total: plan.scanned, status: 'running' }; await putState(windowId, state);
  try {
    while (plan.pending.length) {
      controller.signal.throwIfAborted();
      const batch = await classifyTabs(plan.pending.slice(0, 15), decide, { threshold: plan.settings.threshold, signal: controller.signal });
      plan.items.push(...batch); plan.pending.splice(0, 15); plan.selected.push(...batch.filter(t => t.eligible).map(t => t.id));
      state.progress.done = plan.items.length; await putState(windowId, state);
      if (Date.now() - started > 230_000 && plan.pending.length) break;
    }
    state.progress.status = plan.pending.length ? 'paused' : 'complete';
    state.note = plan.demo ? '演示数据 · 未调用 Jev，不操作真实标签页。' : plan.pending.length ? '已保存当前进度，点击“继续分析”完成剩余页面。' : `已分析 ${plan.scanned} / ${plan.total} 个页面。未纳入的页面包括已分组、固定、内部页和排除域名。`;
  } catch (error) {
    state.progress.status = 'paused'; state.note = controller.signal.aborted ? '已停止。已完成的结果已保存，可继续分析。' : error instanceof Error ? error.message : '分析中断，可继续。';
    await putState(windowId, state); if (!controller.signal.aborted) throw error;
  }
  await putState(windowId, state);
}
async function handle(message: { action: string; windowId: number; key?: string; ids?: number[]; id?: number; category?: string; preferences?: unknown }) {
  const { action, windowId } = message;
  if (!Number.isInteger(windowId) || windowId < 0) throw new Error('找不到当前浏览器窗口。');
  if (action === 'state') {
    const state = await getState(windowId);
    if (state.progress?.status === 'running' && !busy.has(windowId)) { state.progress.status = 'paused'; state.note = '后台任务已中断。已完成结果保留，可继续剩余页面。'; await putState(windowId, state); }
    return { ...state, preferences: await preferences(), hasKey: Boolean((await chrome.storage.session.get('apiKey')).apiKey), busy: busy.has(windowId) };
  }
  if (action === 'cancel') { busy.get(windowId)?.abort(); return {}; }
  if (action === 'key') {
    if (busy.size) throw new Error('请先停止分析，再更换密钥。');
    if (typeof message.key !== 'string' || message.key.length > 2000) throw new Error('密钥格式不正确。');
    const key = message.key.trim();
    if (key) await chrome.storage.session.set({ apiKey: key }); else await chrome.storage.session.remove('apiKey');
    return {};
  }
  if (action === 'preferences') { if (busy.size) throw new Error('请先停止分析，再修改设置。'); const value = parsePreferences(message.preferences); await chrome.storage.local.set({ preferences: value }); return {}; }
  if (busy.has(windowId)) throw new Error('正在处理当前窗口，请稍候。');
  const controller = new AbortController(); busy.set(windowId, controller);
  try {
    const state = await getState(windowId);
    if (action === 'analyze' || action === 'demo') {
      const settings = await preferences(); delete state.plan; state.note = ''; delete state.progress; await putState(windowId, state);
      const all = action === 'demo' ? [] : await chrome.tabs.query({ windowId });
      const tabs = action === 'demo' ? demoTabs : all.filter(eligibleTab).filter(t => { const host = new URL(t.url!).hostname; return !settings.excludedDomains.some(d => host === d || host.endsWith(`.${d}`)); }).slice(0, settings.maxTabs).map(t => ({ id: t.id!, title: t.title ?? '', url: t.url! }));
      if (!tabs.length) throw new Error('没有可整理的页面。已有分组、固定、无痕、内部页和排除域名会跳过。');
      state.plan = { items: [], demo: action === 'demo', total: action === 'demo' ? tabs.length : all.length, scanned: tabs.length, pending: tabs, selected: [], settings };
      await putState(windowId, state); await analyze(windowId, state, controller); return state;
    } else if (action === 'resume') {
      if (!state.plan?.pending.length) throw new Error('没有待继续的分析。');
      await analyze(windowId, state, controller); return state;
    } else if (action === 'edit') {
      if (!state.plan || typeof message.category !== 'string' || !Object.hasOwn(TAB_LABELS, message.category)) throw new Error('分类无效。');
      const item = state.plan.items.find(t => t.id === message.id); if (!item) throw new Error('未找到页面。');
      item.category = message.category; item.eligible = item.category !== 'other'; item.manual = true;
      state.plan.selected = state.plan.selected.filter(id => id !== item.id); if (item.eligible) state.plan.selected.push(item.id);
    } else if (action === 'selection') {
      if (!state.plan || !Array.isArray(message.ids)) throw new Error('选择无效。');
      state.plan.selected = [...new Set(message.ids)].filter(id => state.plan!.items.some(t => t.id === id && t.eligible));
    } else if (action === 'apply') {
      if (!state.plan || state.plan.demo) throw new Error('请先分析真实标签页。');
      if (state.plan.pending.length) throw new Error('请继续完成分析，或使用“采用已完成结果”后再分组。');
      if (state.undo?.length) throw new Error('请先撤销上次分组，或点击“保留分组”，再应用新方案。');
      if (!Array.isArray(message.ids) || message.ids.some(id => !Number.isInteger(id))) throw new Error('分组选择无效。');
      const selected = new Set(message.ids), groups = new Map<string, TabDecision[]>();
      for (const item of state.plan.items.filter(i => i.eligible && selected.has(i.id))) {
        const current = await chrome.tabs.get(item.id).catch(() => undefined);
        if (!current || !unchangedTab(current, item, windowId)) continue;
        groups.set(item.category, [...groups.get(item.category) ?? [], item]);
      }
      state.undo = []; state.beforeOrder = (await chrome.tabs.query({ windowId })).map(t => t.id!); let count = 0;
      for (const [category, items] of groups) {
        const id = await chrome.tabs.group({ tabIds: items.map(t => t.id) as [number, ...number[]], createProperties: { windowId } });
        state.undo.push({ id, tabs: items.map(t => ({ id: t.id, url: t.url })) }); await putState(windowId, state);
        await chrome.tabGroups.update(id, { title: `${state.plan.settings.prefix} · ${TAB_LABELS[category]}`, color: colors[category] ?? 'grey', collapsed: state.plan.settings.collapsed }); count += items.length;
      }
      state.afterOrder = (await chrome.tabs.query({ windowId })).map(t => t.id!); delete state.plan; delete state.progress;
      state.note = `已整理 ${count} 个页面。变化或关闭的页面已跳过。`;
    } else if (action === 'accept-partial') {
      if (!state.plan || !state.plan.items.length) throw new Error('还没有已完成的结果。');
      state.plan.pending = []; state.plan.scanned = state.plan.items.length; state.progress = { done: state.plan.scanned, total: state.plan.scanned, status: 'complete' }; state.note = '已采用完成的结果，其余页面保持原样。';
    } else if (action === 'undo') {
      const orderNow = (await chrome.tabs.query({ windowId })).map(t => t.id!);
      const canRestoreOrder = state.afterOrder && JSON.stringify(orderNow) === JSON.stringify(state.afterOrder);
      let count = 0; const remaining: UndoGroup[] = [];
      for (const group of state.undo ?? []) {
        const current = await chrome.tabs.query({ windowId, groupId: group.id });
        if (!current.length) continue;
        const original = new Map(group.tabs.map(t => [t.id, t.url]));
        if (current.length !== original.size || current.some(t => t.id === undefined || original.get(t.id) !== t.url)) { remaining.push(group); continue; }
        try { await chrome.tabs.ungroup(current.map(t => t.id!) as [number, ...number[]]); count += current.length; }
        catch { remaining.push(group); }
      }
      state.undo = remaining; await putState(windowId, state);
      if (!remaining.length && canRestoreOrder && state.beforeOrder) {
        // Only restore order if the window still exactly matches the post-apply ordering.
        for (let index = 0; index < state.beforeOrder.length; index++) {
          const id = state.beforeOrder[index]!; const tab = await chrome.tabs.get(id).catch(() => undefined);
          if (tab && !tab.pinned && tab.groupId === -1) await chrome.tabs.move(id, { index }).catch(() => {});
        }
      }
      state.note = `已撤销 ${count} 个页面的分组。${remaining.length ? '被修改或暂时无法撤销的分组予以保留。' : canRestoreOrder ? '窗口未变化，已尝试恢复原顺序。' : '窗口已变化，保留当前标签页顺序。'}`;
    } else if (action === 'keep') { state.undo = []; delete state.beforeOrder; delete state.afterOrder; state.note = '分组已保留，可以继续整理。'; }
    else throw new Error('未知操作。');
    await putState(windowId, state); return state;
  } finally { busy.delete(windowId); }
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) return false;
  handle(message).then(data => sendResponse({ ok: true, data }), error => sendResponse({ ok: false, error: error instanceof Error ? error.message : '操作失败，请重试。' })); return true;
});
chrome.windows.onRemoved.addListener(id => { busy.get(id)?.abort(); void chrome.storage.session.remove(stateKey(id)); });
