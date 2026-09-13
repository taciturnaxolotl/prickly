// Offscreen documents are exempt from MV3's 30s idle kill. A message every
// 20s resets the service worker's timer, which is what keeps a long browser
// automation call from dying halfway through.
setInterval(() => {
  chrome.runtime.sendMessage({ type: "SW_KEEPALIVE" }).catch(() => {});
}, 20_000);
