import { test, expect } from '@playwright/test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startStudio } from '../../packages/studio/src/server';
import { FeishuClient } from '../../packages/cli/src/feishu';
import { demoFeedbackDecide } from '../../packages/core/src/demo';
let studio: Awaited<ReturnType<typeof startStudio>>, dataDir: string;
let fields: Record<string, unknown>;
test.beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'jev-e2e-studio-')); fields = { 反馈内容: '所有客户付款失败，支付服务全面中断' };
  const fetcher: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    const records = [{ record_id: 'fixture001', fields: structuredClone(fields) }];
    if (path.endsWith('/fields')) return Response.json({ code: 0, data: { items: ['反馈内容', 'Jev分类', 'Jev优先级', 'Jev状态', 'Jev把握'].map(field_name => ({ field_name, type: 1 })) } });
    if (path.endsWith('/search')) return Response.json({ code: 0, data: { items: records } });
    if (path.endsWith('/batch_get')) return Response.json({ code: 0, data: { records } });
    if (path.endsWith('/batch_update')) { Object.assign(fields, JSON.parse(String(init?.body)).records[0].fields); return Response.json({ code: 0, data: { records } }); }
    throw new Error('Unexpected platform request');
  };
  studio = await startStudio({ port: 0, dataDir, assetsDir: resolve('dist/studio'), createDecision: () => demoFeedbackDecide, feishuClient: async () => new FeishuClient('fixture-only', fetcher) });
});
test.afterAll(async () => { await studio?.close(); await rm(dataDir, { recursive: true, force: true }); });
test('GitHub tool catalog: generate, filter, edit, export, refresh history', async ({ page }, testInfo) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(studio.origin); await expect(page.locator('#ready-status')).toContainText('本地工作台已就绪');
  await page.locator('#home-demo').click(); await expect(page.locator('.repo-card')).toHaveCount(4);
  await expect(page.locator('#repo-demo-badge')).toBeVisible();
  await page.locator('#repo-search').fill('focus-notes'); await expect(page.locator('.repo-card')).toHaveCount(1);
  await page.locator('.repo-card').getByRole('button', { name: '调整分类' }).click();
  await page.locator('#edit-category').selectOption('developer'); await page.locator('#edit-note').fill('回头做本地知识库时使用 <img src=x onerror=alert(1)>');
  await page.getByRole('button', { name: '保存人工修正' }).click(); await expect(page.locator('#edit-dialog')).not.toBeVisible();
  await expect(page.locator('.repo-card .note')).toContainText('<img'); await expect(page.locator('.repo-card img')).toHaveCount(0);
  await page.locator('#repo-search').fill(''); await page.locator('#repo-category').selectOption('developer'); await expect(page.locator('.repo-card')).toHaveCount(1);
  const filePromise = page.waitForEvent('download'); await page.getByRole('button', { name: '离线网页', exact: true }).click(); const download = await filePromise;
  const html = await readFile((await download.path())!, 'utf8'); expect(html).toContain('回头做本地知识库'); expect(html).not.toContain('<img src=x onerror=alert(1)>');
  await page.reload(); await page.locator('#history button').first().click(); await expect(page.locator('.repo-card')).toHaveCount(4);
  expect(errors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('github-desktop.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});
test('Feishu demo: review, exclude, correct low-confidence, prevent real writes', async ({ page }, testInfo) => {
  await page.goto(`${studio.origin}/#feishu`); await page.locator('#feishu-demo').click(); await expect(page.locator('.feedback-row')).toHaveCount(3);
  await expect(page.locator('#feishu-apply')).toBeDisabled();
  await page.locator('#feedback-only-review').check(); await expect(page.locator('.feedback-row')).toHaveCount(1);
  await page.locator('.feedback-row select').first().selectOption('question');
  await expect(page.locator('.feedback-row select').first()).toBeEnabled();
  await page.locator('.feedback-row select').last().selectOption('low');
  await expect(page.locator('.feedback-row')).toHaveCount(0);
  await page.locator('#feedback-only-review').uncheck(); await expect(page.locator('.feedback-row')).toHaveCount(3);
  await page.locator('.feedback-row input').nth(1).uncheck(); await expect(page.locator('#feishu-summary')).toContainText('2 条已选');
  await page.screenshot({ path: testInfo.outputPath('feishu-desktop.png'), fullPage: true });
});
test('Feishu full flow: field check, generate, confirmation, write, receipt, undo', async ({ page }) => {
  await page.goto(`${studio.origin}/#feishu`);
  await page.locator('#feishu-appToken').fill('fixtureApp'); await page.locator('#feishu-tableId').fill('fixtureTable');
  await page.locator('#check-fields').click(); await expect(page.locator('#field-result')).toContainText('字段检查通过');
  await page.getByRole('button', { name: '生成分诊计划' }).click(); await expect(page.locator('.feedback-row')).toHaveCount(1);
  await expect(page.locator('#feishu-apply')).toBeEnabled(); await page.locator('#feishu-apply').click();
  await expect(page.locator('#confirm-dialog')).toBeVisible(); expect(fields.Jev分类).toBeUndefined();
  await page.locator('#confirm-ok').click(); await expect(page.locator('#receipt')).toContainText('1 条写入成功');
  expect(fields.Jev分类).toBe('故障反馈'); await expect(page.locator('.feedback-row select').first()).toBeDisabled();
  await page.getByRole('button', { name: '撤销本次回填', exact: true }).click(); await page.locator('#confirm-ok').click();
  await expect(page.locator('#receipt')).toContainText('撤销结果'); expect(fields.Jev分类).toBe('');
});
test('Settings clear secrets and mobile layout remains usable', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto(`${studio.origin}/#settings`);
  await page.locator('#key-typesafe').fill('fixture-only-secret'); await page.getByRole('button', { name: '保存至当前会话', exact: true }).click();
  await expect(page.locator('#key-typesafe')).toHaveValue(''); await expect(page.locator('#cred-typesafe')).toHaveText('已配置');
  await page.getByRole('button', { name: '清除当前会话凭据' }).click(); await expect(page.locator('#cred-typesafe')).toHaveText('未配置');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: testInfo.outputPath('settings-mobile.png'), fullPage: true });
  await page.goto(studio.origin); await expect(page.locator('.tool-card')).toHaveCount(3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});
