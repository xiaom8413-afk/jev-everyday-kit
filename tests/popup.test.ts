import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { parseHTML } from 'linkedom';
import { classifyTabs } from '../packages/core/src/classify';
import { demoTabs, demoTabDecide } from '../packages/core/src/demo';

test('Popup renders untrusted titles as text, labels demo, and never offers demo Apply', async () => {
  const { document } = parseHTML(await readFile('packages/chrome/public/popup.html', 'utf8'));
  // Linkedom's select value is read-only; browsers expose a setter.
  Object.defineProperty(document.defaultView!.HTMLSelectElement.prototype, 'value', { configurable: true,
    get() { return [...this.options].find(o => o.hasAttribute('selected'))?.value ?? this.options[0]?.value ?? ''; },
    set(value: string) { for (const option of this.options) { if (option.value === value) option.setAttribute('selected', ''); else option.removeAttribute('selected'); } },
  });
  const items = await classifyTabs(demoTabs, demoTabDecide);
  items[0]!.title = '<img src=x onerror=alert(1)>';
  const script = await build({ entryPoints: ['packages/chrome/src/popup.ts'], bundle: true, write: false, format: 'iife', platform: 'browser' });
  const messages: any[] = [];
  runInNewContext(script.outputFiles[0]!.text, {
    document, URL, setTimeout, clearTimeout, console,
    chrome: {
      windows: { getCurrent: async () => ({ id: 1 }) },
      runtime: { sendMessage: async (message: unknown) => { messages.push(message); return { ok: true, data: { plan: { demo: true, items }, hasKey: false, busy: false, note: '演示数据 · 未调用 Jev' } }; } },
    },
  });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(document.querySelectorAll('.tab-row').length, 7, document.getElementById('status')!.textContent ?? '');
  assert.equal(document.querySelectorAll('#results img').length, 0);
  assert.ok(document.getElementById('results')!.textContent?.includes('<img'));
  assert.ok(document.getElementById('status')!.textContent?.includes('演示数据'));
  assert.ok(document.getElementById('applybar')!.hidden);
  assert.ok([...document.querySelectorAll<HTMLInputElement>('.tab-row input')].every(i => i.disabled));
  assert.deepEqual(messages.map(m => m.action), ['state']);
});
