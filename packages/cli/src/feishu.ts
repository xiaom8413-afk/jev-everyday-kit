import { createHash } from 'node:crypto';
import { z } from 'zod';
import { classifyFeedback, FEISHU_LABELS, PRIORITY_LABELS, type FeedbackDecision } from '../../core/src/classify';
import { certainty, isObject, type Decide, type ClassificationOptions } from '../../core/src/jev';
import { jsonRequest } from './http';

const identifier = z.string().regex(/^[A-Za-z0-9_-]+$/);
export const configSchema = z.object({
  appToken: identifier, tableId: identifier, viewId: identifier.optional(), threshold: z.number().min(0.5).max(0.99).optional(),
  sourceField: z.string().min(1),
  fields: z.object({ category: z.string().min(1), priority: z.string().min(1), status: z.string().min(1), confidence: z.string().min(1) }).strict(),
}).strict().refine(c => new Set([c.sourceField, ...Object.values(c.fields)]).size === 5, '输入列和四个输出列必须各不相同');
export type FeishuConfig = z.infer<typeof configSchema>;
export interface BitableRecord { record_id: string; fields: Record<string, unknown> }
const recordSchema = z.object({ record_id: identifier, fields: z.record(z.string(), z.unknown()) });
export function fieldText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every(v => isObject(v) && typeof v.text === 'string')) return value.map(v => v.text).join('');
  throw new Error('字段不是文本类型；请将输入列和输出列设置为多行文本。');
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export function inputHash(record: BitableRecord, config: FeishuConfig): string { return hash(fieldText(record.fields[config.sourceField])); }
export function outputFields(decision: FeedbackDecision, config: FeishuConfig): Record<string, string> {
  return {
    [config.fields.category]: decision.review ? '待确认' : FEISHU_LABELS[decision.category]!,
    [config.fields.priority]: decision.review ? '待确认' : PRIORITY_LABELS[decision.priority]!,
    [config.fields.status]: decision.review ? '待人工确认' : '已分类',
    [config.fields.confidence]: `${Math.round(Math.min(certainty(decision.answer), certainty(decision.priorityAnswer)) * 100)}%`,
  };
}
const planEntrySchema = z.object({
  recordId: identifier, inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  preview: z.string(), fields: z.record(z.string(), z.string()),
  suggestedCategory: z.enum(['bug', 'feature', 'access', 'billing', 'question', 'other']),
  suggestedPriority: z.enum(['urgent', 'normal', 'low', 'review']), review: z.boolean(),
  excluded: z.boolean().optional(), manual: z.boolean().optional(), originalFields: z.record(z.string(), z.string()).optional(),
}).strict();
export const planSchema = z.object({ version: z.literal(1), demo: z.boolean(), createdAt: z.iso.datetime(), config: configSchema, entries: z.array(planEntrySchema).max(5000), skipped: z.number().int().nonnegative(), limited: z.boolean().optional() }).strict().superRefine((plan, ctx) => {
  const ids = new Set<string>();
  const f = plan.config.fields;
  for (const entry of plan.entries) {
    if (ids.has(entry.recordId)) ctx.addIssue({ code: 'custom', message: '计划中存在重复记录' });
    ids.add(entry.recordId);
    if (Object.keys(entry.fields).sort().join('\0') !== Object.values(f).sort().join('\0')) ctx.addIssue({ code: 'custom', message: '计划包含配置以外的写入字段' });
    const expectedCategory = entry.review ? '待确认' : FEISHU_LABELS[entry.suggestedCategory];
    const expectedPriority = entry.review ? '待确认' : PRIORITY_LABELS[entry.suggestedPriority];
    if (entry.fields[f.category] !== expectedCategory || entry.fields[f.priority] !== expectedPriority ||
      entry.fields[f.status] !== (entry.manual ? '人工已确认' : entry.review ? '待人工确认' : '已分类') || !/^(100|[0-9]{1,2})%$/.test(entry.fields[f.confidence] ?? '')) ctx.addIssue({ code: 'custom', message: '计划分类字段无效' });
    if (entry.originalFields && (Object.keys(entry.originalFields).sort().join('\0') !== Object.values(f).sort().join('\0') || Object.values(entry.originalFields).some(v => v.trim()))) ctx.addIssue({ code: 'custom', message: '原始输出必须为空白且仅包含配置的四列' });
  }
});
export type FeishuPlan = z.infer<typeof planSchema>;

