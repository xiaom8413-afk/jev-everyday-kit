import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
test('Built standalone CLI serves the shipped workbench and completes the offline demo', async ({ page }) => {
  const data = await mkdtemp(join(tmpdir(), 'jev-packaged-test-'));
  const child = spawn(process.execPath, [resolve('dist/jev.mjs'), 'serve', '--port', '0', '--data', data], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TYPESAFE_API_KEY: '', FEISHU_APP_SECRET: '', GITHUB_TOKEN: '' } });
  try {
    const origin = await new Promise<string>((resolve, reject) => {
      let output = ''; const timer = setTimeout(() => reject(new Error('Standalone server did not start')), 10000);
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}`)); });
      child.stdout.on('data', chunk => { output += chunk; const url = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]; if (url) { clearTimeout(timer); resolve(url); } });
      child.once('error', reject);
    });
    await page.goto(origin); await page.locator('#home-demo').click(); await expect(page.locator('.repo-card')).toHaveCount(4); await expect(page.locator('#repo-demo-badge')).toBeVisible();
  } finally {
    if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise<void>(resolve => child.once('exit', () => resolve())); }
    await rm(data, { recursive: true, force: true });
  }
});
