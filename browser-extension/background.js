// The note on a handed-off GitHub page can close its tab (content scripts can't).
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message === 'close-tab' && sender.tab?.id !== undefined) chrome.tabs.remove(sender.tab.id);
});
