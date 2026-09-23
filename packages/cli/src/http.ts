export async function jsonRequest(url: string, init: RequestInit = {}, fetcher: typeof fetch = fetch): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(25_000), ...(init.signal ? [init.signal] : [])]) });
  } catch { if (init.signal?.aborted) throw new Error('任务已取消。'); throw new Error(`无法连接 ${new URL(url).hostname}，请检查网络或稍后重试。`); }
  if (!response.ok) {
    const rateLimited = response.status === 429 || response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0';
    throw new Error(`${new URL(url).hostname} HTTP ${response.status}。${rateLimited ? '请求额度已用尽，请等待额度恢复或配置有效 Token。' : '请检查权限、配置或 API 限额。'}`);
  }
  try { return await response.json(); } catch { throw new Error(`${new URL(url).hostname} 返回了无效 JSON。`); }
}
