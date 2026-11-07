// The service worker: the toolbar badge shows how many notes the active tab's site has.
import { load, originOf } from './notes.js';

async function badge(tabId, url) {
  const origin = originOf(url ?? '');
  const count = origin ? (await load(origin)).length : 0;
  await chrome.action.setBadgeText({ tabId, text: count ? String(count) : '' });
}
chrome.action.setBadgeBackgroundColor({ color: '#3341c4' });
chrome.tabs.onActivated.addListener(async ({ tabId }) => badge(tabId, (await chrome.tabs.get(tabId)).url));
chrome.tabs.onUpdated.addListener((tabId, change, tab) => change.status === 'complete' && badge(tabId, tab.url));
chrome.storage.onChanged.addListener(async () => {
  for (const tab of await chrome.tabs.query({})) await badge(tab.id, tab.url);
});
