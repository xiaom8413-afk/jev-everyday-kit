import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from 'node:process';
import { ZodError } from 'zod';
import { createJev } from '../../core/src/jev';
import { classifyTabs, classifyRepos } from '../../core/src/classify';
import { demoTabs, demoTabDecide, demoRepos, demoRepoDecide, demoFeedbackDecide } from '../../core/src/demo';
import { GitHubClient, renderCatalog } from './github';
import { FeishuClient, configSchema, planSchema, makePlan, applyPlan, rollbackPlan, receiptSchema } from './feishu';
import { buildCatalog } from './catalog';
import { startStudio } from '../../studio/src/server';
import { saveFile, saveJson, readJson } from './files';

export const HELP = `Jev Everyday Kit · Chrome / 飞书 / GitHub

用法（先 npm run build）：
  node dist/jev.mjs demo [--out output/demo]
  node dist/jev.mjs serve [--port 4318] [--data output/studio]
  node dist/jev.mjs github --user USER [--limit 100] [--out output/github]
  node dist/jev.mjs github --repos examples/repos.txt [--out output/github]
  node dist/jev.mjs feishu plan --config feishu.local.json [--limit 100] [--out output/feishu]
  node dist/jev.mjs feishu apply --plan output/feishu/plan.json
  node dist/jev.mjs feishu rollback --plan output/feishu/plan.json --receipt output/feishu/plan.json.receipt.json
  node dist/jev.mjs feishu check --config feishu.local.json
  node dist/jev.mjs feishu setup --config feishu.local.json

说明：
  demo 完全离线，演示结果不代表模型实测。
  github 读取公开仓库元数据，导出工具目录，不修改 Star。
  feishu plan 只生成预览；apply 读取已审阅的计划，回填空白输出列。
  --limit 是读取上限：GitHub 1–10000，飞书待处理记录 1–5000。
  serve 只监听 127.0.0.1，不会自动打开浏览器。操作台可直接完成配置、审阅与导出。
  自动读取当前目录的 .env；密钥从环境变量读取，见 .env.example。
  Chrome 安装说明：docs/chrome.md。
`;
function limitValue(value?: string, max = 10000): number {
  const n = Number(value ?? 100);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`--limit 必须是 1–${max} 的整数。`);
  return n;
}
const demoConfig = { appToken: 'demoAppToken', tableId: 'demoTable', sourceField: '反馈内容', fields: { category: 'Jev分类', priority: 'Jev优先级', status: 'Jev状态', confidence: 'Jev把握' } };
export async function main(args = process.argv.slice(2)): Promise<void> {
  const { positionals, values } = parseArgs({ args, allowPositionals: true, strict: true, options: {
    out: { type: 'string' }, user: { type: 'string' }, repos: { type: 'string' }, limit: { type: 'string' },
    config: { type: 'string' }, plan: { type: 'string' }, receipt: { type: 'string' }, port: { type: 'string' }, data: { type: 'string' }, refresh: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help || !positionals.length) { console.log(HELP); return; }
  const [command, subcommand] = positionals;
  if (command !== 'feishu' && positionals.length !== 1 || command === 'feishu' && positionals.length !== 2) throw new Error('命令格式不正确，使用 --help 查看帮助。');
  const allowed: Record<string, string[]> = { serve: ['port', 'data'], demo: ['out'], github: ['out', 'user', 'repos', 'limit', 'refresh'], 'feishu:plan': ['out', 'config', 'limit'], 'feishu:apply': ['plan'], 'feishu:rollback': ['plan', 'receipt'], 'feishu:check': ['config'], 'feishu:setup': ['config'] };
  const mode = command === 'feishu' ? `${command}:${subcommand}` : command!;
  if (!allowed[mode]) throw new Error('未知命令。使用 --help 查看帮助。');
  for (const option of Object.keys(values)) if (!allowed[mode]!.includes(option)) throw new Error(`当前命令不支持 --${option}。`);
  if (existsSync('.env')) loadEnvFile('.env');
  const decide = () => createJev({ apiKey: process.env.TYPESAFE_API_KEY ?? '', model: process.env.JEV_MODEL });
  if (command === 'serve') {
    const port = Number(values.port ?? 4318); if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port 必须为 0–65535 的整数。');
    const adjacent = join(dirname(fileURLToPath(import.meta.url)), 'studio');
    const studio = await startStudio({ port, dataDir: resolve(values.data ?? 'output/studio'), assetsDir: existsSync(adjacent) ? adjacent : resolve('dist/studio'), credentials: { typesafe: process.env.TYPESAFE_API_KEY ?? '', github: process.env.GITHUB_TOKEN ?? '', feishuId: process.env.FEISHU_APP_ID ?? '', feishuSecret: process.env.FEISHU_APP_SECRET ?? '', model: process.env.JEV_MODEL || 'jev-latest' } });
    console.log(`Jev 本地操作台已就绪：${studio.origin}\n仅监听本机，不会自动打开浏览器。按 Ctrl+C 停止。`);
    let closing = false; const close = () => { if (closing) return; closing = true; void studio.close().then(() => { process.exitCode = 0; }); };
    process.once('SIGINT', close); process.once('SIGTERM', close); return;
  }
  if (command === 'demo') {
    const out = resolve(values.out ?? 'output/demo');
    const tabs = await classifyTabs(demoTabs, demoTabDecide);
    const catalog = await buildCatalog(demoRepos, demoRepoDecide, { out, model: 'demo', demo: true }); const repos = catalog.repositories;
    const plan = await makePlan([
      { record_id: 'demo001', fields: { 反馈内容: '支付服务全面不可用，所有客户都无法付款，故障仍在持续。' } },
      { record_id: 'demo002', fields: { 反馈内容: '建议增加深色模式，不影响现有使用。' } },
      { record_id: 'demo003', fields: { 反馈内容: '有问题。' } },
    ], demoConfig, demoFeedbackDecide, true);
    await saveJson(join(out, 'tabs.json'), { demo: true, items: tabs });
    await saveJson(join(out, 'feishu-plan.json'), plan);
    console.log(`离线演示完成：${tabs.length} 个标签页 / ${repos.length} 个仓库 / ${plan.entries.length} 条飞书反馈。\n结果：${out}\n全部使用固定样例，没有访问网络。`);
    return;
  }
  if (command === 'github') {
    if (Boolean(values.user) === Boolean(values.repos)) throw new Error('--user 和 --repos 必须且只能提供一个。');
    const run = decide(), client = new GitHubClient(process.env.GITHUB_TOKEN);
    const limit = limitValue(values.limit);
    let repos, limited = false;
    if (values.user) ({ repos, limited } = await client.stars(values.user, limit));
    else {
      const slugs = (await readFile(values.repos!, 'utf8')).split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#'));
      if (!slugs.length) throw new Error('仓库清单为空。');
      limited = slugs.length > limit; repos = await client.repositories(slugs.slice(0, limit));
    }
    console.log(`读取到 ${repos.length} 个公开仓库，正在通过 Jev 分类…`);
    const out = resolve(values.out ?? 'output/github');
    const catalog = await buildCatalog(repos, run, { out, model: process.env.JEV_MODEL || 'jev-latest', limited, refresh: values.refresh });
    console.log(`已生成 ${out}/catalog.md、catalog.html 和 catalog.json。复用 ${catalog.cached} 个判断。${limited ? '已达到读取上限，详情见目录提示。' : ''}`);
    return;
  }
  if (['check', 'setup'].includes(subcommand!)) {
    if (!values.config) throw new Error('请提供 --config feishu.local.json。');
    const config = configSchema.parse(await readJson(values.config)); const client = await FeishuClient.login(process.env.FEISHU_APP_ID ?? '', process.env.FEISHU_APP_SECRET ?? '');
    if (subcommand === 'setup') console.log(`已创建输出列：${(await client.setupFields(config)).join('、') || '无需新增'}`);
    else { await client.validateFields(config); console.log('字段与访问检查通过。'); } return;
  }
  if (subcommand === 'plan') {
    if (!values.config) throw new Error('请提供 --config feishu.local.json。');
    const config = configSchema.parse(await readJson(values.config)), run = decide();
    const client = await FeishuClient.login(process.env.FEISHU_APP_ID ?? '', process.env.FEISHU_APP_SECRET ?? '');
    await client.validateFields(config);
    const { records, limited } = await client.records(config, limitValue(values.limit, 5000));
    const plan = await makePlan(records, config, run); plan.limited = limited;
    const out = resolve(values.out ?? 'output/feishu'); await saveJson(join(out, 'plan.json'), plan);
    console.log(`计划已生成：${plan.entries.length} 条待回填，${plan.skipped} 条跳过，${plan.entries.filter(e => e.review).length} 条待人工确认。\n查看 ${out}/plan.json，确认后运行 feishu apply --plan <文件路径>。${limited ? '\n已达到本次待处理记录上限。' : ''}`);
    return;
  }
  if (!values.plan) throw new Error('请提供 --plan <已审阅的 plan.json>。');
  const plan = planSchema.parse(await readJson(values.plan));
  if (plan.demo) throw new Error('演示计划不能回填真实飞书表格。');
  const client = await FeishuClient.login(process.env.FEISHU_APP_ID ?? '', process.env.FEISHU_APP_SECRET ?? '');
  if (subcommand === 'rollback') {
    if (!values.receipt) throw new Error('请提供 --receipt <回填回执>。');
    const receipt = receiptSchema.parse(await readJson(values.receipt));
    const rollbackPath = `${resolve(values.receipt)}.rollback.json`;
    const result = await rollbackPlan(plan, receipt, client, result => saveJson(rollbackPath, result));
    console.log(`撤销完成：${result.restored.length} 条恢复 / ${result.conflicts.length} 条变化跳过 / ${result.failed.length} 条失败。\n回执：${rollbackPath}`); return;
  }
  const receiptPath = `${resolve(values.plan)}.receipt.json`;
  const previous = existsSync(receiptPath) ? receiptSchema.parse(await readJson(receiptPath)) : undefined;
  const receipt = await applyPlan(plan, client, receipt => saveJson(receiptPath, receipt), { previous });
  await saveJson(receiptPath, receipt);
  console.log(`回填完成：写入 ${receipt.updated.length} / 已回填 ${receipt.alreadyApplied.length} / 冲突 ${receipt.conflicts.length} / 失败 ${receipt.failed.length}。\n回执：${receiptPath}`);
  if (receipt.failed.length) process.exitCode = 1;
}
main().catch(error => {
  // Do not print raw provider payloads, credentials, or entire validation inputs.
  console.error(error instanceof ZodError ? '配置、计划或平台响应格式不正确；请对照 examples 和文档检查字段。' : error instanceof Error ? error.message : '运行失败。');
  process.exitCode = 1;
});
