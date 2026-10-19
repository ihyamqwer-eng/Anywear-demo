let popupWindowId = null;

function popupUrl(imageUrl, name) {
  const params = new URLSearchParams({ image: imageUrl, name });
  return `${chrome.runtime.getURL('popup.html')}?${params.toString()}`;
}

chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.type !== 'anywear-image-click' || typeof message.imageUrl !== 'string') return;

  const url = popupUrl(message.imageUrl, typeof message.name === 'string' ? message.name : '网页服装');
  if (popupWindowId === null) {
    chrome.windows.create({
      url,
      type: 'popup',
      width: 460,
      height: 820,
      focused: true,
    }, (popup) => {
      popupWindowId = popup?.id ?? null;
    });
    return;
  }

  chrome.windows.update(popupWindowId, { focused: true }, () => {
    if (chrome.runtime.lastError) {
      popupWindowId = null;
      chrome.windows.create({ url, type: 'popup', width: 460, height: 820, focused: true }, (popup) => {
        popupWindowId = popup?.id ?? null;
      });
      return;
    }
    chrome.windows.get(popupWindowId, { populate: true }, (popup) => {
      const tabId = popup?.tabs?.[0]?.id;
      if (tabId !== undefined) chrome.tabs.update(tabId, { url });
    });
  });
});

chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === popupWindowId) popupWindowId = null;
});
