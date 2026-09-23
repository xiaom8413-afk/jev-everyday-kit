import { choice, inBatches, trusted, type ChoiceAnswer, type Decide, type DecisionRequest, type ClassificationOptions } from './jev';

export const TAB_CATEGORIES = {
  work: '工作协作、项目管理、邮箱和办公工具',
  develop: '编程、代码仓库、开发文档和技术排错',
  research: '学习、资料检索、文章和参考资料',
  life: '购物、出行、生活服务',
  leisure: '视频、音乐、游戏和社交娱乐',
  other: '信息不足，或不属于任何上述用途',
};
export const TAB_LABELS: Record<string, string> = { work: '工作', develop: '开发', research: '阅读学习', life: '生活', leisure: '休闲', other: '待整理' };
export interface TabInput { id: number; title: string; url: string }
export interface TabDecision extends TabInput { answer: ChoiceAnswer; category: string; eligible: boolean }
export function tabHost(url: string): string | null {
  try { const u = new URL(url); return ['https:', 'http:'].includes(u.protocol) ? u.hostname : null; } catch { return null; }
}
export async function classifyTabs(tabs: TabInput[], decide: Decide, options: ClassificationOptions = {}): Promise<TabDecision[]> {
  return inBatches(tabs.filter(t => tabHost(t.url)), 15, async batch => {
    const questions = Object.fromEntries(batch.map(t => [`tab_${t.id}`, choice(`将 id=${t.id} 的标签页按主要用途分类。`, TAB_CATEGORIES)]));
    const answers = await decide({ state: { tabs: batch.map(t => ({ id: t.id, title: t.title.slice(0, 250), hostname: tabHost(t.url) })) }, questions });
    return batch.map(t => { const answer = answers[`tab_${t.id}`]!; return { ...t, answer, category: answer.choice, eligible: trusted(answer, options.threshold) && answer.choice !== 'other' }; });
  }, options);
}

export const REPO_CATEGORIES: Record<string, string> = {
  ai: 'AI、机器学习、Agent、模型与推理工具', web: '前端、后端、Web 框架与 API 开发',
  developer: '编辑器、终端、调试、测试和开发效率工具', data: '数据库、数据处理、分析与可视化',
  devops: '部署、容器、云基础设施、监控与运维', automation: '工作流、爬虫、自动化和系统集成',
  productivity: '笔记、知识管理、办公与个人效率', design: '设计、图像、音视频与创意工具',
  security: '安全审计、身份、加密与隐私', learning: '教程、课程、书籍、示例或资源合集', other: '无法确定主要用途',
};
export const REPO_LABELS: Record<string, string> = { ai: 'AI 与 Agent', web: 'Web 开发', developer: '开发工具', data: '数据与数据库', devops: '部署与运维', automation: '自动化', productivity: '效率与知识管理', design: '设计与多媒体', security: '安全与隐私', learning: '学习资源', other: '待确认' };
export const REPO_KINDS = { app: '用户直接使用的应用', cli: '命令行工具', library: 'SDK、库或框架', service: '需要部署的服务或平台', resource: '文档、教程或资源合集', other: '无法确定' };
export interface RepoInput { full_name: string; description: string; topics: string[]; language: string | null; archived: boolean; stargazers_count: number; html_url: string }
export interface RepoDecision extends RepoInput { category: string; kind: string; review: boolean; answer: ChoiceAnswer; kindAnswer: ChoiceAnswer; manual?: boolean; note?: string }
export async function classifyRepos(repos: RepoInput[], decide: Decide, options: ClassificationOptions = {}): Promise<RepoDecision[]> {
  return inBatches(repos, 10, async batch => {
    const questions: DecisionRequest['questions'] = {};
    batch.forEach((r, i) => {
      questions[`category_${i}`] = choice(`仓库 item=${i} 最主要的用途是什么？以简介和 topics 为准。`, REPO_CATEGORIES);
      questions[`kind_${i}`] = choice(`仓库 item=${i} 以哪种产品形态提供？`, REPO_KINDS);
    });
    const answers = await decide({ state: { repositories: batch.map((r, i) => ({ item: i, name: r.full_name, description: r.description.slice(0, 1500), topics: r.topics.slice(0, 20), language: r.language })) }, questions });
    return batch.map((r, i) => {
      const answer = answers[`category_${i}`]!, kindAnswer = answers[`kind_${i}`]!;
      const review = !trusted(answer, options.threshold) || answer.choice === 'other';
      return { ...r, category: review ? 'other' : answer.choice, kind: trusted(kindAnswer, options.threshold) ? kindAnswer.choice : 'other', review, answer, kindAnswer };
    });
  }, options);
}

export const FEISHU_CATEGORIES = { bug: '已有功能错误、报错或故障', feature: '新功能、改进建议或产品需求', access: '权限、账号、登录与访问申请', billing: '订单、账单、支付与发票问题', question: '操作咨询或使用帮助', other: '信息不足或其他事项' };
export const FEISHU_LABELS: Record<string, string> = { bug: '故障反馈', feature: '功能需求', access: '账号权限', billing: '订单账单', question: '使用咨询', other: '其他' };
export const PRIORITIES = { urgent: '明确正在发生的数据丢失、安全事件、大范围不可用或核心交易中断', normal: '局部功能受影响但有替代路径，或有明确工作期限', low: '一般咨询、改进建议或不阻塞工作的需求', review: '内容太少或相互矛盾，无法确定影响' };
export const PRIORITY_LABELS: Record<string, string> = { urgent: '紧急', normal: '常规', low: '低', review: '待确认' };
export interface FeedbackInput { id: string; text: string }
export interface FeedbackDecision extends FeedbackInput { category: string; priority: string; review: boolean; answer: ChoiceAnswer; priorityAnswer: ChoiceAnswer }
export async function classifyFeedback(items: FeedbackInput[], decide: Decide, options: ClassificationOptions = {}): Promise<FeedbackDecision[]> {
  return inBatches(items, 6, async batch => {
    const questions: DecisionRequest['questions'] = {};
    batch.forEach((item, i) => {
      questions[`category_${i}`] = choice(`对 item=${i} 的反馈分类。`, FEISHU_CATEGORIES);
      questions[`priority_${i}`] = choice(`仅依据 item=${i} 中明确描述的影响确定处理优先级。措辞激烈不代表紧急，不推测未给出的损失。`, PRIORITIES);
    });
    const answers = await decide({ state: { feedback: batch.map((r, i) => ({ item: i, text: r.text.slice(0, 4000) })) }, questions });
    return batch.map((r, i) => {
      const answer = answers[`category_${i}`]!, priorityAnswer = answers[`priority_${i}`]!;
      return { ...r, category: answer.choice, priority: priorityAnswer.choice, review: !trusted(answer, options.threshold) || !trusted(priorityAnswer, options.threshold) || answer.choice === 'other' || priorityAnswer.choice === 'review', answer, priorityAnswer };
    });
  }, options);
}
