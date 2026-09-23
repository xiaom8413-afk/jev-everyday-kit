import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
export function executablePath(): string {
  if (process.env.PWDEBUG || process.env.JEV_HEADED) throw new Error('These tests must stay headless.');
  const expected = chromium.executablePath();
  if (existsSync(expected)) return expected;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || (process.platform === 'darwin' ? join(homedir(), 'Library/Caches/ms-playwright') : process.platform === 'win32' ? join(process.env.LOCALAPPDATA || '', 'ms-playwright') : join(homedir(), '.cache/ms-playwright'));
  if (existsSync(root)) {
    for (const dir of readdirSync(root).filter(s => /^chromium-\d+$/.test(s)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))) {
      for (const bin of ['chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-win64/chrome.exe']) {
        const path = join(root, dir, bin); if (existsSync(path)) return path;
      }
    }
  }
  throw new Error('Run npx playwright install chromium to install the headless test browser.');
}
