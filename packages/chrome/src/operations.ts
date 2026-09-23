import type { TabDecision } from '../../core/src/classify';
export function eligibleTab(tab: chrome.tabs.Tab): boolean {
  return tab.id !== undefined && !tab.pinned && !tab.incognito && tab.groupId === -1 && /^https?:\/\//.test(tab.url ?? '');
}
export function unchangedTab(tab: chrome.tabs.Tab, item: TabDecision, windowId: number): boolean {
  return eligibleTab(tab) && tab.id === item.id && tab.windowId === windowId && tab.url === item.url && (tab.title ?? '') === item.title;
}
