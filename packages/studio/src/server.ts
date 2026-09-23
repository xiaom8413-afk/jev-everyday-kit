import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { readFile, mkdir, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { createJev, type Decide } from '../../core/src/jev';
import { demoRepos, demoRepoDecide, demoFeedbackDecide } from '../../core/src/demo';
import { REPO_LABELS, FEISHU_LABELS, PRIORITY_LABELS } from '../../core/src/classify';
import { GitHubClient, renderCatalog, repoSlug, kindLabels } from '../../cli/src/github';
import { buildCatalog, catalogSchema, editCatalog, repoEditSchema, saveCatalog, type Catalog } from '../../cli/src/catalog';
import { renderCatalogHtml } from '../../cli/src/catalog-html';
import { FeishuClient, configSchema, planSchema, makePlan, applyPlan, planEditSchema, editPlan, receiptSchema, rollbackPlan, type FeishuPlan, type ApplyReceipt } from '../../cli/src/feishu';
import { readJson, saveJson } from '../../cli/src/files';

const credentialsSchema = z.object({ typesafe: z.string().max(2000).optional(), github: z.string().max(2000).optional(), feishuId: z.string().max(1000).optional(), feishuSecret: z.string().max(2000).optional(), model: z.string().min(1).max(100).optional(), clear: z.array(z.enum(['typesafe', 'github', 'feishuId', 'feishuSecret'])).optional() }).strict();
type Credentials = { typesafe: string; github: string; feishuId: string; feishuSecret: string; model: string };
const githubInput = z.object({ demo: z.boolean().default(false), user: z.string().max(39).default(''), repos: z.string().max(100000).default(''), limit: z.number().int().min(1).max(10000).default(100), threshold: z.number().min(0.5).max(0.99).default(0.75), refresh: z.boolean().default(false) }).strict();
const feishuInput = z.object({ demo: z.boolean().default(false), config: configSchema, limit: z.number().int().min(1).max(5000).default(100) }).strict();
const jobSchema = z.object({ id: z.string().uuid(), type: z.enum(['github', 'feishu']), state: z.enum(['running', 'complete', 'failed', 'cancelled', 'interrupted']), title: z.string(), createdAt: z.string(), updatedAt: z.string(), stage: z.string(), done: z.number(), total: z.number(), error: z.string().optional(), request: z.unknown(), result: z.unknown().optional(), receipt: receiptSchema.optional(), rollback: z.unknown().optional(), cacheKey: z.string().regex(/^[a-f0-9]{64}$/).optional() });
export type StudioJob = z.infer<typeof jobSchema>;
const demoConfig = { appToken: 'demoAppToken', tableId: 'demoTable', sourceField: '反馈内容', fields: { category: 'Jev分类', priority: 'Jev优先级', status: 'Jev状态', confidence: 'Jev把握' } };
export interface StudioOptions {
  port?: number; dataDir: string; assetsDir: string;
  credentials?: Partial<Credentials>;
  // Test dependencies are passed in-process, never selected by an HTTP request or an environment URL.
  createDecision?: (credentials: Credentials, signal: AbortSignal) => Decide;
  githubClient?: (credentials: Credentials, signal: AbortSignal) => GitHubClient;
  feishuClient?: (credentials: Credentials, signal: AbortSignal) => Promise<FeishuClient>;
}
export async function startStudio(options: StudioOptions) {
  const dir = resolve(options.dataDir), jobDir = join(dir, 'jobs'); await mkdir(jobDir, { recursive: true, mode: 0o700 });
  const secret = randomBytes(32).toString('hex');
  const credentials: Credentials = { typesafe: '', github: '', feishuId: '', feishuSecret: '', model: 'jev-latest', ...options.credentials };
  const jobs = new Map<string, StudioJob>(), active = new Map<string, AbortController>();
  const jobFile = (id: string) => join(jobDir, `${id}.json`);
  const historyFiles = await Promise.all((await readdir(jobDir)).filter(s => /^[a-f0-9-]{36}\.json$/.test(s)).map(async name => ({ name, time: (await stat(join(jobDir, name))).mtimeMs })));
  for (const { name } of historyFiles.sort((a, b) => b.time - a.time).slice(0, 100)) {
    try {
      const j = jobSchema.parse(await readJson(join(jobDir, name)));
      if (`${j.id}.json` !== name) continue;
      if (j.state === 'running') { j.state = 'interrupted'; j.error = '服务重启，任务已停止。可重新生成；已有分类缓存和回填回执保留。'; await saveJson(jobFile(j.id), j); }
      jobs.set(j.id, j);
    } catch { /* An invalid history file never becomes an executable job. */ }
  }
  const saveQueue = new Map<string, Promise<void>>();
  const catalogQueue = new Map<string, Promise<void>>();
  const tasks = new Map<string, Promise<void>>();
  const persist = (job: StudioJob) => {
    job.updatedAt = new Date().toISOString(); const snapshot = structuredClone(job);
    const next = (saveQueue.get(job.id) ?? Promise.resolve()).catch(() => {}).then(() => saveJson(jobFile(job.id), snapshot));
    saveQueue.set(job.id, next); return next;
  };
  const requireJob = (id: string) => { const job = jobs.get(id); if (!job) throw new Error('任务不存在。'); return job; };
  const decision = (signal: AbortSignal) => options.createDecision?.(credentials, signal) ?? createJev({ apiKey: credentials.typesafe, model: credentials.model, signal });
  const github = (signal: AbortSignal) => options.githubClient?.(credentials, signal) ?? new GitHubClient(credentials.github, fetch, signal);
  const feishu = async (signal: AbortSignal) => options.feishuClient?.(credentials, signal) ?? FeishuClient.login(credentials.feishuId, credentials.feishuSecret, fetch, signal);
  function launch(job: StudioJob, run: (signal: AbortSignal) => Promise<void>) {
    if (active.has(job.id) || [...jobs.values()].some(j => j.id !== job.id && j.type === job.type && j.state === 'running')) throw new Error('这个平台还有任务在运行，请等待或取消后继续。');
    const controller = new AbortController(); active.set(job.id, controller); jobs.set(job.id, job);
    job.state = 'running'; delete job.error;
    const task = (async () => {
      let terminal: StudioJob['state'] = 'complete';
      try { await persist(job); await run(controller.signal); terminal = controller.signal.aborted ? 'cancelled' : 'complete'; }
      catch (error) {
        terminal = controller.signal.aborted ? 'cancelled' : 'failed';
        job.error = error instanceof z.ZodError ? '平台响应或配置格式不正确，请检查字段。' : error instanceof Error ? error.message : '任务失败，请重试。';
      } finally {
        const finished = { ...job, state: terminal };
        try { await persist(finished); job.state = terminal; job.updatedAt = finished.updatedAt; }
        catch { job.state = 'failed'; job.error = '无法保存任务，请检查本地目录写入权限。'; }
        active.delete(job.id);
      }
    })();
    tasks.set(job.id, task);
  }
  function newJob(type: StudioJob['type'], title: string, request: unknown): StudioJob {
    return { id: randomUUID(), type, title, request, state: 'running', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), stage: '准备中', done: 0, total: 0 };
  }
  const progress = (job: StudioJob, stage: string) => async (done: number, total: number) => { job.stage = stage; job.done = done; job.total = total; await persist(job); };
  const respond = (res: ServerResponse, code: number, data: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
  async function body(req: IncomingMessage) {
    const pieces: Buffer[] = []; let bytes = 0;
    if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('请求必须为 JSON。');
    for await (const chunk of req) { bytes += chunk.length; if (bytes > 250_000) throw new Error('请求内容过大。'); pieces.push(chunk); }
    try { return JSON.parse(Buffer.concat(pieces).toString('utf8')); } catch { throw new Error('请求内容不是有效 JSON。'); }
  }
  let origin = '';
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Frame-Options', 'DENY');
    try {
      if (req.headers.host !== new URL(origin).host || req.headers.origin && req.headers.origin !== origin || req.headers['sec-fetch-site'] === 'cross-site') { respond(res, 403, { error: '仅允许本机操作台访问。' }); return; }
      const url = new URL(req.url ?? '/', origin), path = url.pathname;
      if (req.method === 'GET' && ['/', '/app.js', '/app.css'].includes(path)) {
        const file = path === '/' ? 'index.html' : path.slice(1);
        let content = await readFile(join(options.assetsDir, file));
        if (path === '/') content = Buffer.from(content.toString('utf8').replace('__SESSION_TOKEN__', secret));
        res.writeHead(200, { 'Content-Type': path === '/' ? 'text/html; charset=utf-8' : path.endsWith('.js') ? 'application/javascript; charset=utf-8' : 'text/css; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" }); res.end(content); return;
      }
      if (req.headers['x-jev-session'] !== secret) { respond(res, 403, { error: '会话已失效，请刷新操作台。' }); return; }
      if (path === '/api/state' && req.method === 'GET') {
        respond(res, 200, { credentials: { typesafe: !!credentials.typesafe, github: !!credentials.github, feishuId: !!credentials.feishuId, feishuSecret: !!credentials.feishuSecret, model: credentials.model }, jobs: [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(({ result, receipt, rollback, ...j }) => ({ ...j, hasResult: !!result, hasReceipt: !!receipt, hasRollback: !!rollback })), labels: { repos: REPO_LABELS, kinds: kindLabels, feedback: FEISHU_LABELS, priority: PRIORITY_LABELS }, demoConfig }); return;
      }
      if (path === '/api/session' && req.method === 'POST') {
        const input = credentialsSchema.parse(await body(req));
        if (active.size) throw new Error('请先等待或取消运行中的任务，再更换凭据。');
        for (const key of ['typesafe', 'github', 'feishuId', 'feishuSecret', 'model'] as const) if (input[key]?.trim()) credentials[key] = input[key]!.trim();
        for (const key of input.clear ?? []) credentials[key] = '';
        respond(res, 200, { ok: true }); return;
      }
      if (path === '/api/github' && req.method === 'POST') {
        const input = githubInput.parse(await body(req));
        if (!input.demo && Boolean(input.user.trim()) === Boolean(input.repos.trim())) throw new Error('请选择用户名或仓库清单中的一种来源。');
        if (!input.demo && !credentials.typesafe && !options.createDecision) throw new Error('请先在连接设置中填写 TypeSafe API Key。');
        if (!input.demo && input.user && !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(input.user)) throw new Error('GitHub 用户名格式不正确。');
        const slugs = input.repos.split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#')).map(repoSlug);
        const job = newJob('github', input.demo ? 'GitHub 演示工具箱' : input.user ? `${input.user} 的工具箱` : '指定仓库工具箱', input);
        job.cacheKey = createHash('sha256').update(JSON.stringify([input.demo, input.user, slugs])).digest('hex');
        launch(job, async signal => {
          job.stage = '读取仓库'; await persist(job);
          const source = input.demo ? { repos: demoRepos, limited: false } : input.user ? await github(signal).stars(input.user, input.limit, count => { job.done = count; }) : { repos: await github(signal).repositories(slugs.slice(0, input.limit)), limited: slugs.length > input.limit };
          const catalog = await buildCatalog(source.repos, input.demo ? demoRepoDecide : decision(signal), { out: join(dir, 'catalogs', job.cacheKey!), model: credentials.model, demo: input.demo, limited: source.limited, refresh: input.refresh, threshold: input.threshold, signal, progress: progress(job, '整理用途与产品形态') });
          job.result = catalog; job.stage = `已完成 · ${catalog.cached} 个复用 / ${catalog.classified} 个新判断`;
        }); respond(res, 202, { id: job.id }); return;
      }
      if (path === '/api/feishu' && req.method === 'POST') {
        const input = feishuInput.parse(await body(req));
        if (!input.demo && !credentials.typesafe && !options.createDecision) throw new Error('请先在连接设置中填写 TypeSafe API Key。');
        const job = newJob('feishu', input.demo ? '飞书演示分诊' : '飞书反馈分诊', input);
        launch(job, async signal => {
          job.stage = '检查字段并读取待处理记录'; await persist(job);
          const config = input.demo ? demoConfig : input.config;
          const client = input.demo ? undefined : await feishu(signal);
          await client?.validateFields(config);
          const source = input.demo ? { limited: false, records: [
            { record_id: 'demo001', fields: { 反馈内容: '支付服务全面不可用，所有客户都无法付款，故障仍在持续。' } },
            { record_id: 'demo002', fields: { 反馈内容: '建议增加深色模式，不影响现有使用。' } },
            { record_id: 'demo003', fields: { 反馈内容: '有问题。' } },
          ] } : await client!.records(config, input.limit);
          const plan = await makePlan(source.records, config, input.demo ? demoFeedbackDecide : decision(signal), input.demo, { signal, onProgress: progress(job, '分类与判断优先级') });
          plan.limited = source.limited; job.result = plan; job.stage = '计划已就绪，请审阅后回填';
        }); respond(res, 202, { id: job.id }); return;
      }
      if (['/api/feishu/check', '/api/feishu/setup'].includes(path) && req.method === 'POST') {
        const config = configSchema.parse(await body(req));
        if ([...jobs.values()].some(j => j.type === 'feishu' && j.state === 'running')) throw new Error('请等待飞书任务完成后检查字段。');
        const client = await feishu(new AbortController().signal);
        if (path.endsWith('/setup')) { respond(res, 200, { created: await client.setupFields(config) }); return; }
        const fields = await client.inspectFields(config); respond(res, 200, { fields }); return;
      }
      const match = path.match(/^\/api\/jobs\/([a-f0-9-]{36})(?:\/(cancel|edit|apply|rollback|download))?$/);
      if (match) {
        const job = requireJob(match[1]!); const action = match[2];
        if (!action && req.method === 'GET') { respond(res, 200, job); return; }
        if (action === 'cancel' && req.method === 'POST') { active.get(job.id)?.abort(); respond(res, 200, { ok: true }); return; }
        if (job.state === 'running') throw new Error('任务还在运行，请稍候。');
        if (action === 'edit' && req.method === 'POST') {
          if ([...jobs.values()].some(j => j.type === job.type && j.state === 'running')) throw new Error('该平台有任务正在运行，请完成后再编辑历史结果。');
          if (job.receipt) throw new Error('已有回填记录，不能再修改这份计划；请先撤销或生成新计划。');
          const input = await body(req);
          if (job.type === 'github') {
            const catalog = editCatalog(catalogSchema.parse(job.result), repoEditSchema.parse(input)); job.result = catalog;
            const pending = (catalogQueue.get(job.cacheKey!) ?? Promise.resolve()).catch(() => {}).then(() => saveCatalog(join(dir, 'catalogs', job.cacheKey!), catalog));
            catalogQueue.set(job.cacheKey!, pending); await pending;
          }
          else job.result = editPlan(planSchema.parse(job.result), planEditSchema.parse(input));
          await persist(job); respond(res, 200, job); return;
        }
        if (job.type === 'feishu' && action === 'apply' && req.method === 'POST') {
          const plan = planSchema.parse(job.result); if (plan.demo) throw new Error('演示计划不能回填真实飞书。');
          if (job.rollback) throw new Error('已执行撤销，请重新生成计划。');
          launch(job, async signal => { job.stage = '回填选中记录'; const client = await feishu(signal); job.receipt = await applyPlan(plan, client, async receipt => { job.receipt = receipt; await persist(job); }, { previous: job.receipt, signal, onProgress: progress(job, '回填选中记录') }); job.stage = `回填完成 · ${job.receipt.updated.length} 成功 / ${job.receipt.conflicts.length} 冲突 / ${job.receipt.failed.length} 失败`; });
          respond(res, 202, { id: job.id }); return;
        }
        if (job.type === 'feishu' && action === 'rollback' && req.method === 'POST') {
          const plan = planSchema.parse(job.result), receipt = receiptSchema.parse(job.receipt);
          if (plan.demo) throw new Error('演示计划不能执行真实操作。');
          launch(job, async signal => { job.stage = '检查变更并撤销本次回填'; const client = await feishu(signal); job.rollback = await rollbackPlan(plan, receipt, client, async value => { job.rollback = value; await persist(job); }, { signal }); job.stage = '撤销处理完成，详见回执'; });
          respond(res, 202, { id: job.id }); return;
        }
        if (action === 'download' && req.method === 'GET') {
          const format = url.searchParams.get('format'); let content: string, name: string, type = 'application/json';
          if (job.type === 'github') {
            const catalog = catalogSchema.parse(job.result);
            if (format === 'html') { content = renderCatalogHtml(catalog); name = 'catalog.html'; type = 'text/html'; }
            else if (format === 'md') { content = renderCatalog(catalog.repositories, catalog); name = 'catalog.md'; type = 'text/markdown'; }
            else if (format === 'json') { content = JSON.stringify(catalog, null, 2); name = 'catalog.json'; }
            else throw new Error('不支持的文件格式。');
          } else {
            if (format === 'receipt' && job.receipt) { content = JSON.stringify(job.receipt, null, 2); name = 'receipt.json'; }
            else if (format === 'rollback' && job.rollback) { content = JSON.stringify(job.rollback, null, 2); name = 'rollback.json'; }
            else if (format === 'json') { content = JSON.stringify(planSchema.parse(job.result), null, 2); name = 'feishu-plan.json'; }
            else throw new Error('没有该导出文件。');
          }
          res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' }); res.end(content); return;
        }
      }
      respond(res, 404, { error: '接口不存在。' });
    } catch (error) { respond(res, 400, { error: error instanceof z.ZodError ? '输入格式不正确，请检查必填项和数值范围。' : error instanceof Error ? error.message : '操作失败。' }); }
  });
  server.requestTimeout = 30_000; server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 4318, '127.0.0.1', () => { const address = server.address(); origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : options.port}`; resolve(); }); });
  return { server, origin, close: async () => { for (const controller of active.values()) controller.abort(); await Promise.allSettled([...tasks.values(), ...saveQueue.values()]); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}
