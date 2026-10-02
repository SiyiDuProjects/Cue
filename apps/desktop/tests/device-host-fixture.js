// Synthetic zero-valued tracks; never opens a microphone or display.
const syntheticMedia = async () => {
  const context = new AudioContext({ sampleRate: 24000 });
  const source = context.createConstantSource(); source.offset.value = 0;
  const destination = context.createMediaStreamDestination();
  source.connect(destination); source.start(); await context.resume();
  return destination.stream;
};
navigator.mediaDevices.getUserMedia = syntheticMedia;
navigator.mediaDevices.getDisplayMedia = syntheticMedia;
const sendControl = WebSocket.prototype.send;
WebSocket.prototype.send = function(data) { if (typeof data === 'string') return sendControl.call(this, data); };
window.interviewDesktop = {
  isElectron: true, captureHost: true, apiBaseUrl: location.origin,
  getWindowState: async () => ({ collapsed: false, pinned: false }),
  setCodeExpanded: async () => {}, setCollapsed: async value => value, setPinned: async value => value,
  createInterview: async () => (await fetch('/api/interviews', {
    method: 'POST', headers: { Authorization: 'Bearer device-audit', 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_name: '测试电脑' }),
  })).json(),
  requestCaptureInitialization: async () => window.dispatchEvent(new Event('sage:capture-initialize')),
};
