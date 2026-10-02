const button = document.querySelector('#connect');
const status = document.querySelector('#status');
async function api(path, method = 'GET') {
  const response = await fetch('/plugin/' + path, { method, credentials: 'same-origin', headers: { 'Accept': 'application/json' } });
  const result = await response.json();
  if (!response.ok) throw new Error(result.detail || '连接失败，请从 ChatGPT 重试。');
  return result;
}
button.addEventListener('click', async () => {
  button.disabled = true;
  try {
    await api('begin', 'POST');
    status.textContent = '请在 Sage 电脑端点击「允许」。等待确认…';
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      const result = await api('status');
      if (result.status === 'approved') {
        status.textContent = '已允许，正在返回 ChatGPT…';
        const finish = await api('finish', 'POST');
        window.location.assign(finish.redirect);
        return;
      }
      if (result.status !== 'pending') throw new Error('连接未获允许或已超时，请重新尝试。');
      await new Promise(resolve => setTimeout(resolve, 1200));
    }
    throw new Error('等待确认超时，请重新尝试。');
  } catch (error) {
    status.textContent = error.message;
    button.disabled = false;
  }
});
