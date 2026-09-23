import type { ChoiceAnswer, Decide } from './jev';
import type { TabInput, RepoInput } from './classify';
export function sampleAnswer(criteria: Record<string, string>, selected: string, probability = 0.94): ChoiceAnswer {
  const keys = Object.keys(criteria);
  if (!keys.includes(selected)) throw new Error('Invalid demo choice');
  return { type: 'choice', choice: selected, confidence: probability, probabilities: Object.fromEntries(keys.map(key => [key, key === selected ? probability : (1 - probability) / (keys.length - 1)])) };
}
export const demoTabs: TabInput[] = [
  { id: 101, title: 'TypeScript Handbook', url: 'https://www.typescriptlang.org/docs/' },
  { id: 102, title: 'GitHub · 项目代码', url: 'https://github.com/example/project' },
  { id: 103, title: '飞书 · 团队工作台', url: 'https://www.feishu.cn/' },
  { id: 104, title: 'Gmail · 收件箱', url: 'https://mail.google.com/' },
  { id: 105, title: '设计中的留白 · 阅读', url: 'https://example.com/article' },
  { id: 106, title: '稍后阅读 · 学习笔记', url: 'https://example.org/notes' },
  { id: 107, title: 'Untitled', url: 'https://example.net/' },
];
export const demoTabDecide: Decide = async ({ questions }) => Object.fromEntries(Object.entries(questions).map(([id, q]) => {
  const pick: Record<string, string> = { tab_101: 'develop', tab_102: 'develop', tab_103: 'work', tab_104: 'work', tab_105: 'research', tab_106: 'research', tab_107: 'other' };
  return [id, sampleAnswer(q.criteria, pick[id] ?? 'other', id === 'tab_107' ? 0.48 : 0.94)];
}));
export const demoRepos: RepoInput[] = [
  { full_name: 'example/agent-workbench', description: '示例：构建与调试 AI Agent 的 SDK', topics: ['ai', 'agents'], language: 'TypeScript', archived: false, stargazers_count: 1200, html_url: 'https://github.com/example/agent-workbench' },
  { full_name: 'example/focus-notes', description: '示例：本地笔记与知识管理应用', topics: ['notes'], language: 'TypeScript', archived: false, stargazers_count: 800, html_url: 'https://github.com/example/focus-notes' },
  { full_name: 'example/tiny-deploy', description: '示例：命令行自动部署工具', topics: ['devops'], language: 'Go', archived: false, stargazers_count: 600, html_url: 'https://github.com/example/tiny-deploy' },
  { full_name: 'example/mystery', description: '', topics: [], language: null, archived: true, stargazers_count: 3, html_url: 'https://github.com/example/mystery' },
];
export const demoRepoDecide: Decide = async ({ questions }) => Object.fromEntries(Object.entries(questions).map(([id, q]) => {
  const index = Number(id.split('_')[1]);
  const picks = id.startsWith('category') ? ['ai', 'productivity', 'devops', 'other'] : ['library', 'app', 'cli', 'other'];
  return [id, sampleAnswer(q.criteria, picks[index] ?? 'other', index === 3 ? 0.5 : 0.94)];
}));
export const demoFeedbackDecide: Decide = async ({ questions }) => Object.fromEntries(Object.entries(questions).map(([id, q]) => {
  const index = Number(id.split('_')[1]);
  const picks = id.startsWith('category') ? ['bug', 'feature', 'other'] : ['urgent', 'low', 'review'];
  return [id, sampleAnswer(q.criteria, picks[index] ?? 'other', index === 2 ? 0.5 : 0.94)];
}));
