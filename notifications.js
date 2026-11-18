// Notifications run only while this page is open and its authenticated session is active.
export function createMessageAlerts({ getUser, onUnread, onOpen, onStatus }) {
  let session = null, enabled = true, audio = null, popup = null, popupTimer;
  let lastSound = -Infinity;
  const inBackground = () => document.hidden || !document.hasFocus();
  const supported = () => 'Notification' in window && window.isSecureContext;
  const preferenceKey = () => 'cuppimxas-alerts:' + session?.username;
  function update() {
    onStatus({ enabled, permission: supported() ? Notification.permission : 'unsupported' });
  }
  function closePopup() {
    clearTimeout(popupTimer); popup?.close(); popup = null;
  }
  function stop() {
    session = null; closePopup(); lastSound = -Infinity;
    const context = audio; audio = null;
    if (context && context.state !== 'closed') context.close().catch(() => {});
  }
  function start(user) {
    if (session) stop();
    closePopup(); lastSound = -Infinity; session = user; enabled = true;
    try { enabled = localStorage.getItem(preferenceKey()) !== 'off'; } catch {}
    update();
  }
  function unlockSound() {
    if (!enabled) return;
    try {
      const Audio = window.AudioContext || window.webkitAudioContext;
      if (!Audio) return;
      if (!audio || audio.state === 'closed') audio = new Audio();
      if (audio.state === 'suspended') audio.resume().catch(() => {});
    } catch { /* Some devices block audio until another user gesture. */ }
  }
  async function toggle() {
    if (!session || getUser() !== session) return;
    const owner = session;
    if (enabled && supported() && Notification.permission === 'granted') {
      enabled = false; closePopup();
    } else {
      enabled = true; unlockSound();
      if (supported() && Notification.permission === 'default') {
        try { await Notification.requestPermission(); } catch {}
      } else if (supported() && Notification.permission === 'denied') {
        // Keep sound available even when the browser denied popups.
      }
    }
    if (session !== owner || getUser() !== owner) return;
    try { localStorage.setItem(preferenceKey(), enabled ? 'on' : 'off'); } catch {}
    update();
    return { enabled, permission: supported() ? Notification.permission : 'unsupported' };
  }
  function playSound() {
    if (!audio || audio.state !== 'running' || performance.now() - lastSound < 1500) return;
    try {
      const now = audio.currentTime;
      for (const [offset, frequency] of [[0, 659.25], [.13, 880]]) {
        const oscillator = audio.createOscillator(), volume = audio.createGain();
        oscillator.type = 'sine'; oscillator.frequency.value = frequency;
        volume.gain.setValueAtTime(0, now + offset);
        volume.gain.linearRampToValueAtTime(.12, now + offset + .02);
        volume.gain.exponentialRampToValueAtTime(.001, now + offset + .22);
        oscillator.connect(volume); volume.connect(audio.destination);
        oscillator.start(now + offset); oscillator.stop(now + offset + .24);
        oscillator.onended = () => { oscillator.disconnect(); volume.disconnect(); };
      }
      lastSound = performance.now();
    } catch { /* Audio failure must not interfere with message delivery. */ }
  }
  function receive(messages, conversation) {
    if (!session || getUser() !== session || !inBackground()) return;
    const incoming = messages.filter(message => !message.system && message.user && message.user !== session.username);
    if (!incoming.length) return;
    onUnread(incoming.length);
    if (!enabled) return;
    playSound();
    if (!supported() || Notification.permission !== 'granted') return;
    const owner = session, latest = incoming.at(-1);
    const sender = String(latest.display || latest.user).slice(0, 60);
    const body = String(latest.text || (latest.sticker ? 'Enviou uma figurinha' : latest.image ? 'Enviou uma foto' : 'Nova mensagem')).slice(0, 180);
    closePopup();
    try {
      const notification = new Notification(`${sender} · ${conversation.label}`, {
        body: incoming.length > 1 ? `${incoming.length} mensagens novas. ${body}` : body,
        icon: new URL('logo.png', location.href).href, tag: 'cuppimxas-messages', silent: true
      });
      popup = notification;
      notification.onclick = () => {
        notification.close();
        if (session !== owner || getUser() !== owner) return;
        window.focus(); onOpen(conversation); onReturn();
      };
      popupTimer = setTimeout(() => { notification.close(); if (popup === notification) popup = null; }, 10000);
    } catch { /* Unsupported native popup platforms still receive sound/title alerts. */ }
  }
  function onReturn() {
    if (!document.hidden && document.hasFocus()) { closePopup(); update(); }
  }
  return { start, stop, toggle, receive, unlockSound, onReturn };
}
