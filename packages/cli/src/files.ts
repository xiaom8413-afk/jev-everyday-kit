import { mkdir, writeFile, rename, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
export async function saveFile(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, data, { mode: 0o600 });
  await rename(temp, path);
}
export const saveJson = (path: string, value: unknown) => saveFile(path, `${JSON.stringify(value, null, 2)}\n`);
export async function readJson(path: string): Promise<unknown> { return JSON.parse(await readFile(path, 'utf8')); }
