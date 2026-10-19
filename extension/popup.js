const params = new URLSearchParams(location.search);
const imageUrl = params.get('image') || '';
const name = params.get('name') || '网页服装';
const frame = document.getElementById('anywear');
const loading = document.getElementById('loading');
const appOrigin = 'http://127.0.0.1:5173';

function toDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('无法读取网页图片'));
    reader.readAsDataURL(blob);
  });
}

async function loadImageData() {
  if (imageUrl.startsWith('data:image/')) return imageUrl;
  const response = await fetch(imageUrl, { credentials: 'omit' });
  if (!response.ok) throw new Error(`图片读取失败：${response.status}`);
  const blob = await response.blob();
  if (!blob.type.startsWith('image/')) throw new Error('网页资源不是图片');
  return toDataUrl(blob);
}

frame.src = `${appOrigin}/?compact=1&extension=1`;
frame.addEventListener('error', () => {
  loading.textContent = '本地 Anywear 页面无法加载，请先启动 npm run dev';
});
frame.addEventListener('load', async () => {
  try {
    const imageData = await loadImageData();
    frame.contentWindow.postMessage({ type: 'anywear-garment-image', imageData, name }, appOrigin);
    loading.remove();
    frame.hidden = false;
  } catch (error) {
    loading.textContent = error instanceof Error ? error.message : '网页图片无法读取';
  }
});
