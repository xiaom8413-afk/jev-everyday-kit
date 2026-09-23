import { test, expect, chromium, type BrowserContext, type Worker } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { executablePath } from './browser-path';
let context: BrowserContext, worker: Worker, extensionId: string, profile: string;
test.beforeAll(async () => {
  profile = await mkdtemp(join(tmpdir(), 'jev-chrome-e2e-'));
  const extension = resolve('dist/chrome');
  context = await chromium.launchPersistentContext(profile, { executablePath: executablePath(), headless: true, viewport: { width: 800, height: 1000 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--host-resolver-rules=MAP * ~NOTFOUND'] });
  await context.route('https://**/*', route => route.fulfill({ contentType: 'text/html', body: `<title>${new URL(route.request().url()).hostname.includes('docs') ? 'Developer docs' : 'Team notes'}</title><h1>Fixture page</h1>` }));
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker'); extensionId = worker.url().split('/')[2]!;
  await worker.evaluate(() => {
    void chrome.storage.session.set({ apiKey: 'fixture-not-a-real-key' });
    (globalThis as any).fixtureSlow = false;
    globalThis.fetch = async (_input, init) => {
      if ((globalThis as any).fixtureSlow) await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 10000); init?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
      });
      const request = JSON.parse(String(init?.body));
      const answers = Object.fromEntries(Object.entries(request.questions).map(([id, question]: [string, any]) => {
        const tab = request.state.tabs.find((t: any) => `tab_${t.id}` === id); const selected = tab?.title.includes('Developer') ? 'develop' : 'work'; const keys = Object.keys(question.criteria);
        return [id, { type: 'choice', choice: selected, confidence: 0.94, probabilities: Object.fromEntries(keys.map(key => [key, key === selected ? 0.94 : 0.06 / (keys.length - 1)])) }];
      }));
      return Response.json({ model: 'fixture', answers });
    };
  });
  for (const url of ['https://docs.example.test/one', 'https://docs.example.test/two', 'https://notes.example.test/']) { const page = await context.newPage(); await page.goto(url); }
});
test.afterAll(async () => { await context?.close(); await rm(profile, { recursive: true, force: true }); });
test('Native extension: analyze, search, manual category, group and undo', async ({}, testInfo) => {
  const page = await context.newPage(); const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(`chrome-extension://${extensionId}/popup.html`); await page.locator('#settings').evaluate((e: HTMLDetailsElement) => { e.open = true; });
  await page.locator('#key').fill('fixture-not-a-real-key'); await page.locator('#save-key').click(); await expect(page.locator('#key-status')).toContainText('已设置');
  await page.locator('#settings').evaluate((e: HTMLDetailsElement) => { e.open = false; });
  await page.locator('#analyze').click(); await expect(page.locator('.tab-row')).toHaveCount(3); await expect(page.locator('#apply')).toBeEnabled();
  await page.locator('#search').fill('Team'); await expect(page.locator('.tab-row')).toHaveCount(1);
  await page.locator('.tab-category').selectOption('research'); await expect(page.locator('.manual')).toHaveText('手动');
  await page.locator('#search').fill(''); await expect(page.locator('.tab-row')).toHaveCount(3);
  await page.screenshot({ path: testInfo.outputPath('chrome-preview.png'), fullPage: true });
  await page.locator('#apply').click(); await expect(page.locator('#status')).toContainText('已整理 3 个页面');
  const grouped = await worker.evaluate(async () => (await chrome.tabs.query({})).filter(t => t.url?.includes('example.test')).map(t => t.groupId));
  expect(grouped.every(id => id !== -1)).toBeTruthy(); expect(new Set(grouped).size).toBe(2);
  await page.locator('#undo').click(); await expect(page.locator('#status')).toContainText('已撤销 3');
  expect(await worker.evaluate(async () => (await chrome.tabs.query({})).filter(t => t.url?.includes('example.test')).every(t => t.groupId === -1))).toBeTruthy();
  expect(errors).toEqual([]); await page.close();
});
test('Native extension: cancel preserves pending work, resume completes it', async () => {
  const page = await context.newPage(); await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await worker.evaluate(() => { (globalThis as any).fixtureSlow = true; });
  await page.locator('#analyze').click(); await expect(page.locator('#cancel')).toBeVisible(); await page.locator('#cancel').click();
  await expect(page.locator('#resume')).toBeVisible(); await expect(page.locator('#status')).toContainText('已停止');
  await worker.evaluate(() => { (globalThis as any).fixtureSlow = false; });
  await page.locator('#resume').click(); await expect(page.locator('.tab-row')).toHaveCount(3); await expect(page.locator('#apply')).toBeEnabled(); await page.close();
});
test('Native extension: preferences persist, excluded domains are not sent for classification', async () => {
  const page = await context.newPage(); await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.locator('#settings').evaluate((e: HTMLDetailsElement) => { e.open = true; }); await page.locator('#excluded-domains').fill('notes.example.test');
  await page.locator('#threshold').selectOption('0.85'); await page.locator('#prefix').fill('Focus'); await page.locator('#save-preferences').click(); await expect(page.locator('#status')).toContainText('偏好已保存');
  await page.reload(); await page.locator('#settings').evaluate((e: HTMLDetailsElement) => { e.open = true; }); await expect(page.locator('#excluded-domains')).toHaveValue('notes.example.test');
  await page.locator('#analyze').click(); await expect(page.locator('.tab-row')).toHaveCount(2); await expect(page.locator('#results')).not.toContainText('Team notes'); await page.close();
});
