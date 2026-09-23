import test from 'node:test';
import assert from 'node:assert/strict';
import { eligibleTab, unchangedTab } from '../packages/chrome/src/operations';
import { sampleAnswer } from '../packages/core/src/demo';
import { TAB_CATEGORIES } from '../packages/core/src/classify';
const tab = { id: 1, windowId: 2, title: 'Docs', url: 'https://example.com/', pinned: false, incognito: false, groupId: -1 } as chrome.tabs.Tab;
test('Chrome skips pinned, grouped, incognito and internal tabs', () => {
  assert.equal(eligibleTab(tab), true);
  for (const change of [{ pinned: true }, { incognito: true }, { groupId: 99 }, { url: 'chrome://settings' }, { id: undefined }]) assert.equal(eligibleTab({ ...tab, ...change }), false);
});
test('Chrome apply rejects changed pages and pages moved to another window', () => {
  const decision = { id: 1, title: 'Docs', url: tab.url!, category: 'develop', eligible: true, answer: sampleAnswer(TAB_CATEGORIES, 'develop') };
  assert.equal(unchangedTab(tab, decision, 2), true);
  for (const change of [{ title: 'Changed' }, { url: 'https://example.com/new' }, { windowId: 3 }, { pinned: true }, { groupId: 100 }]) assert.equal(unchangedTab({ ...tab, ...change }, decision, 2), false);
});
test('Chrome service worker demo is isolated; real grouping can be undone', async () => {
  const store: Record<string, any> = {}; let listener: any;
  let tabs = [{ ...tab }]; let nextGroup = 100;
  const originalFetch = globalThis.fetch;
  const chromeMock = {
    storage: { local: { get: async () => ({}), set: async () => {} }, session: {
      get: async (key: string) => ({ [key]: structuredClone(store[key]) }),
      set: async (value: object) => Object.assign(store, structuredClone(value)),
      remove: async (key: string) => { delete store[key]; },
    } },
    runtime: { id: 'test', getURL: (s: string) => `chrome-extension://test/${s}`, onMessage: { addListener: (fn: any) => { listener = fn; } } },
    windows: { onRemoved: { addListener: () => {} } },
    tabs: {
      query: async ({ windowId, groupId }: { windowId: number; groupId?: number }) => tabs.filter(t => t.windowId === windowId && (groupId === undefined || t.groupId === groupId)),
      get: async (id: number) => tabs.find(t => t.id === id),
      group: async ({ tabIds }: { tabIds: number[] }) => { const id = nextGroup++; tabs = tabs.map(t => tabIds.includes(t.id!) ? { ...t, groupId: id } : t); return id; },
      ungroup: async (ids: number[]) => { tabs = tabs.map(t => ids.includes(t.id!) ? { ...t, groupId: -1 } : t); },
      move: async () => {},
    },
    tabGroups: { update: async () => {} },
  };
  (globalThis as any).chrome = chromeMock;
  globalThis.fetch = async (_, init) => {
    const request = JSON.parse(String(init?.body));
    return Response.json({ answers: Object.fromEntries(Object.entries(request.questions).map(([id, q]: [string, any]) => [id, sampleAnswer(q.criteria, 'develop')])) });
  };
  try {
    await import('../packages/chrome/src/background');
    const send = (action: string, extra = {}) => new Promise<any>(resolve => listener({ action, windowId: 2, ...extra }, { id: 'test', url: 'chrome-extension://test/popup.html' }, resolve));
    assert.equal((await send('demo')).ok, true);
    assert.equal((await send('apply', { ids: [101] })).ok, false); assert.equal(tabs[0]?.groupId, -1);
    await send('key', { key: 'test-only-key' }); assert.equal((await send('analyze')).ok, true);
    assert.equal((await send('apply', { ids: [1] })).ok, true); assert.equal(tabs[0]?.groupId, 100);
    assert.equal((await send('undo')).ok, true); assert.equal(tabs[0]?.groupId, -1);
    const state = await send('state'); assert.equal(state.data.hasKey, true); assert.equal(state.data.apiKey, undefined);
    await send('key', { key: '' }); assert.equal((await send('state')).data.hasKey, false);
  } finally { globalThis.fetch = originalFetch; delete (globalThis as any).chrome; }
});
