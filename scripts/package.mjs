import { readFile, readdir, stat, writeFile, mkdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { zipSync, unzipSync } from 'fflate';
const root = process.cwd();
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
async function files(path) {
  const info = await stat(path);
  if (info.isFile()) return [path];
  const children = await readdir(path); const result = [];
  for (const child of children.sort()) result.push(...await files(join(path, child)));
  return result;
}
const included = ['README.md', 'LICENSE', 'CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md', '.env.example', '.gitignore', 'package.json', 'package-lock.json', 'tsconfig.json', 'playwright.config.ts', 'packages', 'scripts', 'tests', 'docs', 'examples', '.github', 'dist/chrome', 'dist/studio', 'dist/jev.mjs', 'dist/github-action', 'dist/THIRD_PARTY_LICENSES.txt'];
const full = {};
for (const path of included) for (const file of await files(join(root, path))) {
  const name = relative(root, file).replaceAll('\\', '/');
  if (name.includes('node_modules/') || name.endsWith('/.env') || name.includes('test-results/')) throw new Error('Unexpected private or generated path in release');
  full[`jev-everyday-kit/${name}`] = [new Uint8Array(await readFile(file)), { mtime: new Date('2026-01-01T00:00:00Z') }];
}
const chrome = {};
for (const file of await files(join(root, 'dist/chrome'))) chrome[relative(join(root, 'dist/chrome'), file).replaceAll('\\', '/')] = [new Uint8Array(await readFile(file)), { mtime: new Date('2026-01-01T00:00:00Z') }];
await mkdir('dist', { recursive: true });
const checksums = [];
for (const [name, contents] of [[`jev-everyday-kit-${version}.zip`, full], [`jev-tab-sort-${version}.zip`, chrome]]) {
  const data = zipSync(contents, { level: 9 }); const extracted = unzipSync(data);
  if (Object.keys(extracted).length !== Object.keys(contents).length) throw new Error('Archive verification failed');
  for (const [path, original] of Object.entries(contents)) if (!Buffer.from(extracted[path]).equals(Buffer.from(original[0]))) throw new Error(`Archive content mismatch: ${path}`);
  await writeFile(join('dist', name), data); checksums.push(`${createHash('sha256').update(data).digest('hex')}  ${name}`);
  console.log(`${name}: ${Object.keys(contents).length} verified files, ${data.length.toLocaleString()} bytes`);
}
await writeFile('dist/SHA256SUMS.txt', `${checksums.join('\n')}\n`);
