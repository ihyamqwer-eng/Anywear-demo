(() => {
  if (location.hostname === '127.0.0.1' || location.hostname === 'localhost') return;

  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('img') : null;
    if (!target || !target.currentSrc) return;

    chrome.runtime.sendMessage({
      type: 'anywear-image-click',
      imageUrl: target.currentSrc,
      name: target.alt || '网页服装',
    });
  }, true);
})();