export class FeishuClient {
  constructor(private token: string, private fetcher: typeof fetch = fetch, private signal?: AbortSignal) {}
  static async login(appId: string, appSecret: string, fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<FeishuClient> {
    if (!appId.trim() || !appSecret.trim()) throw new Error('请设置 FEISHU_APP_ID 和 FEISHU_APP_SECRET。');
    const raw = await jsonRequest('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ app_id: appId.trim(), app_secret: appSecret.trim() }),
    }, fetcher);
    if (!isObject(raw) || raw.code !== 0 || typeof raw.tenant_access_token !== 'string') throw new Error('飞书应用认证失败，请检查 App ID、Secret 及应用状态。');
    return new FeishuClient(raw.tenant_access_token, fetcher, signal);
  }
  private async request(path: string, body?: unknown): Promise<Record<string, unknown>> {
    const raw = await jsonRequest(`https://open.feishu.cn/open-apis/bitable/v1${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      signal: path.includes('/records/batch_update') || path.endsWith('/fields') ? undefined : this.signal,
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, this.fetcher);
    if (!isObject(raw) || raw.code !== 0 || !isObject(raw.data)) throw new Error(`飞书 API 返回错误（${isObject(raw) && typeof raw.code === 'number' ? raw.code : '未知'}），请检查表格权限与字段配置。`);
    return raw.data;
  }
  private base(config: FeishuConfig): string { return `/apps/${encodeURIComponent(config.appToken)}/tables/${encodeURIComponent(config.tableId)}`; }
  async inspectFields(config: FeishuConfig): Promise<{ field_name: string; type: number }[]> {
    const found: { field_name: string; type: number }[] = [];
    let pageToken = '';
    const seen = new Set<string>();
    do {
      const params = new URLSearchParams({ page_size: '100', ...(pageToken ? { page_token: pageToken } : {}) });
      const data = await this.request(`${this.base(config)}/fields?${params}`);
      const items = z.array(z.object({ field_name: z.string(), type: z.number() })).parse(data.items ?? []);
      found.push(...items);
      if (!data.has_more) break;
      pageToken = z.string().min(1).parse(data.page_token);
      if (seen.has(pageToken)) throw new Error('飞书返回了重复分页游标。');
      seen.add(pageToken);
    } while (true);
    return found;
  }
  async validateFields(config: FeishuConfig): Promise<void> {
    const found = await this.inspectFields(config);
    const missing: string[] = [];
    for (const name of [config.sourceField, ...Object.values(config.fields)]) {
      const field = found.find(f => f.field_name === name);
      if (!field) missing.push(name);
      else if (field.type !== 1) throw new Error(`列“${name}”必须是多行文本类型。`);
    }
    if (missing.length) throw new Error(`请先在飞书表中创建多行文本列：${missing.join('、')}`);
  }
  async setupFields(config: FeishuConfig): Promise<string[]> {
    const found = await this.inspectFields(config);
    if (!found.some(f => f.field_name === config.sourceField && f.type === 1)) throw new Error('请先创建多行文本类型的输入列。');
    for (const name of Object.values(config.fields)) if (found.some(f => f.field_name === name && f.type !== 1)) throw new Error(`列“${name}”已存在且不是文本类型。`);
    const created: string[] = [];
    for (const name of Object.values(config.fields)) if (!found.some(f => f.field_name === name)) {
      this.signal?.throwIfAborted();
      await this.request(`${this.base(config)}/fields`, { field_name: name, type: 1 }); created.push(name);
    }
    return created;
  }
  async records(config: FeishuConfig, limit: number): Promise<{ records: BitableRecord[]; limited: boolean }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 5000) throw new Error('反馈上限必须在 1–5000 之间。');
    const records: BitableRecord[] = []; let pageToken = ''; const seen = new Set<string>();
    do {
      const params = new URLSearchParams({ page_size: String(Math.min(100, limit - records.length)), ...(pageToken ? { page_token: pageToken } : {}) });
      const data = await this.request(`${this.base(config)}/records/search?${params}`, {
        field_names: [config.sourceField, ...Object.values(config.fields)], ...(config.viewId ? { view_id: config.viewId } : {}),
        filter: { conjunction: 'and', conditions: [
          { field_name: config.sourceField, operator: 'isNotEmpty' },
          ...Object.values(config.fields).map(field_name => ({ field_name, operator: 'isEmpty' })),
        ] },
      });
      records.push(...z.array(recordSchema).parse(data.items ?? []));
      if (!data.has_more) return { records: records.slice(0, limit), limited: records.length > limit };
      if (records.length >= limit) return { records: records.slice(0, limit), limited: true };
      pageToken = z.string().min(1).parse(data.page_token);
      if (seen.has(pageToken)) throw new Error('飞书返回了重复分页游标。');
      seen.add(pageToken);
    } while (true);
  }
  async record(config: FeishuConfig, recordId: string): Promise<BitableRecord> {
    const data = await this.request(`${this.base(config)}/records/batch_get`, { record_ids: [recordId] });
    const records = z.array(recordSchema).parse(data.records ?? []);
    const record = records.find(r => r.record_id === recordId);
    if (!record) throw new Error('计划中的记录已被删除或当前应用无权读取，请重新生成计划。');
    return record;
  }
  async update(config: FeishuConfig, entries: { recordId: string; fields: Record<string, string> }[]): Promise<void> {
    const data = await this.request(`${this.base(config)}/records/batch_update`, { records: entries.map(e => ({ record_id: e.recordId, fields: e.fields })) });
    const confirmed = new Set(z.array(z.object({ record_id: z.string() })).parse(data.records ?? []).map(r => r.record_id));
    if (entries.some(e => !confirmed.has(e.recordId))) throw new Error('飞书未确认全部写入结果，请检查表格后重跑同一计划。');
  }
}

export async function makePlan(records: BitableRecord[], config: FeishuConfig, decide: Decide, demo = false, options: ClassificationOptions = {}): Promise<FeishuPlan> {
  const pending = records.filter(r => fieldText(r.fields[config.sourceField]).trim() && Object.values(config.fields).every(k => !fieldText(r.fields[k]).trim()));
  const results = await classifyFeedback(pending.map(r => ({ id: r.record_id, text: fieldText(r.fields[config.sourceField]) })), decide, { threshold: config.threshold, ...options });
  return planSchema.parse({ version: 1, demo, createdAt: new Date().toISOString(), config,
    entries: results.map((r, i) => ({ recordId: r.id, inputHash: inputHash(pending[i]!, config), preview: r.text.slice(0, 800), fields: outputFields(r, config), originalFields: Object.fromEntries(Object.values(config.fields).map(k => [k, fieldText(pending[i]!.fields[k])])), suggestedCategory: r.category, suggestedPriority: r.priority, review: r.review })), skipped: records.length - pending.length });
}
export const planEditSchema = z.object({ recordId: identifier, category: z.enum(['bug', 'feature', 'access', 'billing', 'question', 'other']).optional(), priority: z.enum(['urgent', 'normal', 'low', 'review']).optional(), excluded: z.boolean().optional() }).strict();
export function editPlan(plan: FeishuPlan, edit: z.infer<typeof planEditSchema>): FeishuPlan {
  edit = planEditSchema.parse(edit);
  const next = structuredClone(plan), entry = next.entries.find(e => e.recordId === edit.recordId);
  if (!entry) throw new Error('没有找到该记录。');
  if (edit.excluded !== undefined) entry.excluded = edit.excluded;
  if (edit.category || edit.priority) {
    entry.suggestedCategory = edit.category ?? entry.suggestedCategory; entry.suggestedPriority = edit.priority ?? entry.suggestedPriority;
    entry.review = entry.suggestedPriority === 'review'; entry.manual = true;
    entry.fields[next.config.fields.category] = entry.review ? '待确认' : FEISHU_LABELS[entry.suggestedCategory]!;
    entry.fields[next.config.fields.priority] = entry.review ? '待确认' : PRIORITY_LABELS[entry.suggestedPriority]!;
    entry.fields[next.config.fields.status] = '人工已确认';
  }
  return planSchema.parse(next);
}
const operationSchema = z.object({ recordId: identifier, before: z.record(z.string(), z.string()), after: z.record(z.string(), z.string()), inputHash: z.string() }).strict();
export const receiptSchema = z.object({ version: z.literal(2), planHash: z.string(), updated: z.array(identifier), alreadyApplied: z.array(identifier), conflicts: z.array(identifier), failed: z.array(z.object({ recordId: identifier, error: z.string() })), pending: z.array(identifier), operations: z.array(operationSchema), cancelled: z.boolean() }).strict();
export type ApplyReceipt = z.infer<typeof receiptSchema>;
export const planHash = (plan: FeishuPlan) => hash(JSON.stringify(planSchema.parse(plan)));
export async function applyPlan(plan: FeishuPlan, client: Pick<FeishuClient, 'validateFields' | 'record' | 'update'>, save: (receipt: ApplyReceipt) => Promise<void> = async () => {}, options: { previous?: ApplyReceipt; signal?: AbortSignal; onProgress?: (done: number, total: number) => void | Promise<void> } = {}): Promise<ApplyReceipt> {
  plan = planSchema.parse(plan);
  if (plan.demo) throw new Error('演示计划不能回填真实飞书表格。');
  await client.validateFields(plan.config);
  const previous = options.previous ? receiptSchema.parse(options.previous) : undefined;
  if (previous && previous.planHash !== planHash(plan)) throw new Error('计划已修改，不能覆盖旧回执。请创建新的回填任务。');
  const selected = plan.entries.filter(e => !e.excluded);
  const receipt: ApplyReceipt = { version: 2, planHash: planHash(plan), updated: previous?.updated ?? [], alreadyApplied: [], conflicts: [], failed: [], pending: selected.map(e => e.recordId), operations: previous?.operations ?? [], cancelled: false };
  await save(structuredClone(receipt));
  for (const entry of selected) {
    if (options.signal?.aborted) { receipt.cancelled = true; break; }
    try {
    const current = await client.record(plan.config, entry.recordId);
    if (inputHash(current, plan.config) !== entry.inputHash) receipt.conflicts.push(entry.recordId);
    else if (Object.entries(entry.fields).every(([key, value]) => fieldText(current.fields[key]) === value)) receipt.alreadyApplied.push(entry.recordId);
    else if (Object.values(plan.config.fields).some(k => fieldText(current.fields[k]).trim())) receipt.conflicts.push(entry.recordId);
    else {
      // Re-read immediately before each write; the API has no conditional update / CAS.
      const before = Object.fromEntries(Object.keys(entry.fields).map(k => [k, fieldText(current.fields[k])]));
      await client.update(plan.config, [entry]);
      if (!receipt.updated.includes(entry.recordId)) receipt.updated.push(entry.recordId);
      if (!receipt.operations.some(o => o.recordId === entry.recordId)) receipt.operations.push({ recordId: entry.recordId, before, after: structuredClone(entry.fields), inputHash: entry.inputHash });
    }
    } catch (error) { receipt.failed.push({ recordId: entry.recordId, error: error instanceof Error ? error.message : '操作失败' }); }
    receipt.pending = receipt.pending.filter(id => id !== entry.recordId);
    await save(structuredClone(receipt));
    await options.onProgress?.(selected.length - receipt.pending.length, selected.length);
  }
  await save(structuredClone(receipt));
  return receipt;
}
export interface RollbackReceipt { restored: string[]; conflicts: string[]; failed: { recordId: string; error: string }[]; pending: string[]; cancelled: boolean }
export async function rollbackPlan(plan: FeishuPlan, receipt: ApplyReceipt, client: Pick<FeishuClient, 'validateFields' | 'record' | 'update'>, save: (value: RollbackReceipt) => Promise<void> = async () => {}, options: { signal?: AbortSignal } = {}): Promise<RollbackReceipt> {
  plan = planSchema.parse(plan); receipt = receiptSchema.parse(receipt);
  if (plan.demo || receipt.planHash !== planHash(plan)) throw new Error('回执与真实计划不匹配。');
  for (const op of receipt.operations) {
    const entry = plan.entries.find(e => e.recordId === op.recordId);
    if (!entry || op.inputHash !== entry.inputHash || JSON.stringify(op.after) !== JSON.stringify(entry.fields) || Object.keys(op.before).sort().join('\0') !== Object.keys(entry.fields).sort().join('\0') || Object.values(op.before).some(v => v.trim())) throw new Error('回执包含无效的撤销操作。');
  }
  await client.validateFields(plan.config);
  const result: RollbackReceipt = { restored: [], conflicts: [], failed: [], pending: receipt.operations.map(o => o.recordId), cancelled: false };
  await save(structuredClone(result));
  for (const op of receipt.operations) {
    if (options.signal?.aborted) { result.cancelled = true; break; }
    try {
      const current = await client.record(plan.config, op.recordId);
      if (inputHash(current, plan.config) === op.inputHash && Object.entries(op.before).every(([k, v]) => fieldText(current.fields[k]) === v)) result.restored.push(op.recordId);
      else if (inputHash(current, plan.config) !== op.inputHash || !Object.entries(op.after).every(([k, v]) => fieldText(current.fields[k]) === v)) result.conflicts.push(op.recordId);
      else { await client.update(plan.config, [{ recordId: op.recordId, fields: op.before }]); result.restored.push(op.recordId); }
    } catch (error) { result.failed.push({ recordId: op.recordId, error: error instanceof Error ? error.message : '撤销失败' }); }
    result.pending = result.pending.filter(id => id !== op.recordId);
    await save(structuredClone(result));
  }
  await save(structuredClone(result));
  return result;
}
