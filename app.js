import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { createMessageAlerts } from './notifications.js';
    import { getDatabase, ref, push, onValue, serverTimestamp, onDisconnect, set, remove, get, update } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js';

    const firebaseConfig = {
      apiKey: "AIzaSyAAM0MjDIzkWGGBwf9jZothOYRgV5rs4AQ",
      authDomain: "chat-cupimxas.firebaseapp.com",
      databaseURL: "https://chat-cupimxas-default-rtdb.firebaseio.com",
      projectId: "chat-cupimxas",
      storageBucket: "chat-cupimxas.firebasestorage.app",
      messagingSenderId: "464237186263",
      appId: "1:464237186263:web:43c1ba11d602424c3ab492"
    };

    const app = initializeApp(firebaseConfig);
    const db = getDatabase(app);
    const ADMIN_USERS = ['manobotkk'];
    const COLORS = ['#e8ff4a', '#4affe8', '#ff4aaa', '#4a88ff', '#ff884a', '#aa4aff', '#4aff88'];

    // ── UTILS ──
    async function sha256(s) { const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)); return Array.from(new Uint8Array(b)).map(x => x.toString(16).padStart(2, '0')).join(''); }
    function getColor(n) { let h = 0; for (let c of (n || '')) h = (h * 31 + c.charCodeAt(0)) % COLORS.length; return COLORS[h]; }
    function initials(n) { return (n || '?').slice(0, 2).toUpperCase(); }
    function fmtTime(ts) { return new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); }
    function escHtml(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/\n/g, '<br>'); }
    function linkify(h) { return h.replace(/(https?:\/\/[^\s<"]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>'); }
    function mentionify(html, me) {
      return html.replace(/@(todos|all|everyone)/gi, '<span class="mention">@$1</span>')
        .replace(/@([a-z0-9_.\-]+)/gi, (m, u) => `<span class="mention${u.toLowerCase() === me ? ' me' : ''}">${m}</span>`);
    }
    function renderAvatar(el, user) {
      el.replaceChildren();
      if (user && safeImage(user.avatar)) { const img = new Image(); img.src = user.avatar; img.alt = ''; el.append(img); el.style.background = el.style.color = ''; }
      else { const c = getColor((user && (user.username || user.display)) || '?'); el.textContent = initials((user && (user.display || user.username)) || '?'); el.style.background = c + '22'; el.style.color = c; }
    }
    function $(id) { return document.getElementById(id); }
    function showScreen(id) { document.querySelectorAll('.screen').forEach(s => s.classList.remove('active')); $(id).classList.add('active'); }
    const modalFocus = new Map();
    function openModal(id) {
      modalFocus.set(id, document.activeElement); $(id).style.display = 'flex';
      const target = $(id).querySelector('input:not([disabled]), button');
      target?.focus({ preventScroll: true });
    }
    function closeModal(id) {
      $(id).style.display = 'none';
      modalFocus.get(id)?.focus({ preventScroll: true }); modalFocus.delete(id);
    }
    function closeOnBackdrop(modalId) { $(modalId).addEventListener('click', e => { if (e.target.id === modalId) closeModal(modalId); }); }

    // ── STATE ──
    let currentUser = null, presenceRef = null, isLoginMode = true;
    let allUsers = {}, allPresence = {}, currentChannel = 'geral', isDM = false;
    let msgListener = null, pendingAvatar = null, pendingImage = null, mentionPopupIdx = -1;
    let sessionListeners = [], friendsListener = null, recoverListener = null;
    let replyTo = null, sending = false, imageVersion = 0;
    let followBottom = true, newMessageCount = 0, scrollFrame = 0;
    let recoverRequests = {}, connected = false, toastTimer;
    let stickerLibrary = [], stickerLibraryReady = false, stickerLibraryError = '', stickerSaving = false;
    let stickerLibraryListener = null, stickerLibraryTimer = null, unsavedSticker = null;
    const MAX_STICKERS = 24, MAX_GIF_BYTES = 2 * 1024 * 1024;
    const drafts = new Map();
    const alertConversations = new Map();
    const messageAlerts = createMessageAlerts({
      getUser: () => currentUser,
      onUnread: count => setUnread(unreadCount + count),
      onOpen: conversation => {
        if (conversation.dm) openDM(conversation.dm); else switchChannel(conversation.id);
        $('sidebar').classList.remove('open'); scrollToLatest();
      },
      onStatus: ({ enabled, permission }) => {
        const button = $('notification-btn');
        button.setAttribute('aria-pressed', String(enabled));
        button.classList.toggle('notifications-muted', !enabled);
        button.title = !enabled ? 'Ativar notificações' : permission === 'granted' ? 'Desativar notificações' : 'Ativar popups de mensagens';
        button.setAttribute('aria-label', button.title);
      }
    });
    const validUsername = value => /^[a-z0-9_-]{2,20}$/.test(value);
    const safeImage = value => typeof value === 'string' && /^(data:image\/(png|jpeg|webp|gif);base64,|https:\/\/)/i.test(value);

    function notify(message) {
      $('toast').textContent = message; $('toast').hidden = false;
      clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 4500);
    }
    function reportError(error, message = 'Não foi possível concluir. Tente novamente.') {
      console.error(message, error); notify(message);
    }
    function cleanupSession() {
      messageAlerts.stop();
      alertConversations.forEach(entry => entry.unsubscribe()); alertConversations.clear();
      sessionListeners.splice(0).forEach(unsubscribe => unsubscribe());
      if (friendsListener) friendsListener(); friendsListener = null;
      if (recoverListener) recoverListener(); recoverListener = null;
      if (msgListener) msgListener(); msgListener = null;
      if (stickerLibraryListener) stickerLibraryListener(); stickerLibraryListener = null;
      clearTimeout(stickerLibraryTimer); unsavedSticker = null;
      imageVersion++; drafts.clear(); clearReply(); clearPasteImage();
      $('msg-input').value = ''; toggleStickers(false); clearUnread();
      allUsers = {}; allPresence = {}; recoverRequests = {};
      stickerLibrary = []; stickerLibraryReady = false; stickerLibraryError = ''; stickerSaving = false;
      document.querySelectorAll('.modal-backdrop').forEach(el => el.style.display = 'none');
      $('sidebar').classList.remove('open');
    }

    // u2500u2500 UNREAD / TITLE NOTIFICATION u2500u2500
    let unreadCount = 0;
    const BASE_TITLE = document.title;
    function setUnread(n) { unreadCount = n; document.title = n > 0 ? `(${n}) ${BASE_TITLE}` : BASE_TITLE; }
    function clearUnread() { setUnread(0); }
    function handleReturnToChat() {
      if (!document.hidden && document.hasFocus()) { clearUnread(); messageAlerts.onReturn(); }
    }
    document.addEventListener('visibilitychange', handleReturnToChat);
    window.addEventListener('focus', handleReturnToChat);

    function watchConversationAlerts(id, dm = null) {
      if (!currentUser || alertConversations.has(id)) return;
      const session = currentUser;
      let initialized = false;
      const seen = new Set();
      const conversation = { id, dm, label: dm ? 'Mensagem direta' : '#' + id };
      const unsubscribe = onValue(ref(db, `messages/${id}`), snap => {
        if (currentUser !== session) return;
        const incoming = [];
        for (const [key, message] of Object.entries(snap.val() || {})) {
          if (!message || typeof message !== 'object') continue;
          if (initialized && !seen.has(key)) incoming.push(message);
          seen.add(key);
        }
        if (initialized) messageAlerts.receive(incoming.sort((a, b) => (a.ts || 0) - (b.ts || 0)), conversation);
        initialized = true;
      }, error => console.warn('Não foi possível acompanhar notificações desta conversa.', error.code));
      alertConversations.set(id, { unsubscribe });
    }

    // ── BIND ALL EVENTS (no inline onclick needed) ──
    function bindEvents() {
      setupChatFeatures();
      // auth
      $('auth-btn').onclick = submitAuth;
      $('auth-toggle-link-btn').onclick = toggleAuthMode;
      $('recover-link').onclick = () => openModal('recover-modal');
      $('auth-user').onkeydown = $('auth-pass').onkeydown = e => { if (e.key === 'Enter' && !e.isComposing) submitAuth(); };
      // modals close buttons
      $('close-profile-modal').onclick = () => closeModal('profile-modal');
      $('close-view-modal').onclick = () => closeModal('view-modal');
      $('close-friends-modal').onclick = () => closeModal('friends-modal');
      $('close-group-modal').onclick = () => closeModal('group-modal');
      $('close-admin-modal').onclick = () => closeModal('admin-modal');
      $('close-recover-modal').onclick = () => closeModal('recover-modal');
      ['profile-modal', 'view-modal', 'friends-modal', 'group-modal', 'admin-modal', 'recover-modal'].forEach(closeOnBackdrop);
      // profile modal
      $('save-profile-btn').onclick = saveProfile;
      $('logout-btn').onclick = doLogout;
      $('delete-account-btn').onclick = deleteAccount;
      $('avatar-upload-btn').onclick = () => $('avatar-file').click();
      $('avatar-file').onchange = handleAvatarUpload;
      $('sidebar-avatar').onclick = openProfile;
      // chat buttons
      $('send-btn').onclick = sendMessage;
      $('img-btn').onclick = () => $('img-upload').click();
      $('img-upload').onchange = handleImageUpload;
      $('clear-paste-btn').onclick = clearPasteImage;
      $('lightbox').onclick = () => $('lightbox').style.display = 'none';
      $('mob-toggle').onclick = () => $('sidebar').classList.toggle('open');
      // sidebar
      $('ch-geral').onclick = () => { switchChannel('geral'); $('sidebar').classList.remove('open'); };
      $('friend-req-btn').onclick = openFriends;
      $('new-group-btn').onclick = () => { $('group-name-inp').value = ''; $('group-err').textContent = ''; openModal('group-modal'); };
      $('admin-btn').onclick = openAdmin;
      // friends modal tabs
      $('tab-btn-friends').onclick = () => switchTab('tab-friends', 'tab-btn-friends');
      $('tab-btn-requests').onclick = () => switchTab('tab-requests', 'tab-btn-requests');
      $('tab-btn-add').onclick = () => switchTab('tab-add', 'tab-btn-add');
      $('send-friend-req-btn').onclick = sendFriendRequest;
      // group modal
      $('create-group-btn').onclick = createGroup;
      $('group-name-inp').onkeydown = e => { if (e.key === 'Enter' && !e.isComposing) createGroup(); };
      // recover modal
      $('submit-recover-btn').onclick = submitRecover;
      // msg input
      const inp = $('msg-input');
      inp.onkeydown = e => {
        const popup = $('mention-popup');
        if (popup.style.display === 'block') {
          const items = popup.querySelectorAll('.mention-item');
          if (e.key === 'ArrowDown') { e.preventDefault(); mentionPopupIdx = Math.min(mentionPopupIdx + 1, items.length - 1); items.forEach((i, n) => i.classList.toggle('selected', n === mentionPopupIdx)); return; }
          if (e.key === 'ArrowUp') { e.preventDefault(); mentionPopupIdx = Math.max(mentionPopupIdx - 1, 0); items.forEach((i, n) => i.classList.toggle('selected', n === mentionPopupIdx)); return; }
          if ((e.key === 'Enter' || e.key === 'Tab') && mentionPopupIdx >= 0) { e.preventDefault(); items[mentionPopupIdx]?.click(); return; }
          if (e.key === 'Escape') { closeMentionPopup(); return; }
        }
        if (e.key === 'Enter' && !e.isComposing && !e.shiftKey) { e.preventDefault(); sendMessage(); }
      };
      inp.oninput = () => { inp.style.height = 'auto'; inp.style.height = Math.min(inp.scrollHeight, 120) + 'px'; handleMentionInput(inp); };
      inp.onpaste = handlePaste;
      inp.onblur = () => setTimeout(closeMentionPopup, 200);
    }

    // ── AUTH ──
    function toggleAuthMode() {
      isLoginMode = !isLoginMode;
      $('register-fields').style.display = isLoginMode ? 'none' : '';
      $('auth-sub').textContent = isLoginMode ? 'A conversa fica melhor com você por aqui.' : 'Crie sua conta e encontre sua turma.';
      $('auth-btn').textContent = isLoginMode ? 'Entrar' : 'Criar conta';
      $('auth-toggle-text').textContent = isLoginMode ? 'Não tem conta?' : 'Já tem conta?';
      $('auth-toggle-link').textContent = isLoginMode ? 'Cadastrar' : 'Entrar';
      $('auth-err').textContent = '';
    }

    async function submitAuth() {
      messageAlerts.unlockSound();
      if ($('auth-btn').disabled) return;
      $('auth-btn').disabled = true;
      try {
      const username = $('auth-user').value.trim().toLowerCase();
      const pass = $('auth-pass').value;
      const display = $('reg-display').value.trim();
      const email = $('reg-email')?.value.trim() || '';
      const err = $('auth-err'); err.textContent = '';

      if (!username) { err.textContent = 'Digite um @ usuário.'; return; }
      if (!validUsername(username)) { err.textContent = 'Use de 2 a 20 letras, números, _ ou - (sem ponto).'; return; }
      if (username.length < 2) { err.textContent = 'Mínimo 2 caracteres.'; return; }
      if (!pass || pass.length < 4) { err.textContent = 'Senha mínima: 4 caracteres.'; return; }
      if (!isLoginMode && (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) { err.textContent = 'Digite um e-mail válido.'; return; }
      if (!isLoginMode && !display) { err.textContent = 'Digite seu nome de exibição.'; return; }

      const passHash = await sha256(pass);
      const snap = await get(ref(db, `users/${username}`));

      if (isLoginMode) {
        if (!snap.exists()) { err.textContent = 'Usuário não encontrado.'; return; }
        const d = snap.val();
        if (d.passHash !== passHash) { err.textContent = 'Senha incorreta.'; return; }
        if (d.banned) { err.textContent = 'Sua conta foi banida.'; return; }

        currentUser = {
          username,
          display: d.display,
          avatar: d.avatar || null,
          isAdmin: ADMIN_USERS.includes(username) || !!d.isAdmin,
          isMod: !!d.isMod
        };
      } else {
        if (snap.exists()) { err.textContent = 'Esse @ já está em uso.'; return; }
        await set(ref(db, `users/${username}`), { username, display, passHash, email: email || '', avatar: null, banned: false, isMod: false, isAdmin: false, createdAt: Date.now() });

        currentUser = {
          username,
          display,
          avatar: null,
          isAdmin: ADMIN_USERS.includes(username),
          isMod: false
        };
      }

      sessionStorage.setItem('chat_session', JSON.stringify({ username, passHash }));
      startChat();
      } catch (error) { $('auth-err').textContent = 'Não foi possível conectar. Verifique sua conexão e tente novamente.'; console.error(error); }
      finally { $('auth-btn').disabled = false; }
    }

    // Restore session
    (async () => {
      const saved = sessionStorage.getItem('chat_session');
      if (!saved) return;
      try {
        const { username, passHash } = JSON.parse(saved);
        if (!validUsername(username)) throw new Error('Sessão inválida');
        const snap = await get(ref(db, `users/${username}`));
        if (snap.exists() && snap.val().passHash === passHash && !snap.val().banned) {
          const d = snap.val();

          // CORREÇÃO: Usar ADMIN_USERS.includes(username)
          currentUser = {
            username,
            display: d.display,
            avatar: d.avatar || null,
            isAdmin: ADMIN_USERS.includes(username) || !!d.isAdmin,
            isMod: !!d.isMod
          };

          startChat(); return;
        }
      } catch (e) { }
      sessionStorage.removeItem('chat_session');
    })();

    // ── START CHAT ──
    function startChat() {
  messageAlerts.start(currentUser); watchConversationAlerts('geral');
  showScreen('chat-screen');
  updateSidebarUser();
  const username = currentUser.username;
  presenceRef = ref(db, `presence/${username}`);
  sessionListeners.push(onValue(ref(db, '.info/connected'), async snap => {
    connected = snap.val() === true;
    updateStickerControls();
    $('conversation-note').textContent = connected ? (isDM ? 'Uma conversa só de vocês' : 'O ponto de encontro da turma') : 'Reconectando… suas mensagens continuam aqui';
    if (!connected) return;
    try {
      const disconnect = onDisconnect(presenceRef);
      await disconnect.remove();
      if (currentUser?.username !== username) { await disconnect.cancel(); return; }
      await set(presenceRef, { display: currentUser.display, avatar: currentUser.avatar || null, ts: serverTimestamp() });
    } catch (error) { reportError(error, 'Não foi possível atualizar sua presença.'); }
  }));
  sessionListeners.push(onValue(ref(db, 'presence'), snap => {
    if (currentUser?.username !== username) return;
    allPresence = snap.val() || {};
    $('online-count').textContent = Object.keys(allPresence).length + ' online';
    renderOnlineList();
  }));
  sessionListeners.push(onValue(ref(db, 'users'), snap => {
    if (currentUser?.username !== username) return;
    allUsers = Object.fromEntries(Object.entries(snap.val() || {}).map(([key, value]) => [key, { ...value, username: key }]));
    const me = allUsers[username];
    if (!me || me.banned) { doLogout(); notify(me?.banned ? 'Sua conta foi banida.' : 'Esta conta foi excluída.'); return; }
    currentUser.isAdmin = ADMIN_USERS.includes(username) || !!me.isAdmin;
    currentUser.isMod = !!me.isMod;
    currentUser.display = me.display || username; currentUser.avatar = me.avatar || null;
    $('admin-badge').style.display = currentUser.isAdmin ? '' : 'none';
    $('admin-btn').style.display = currentUser.isAdmin ? '' : 'none';
    $('mod-badge').style.display = currentUser.isMod && !currentUser.isAdmin ? '' : 'none';
    if (!currentUser.isAdmin) {
      closeModal('admin-modal');
      if (recoverListener) recoverListener(); recoverListener = null; recoverRequests = {};
    } else if ($('admin-modal').style.display === 'flex') renderAdminList();
    updateSidebarUser(); renderOnlineList();
  }, error => reportError(error, 'Não foi possível carregar os usuários.')));
  sessionListeners.push(onValue(ref(db, 'groups'), snap => {
    if (!currentUser) return;
    const groups = snap.val() || {}; renderGroupList(groups);
    Object.keys(groups).forEach(id => watchConversationAlerts(id));
    for (const [id, entry] of alertConversations) {
      if (id !== 'geral' && !id.includes('__') && !groups[id]) { entry.unsubscribe(); alertConversations.delete(id); }
    }
  }));
  sessionListeners.push(onValue(ref(db, 'friend_requests'), snap => {
    if (currentUser?.username !== username) return;
    const pending = Object.values(snap.val() || {}).filter(r => r.to === username && r.status === 'pending').length;
    $('friend-req-btn').classList.toggle('notif-dot', pending > 0);
    $('req-count').textContent = pending ? `(${pending})` : '';
  }));
  startStickerLibrary(); renderDMList(); switchChannel('geral');
}

    function updateSidebarUser() {
      renderAvatar($('sidebar-avatar'), currentUser);
      $('sidebar-display').textContent = currentUser.display;
      $('sidebar-handle').textContent = '@' + currentUser.username;
    }

    // ── ONLINE LIST ──
    function renderOnlineList() {
      const list = $('online-user-list'); list.innerHTML = '';
      Object.entries(allPresence).forEach(([uname, p]) => {
        const user = allUsers[uname] || { username: uname, display: p.display || uname, avatar: p.avatar || null };
        const item = document.createElement('div'); item.className = 'online-user-item';
        const av = document.createElement('div'); av.className = 'ou-av';
        renderAvatar(av, { ...user, avatar: p.avatar || user.avatar });
        const name = document.createElement('span'); name.textContent = user.display || uname; name.style.cssText = 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1';
        const dot = document.createElement('div'); dot.className = 'ou-dot';
        item.appendChild(av); item.appendChild(name); item.appendChild(dot);
        item.onclick = () => { viewProfile(uname); $('sidebar').classList.remove('open'); };
        list.appendChild(item);
      });
    }

    // ── GROUPS ──
    function renderGroupList(groups) {
      const list = $('group-list'); list.innerHTML = '';
      Object.entries(groups).forEach(([key, g]) => {
        const item = document.createElement('div');
        item.className = 'channel-item' + (currentChannel === key && !isDM ? ' active' : '');
        item.dataset.channel = key;
        item.onclick = () => { switchChannel(key); $('sidebar').classList.remove('open'); };
        item.innerHTML = `<span class="channel-hash">#</span><span class="channel-name">${escHtml(g.name)}</span>`;
        list.appendChild(item);
      });
    }

    async function createGroup() {
      const name = $('group-name-inp').value.trim().toLowerCase().replace(/\s+/g, '-');
      const err = $('group-err'); err.textContent = '';
      if (!name || name.length < 2) { err.textContent = 'Nome muito curto.'; return; }
      if (!/^[a-z0-9\-_]+$/.test(name)) { err.textContent = 'Use letras, números, - e _'; return; }
      if (name === 'geral') { err.textContent = 'Esse nome é reservado.'; return; }
      const snap = await get(ref(db, `groups/${name}`));
      if (snap.exists()) { err.textContent = 'Grupo já existe.'; return; }
      await set(ref(db, `groups/${name}`), { name, createdBy: currentUser.username, createdAt: Date.now() });
      closeModal('group-modal'); switchChannel(name);
    }

    // ── DM ──
    function dmKey(a, b) { return [a, b].sort().join('__'); }

    function renderDMList() {
      if (friendsListener) friendsListener();
      const owner = currentUser?.username; if (!owner) return;
      const list = $('dm-list'); list.innerHTML = '';
      // Listen to friends and render DM entries
      friendsListener = onValue(ref(db, `friends/${owner}`), snap => {
        if (currentUser?.username !== owner) return;
        list.innerHTML = '';
        if (!snap.exists()) return;
        Object.keys(snap.val()).forEach(uname => {
          const user = allUsers[uname] || { username: uname, display: uname };
          const key = dmKey(currentUser.username, uname);
          watchConversationAlerts(key, uname);
          const item = document.createElement('div');
          item.className = 'channel-item' + (currentChannel === key && isDM ? ' active' : '');
          item.dataset.dm = uname;
          const av = document.createElement('div'); av.className = 'dm-avatar';
          renderAvatar(av, user);
          const isOnline = !!allPresence[uname];
          const nameEl = document.createElement('span'); nameEl.className = 'channel-name'; nameEl.textContent = user.display || uname;
          const dot = document.createElement('div'); dot.style.cssText = `width:6px;height:6px;border-radius:50%;background:${isOnline ? 'var(--success)' : 'var(--border)'};flex-shrink:0`;
          item.appendChild(av); item.appendChild(nameEl); item.appendChild(dot);
          item.onclick = () => { openDM(uname); $('sidebar').classList.remove('open'); };
          list.appendChild(item);
        });
      });
    }

    function openDM(targetUsername) {
      if (!currentUser || !validUsername(targetUsername)) return;
      stashDraft();
      isDM = true;
      currentChannel = dmKey(currentUser.username, targetUsername);
      watchConversationAlerts(currentChannel, targetUsername);
      restoreDraft(currentChannel);
      $('conversation-note').textContent = 'Uma conversa só de vocês';
      const user = allUsers[targetUsername] || { username: targetUsername, display: targetUsername };
      $('chat-channel-name').textContent = user.display || targetUsername;
      $('chat-channel-hash').textContent = '@';
      document.querySelectorAll('.channel-item').forEach(i => i.classList.remove('active'));
      document.querySelectorAll(`[data-dm="${targetUsername}"]`).forEach(i => i.classList.add('active'));
      loadMessages(currentChannel);
    }

    // ── CHANNEL ──
    function switchChannel(channelId) {
      stashDraft();
      isDM = false;
      currentChannel = channelId;
      restoreDraft(channelId);
      $('conversation-note').textContent = 'O ponto de encontro da turma';
      clearUnread();
      $('chat-channel-name').textContent = channelId;
      $('chat-channel-hash').textContent = '#';
      document.querySelectorAll('.channel-item').forEach(i => i.classList.remove('active'));
      document.querySelectorAll(`[data-channel="${channelId}"]`).forEach(i => i.classList.add('active'));
      if (channelId === 'geral') $('ch-geral').classList.add('active');
      loadMessages(channelId);
    }

    function nearBottom() {
  const el = $('messages'); return el.scrollHeight - el.scrollTop - el.clientHeight < 70;
}
function updateScrollButton() {
  $('scroll-bottom').hidden = nearBottom();
  $('new-message-count').hidden = !newMessageCount;
  $('new-message-count').textContent = newMessageCount > 99 ? '99+' : newMessageCount;
}
function scrollToLatest() {
  followBottom = true; newMessageCount = 0;
  cancelAnimationFrame(scrollFrame);
  scrollFrame = requestAnimationFrame(() => {
    $('messages').scrollTop = $('messages').scrollHeight;
    updateScrollButton();
  });
}
function loadMessages(channelId) {
  if (msgListener) msgListener();
  $('message-list').replaceChildren();
  clearUnread(); followBottom = true; newMessageCount = 0; updateScrollButton();
  let initialized = false, knownKeys = new Set();
  const nodes = new Map();
  msgListener = onValue(ref(db, `messages/${channelId}`), snap => {
    if (!currentUser || currentChannel !== channelId) return;
    const container = $('messages'), list = $('message-list');
    const stick = !initialized || followBottom;
    const oldTop = container.scrollTop;
    const anchor = Array.from(list.querySelectorAll('.msg')).find(el => el.offsetTop + el.offsetHeight > oldTop);
    const anchorOffset = anchor ? anchor.offsetTop - oldTop : 0;
    const all = Object.entries(snap.val() || {}).filter(([, value]) => value && typeof value === 'object')
      .map(([key, value]) => ({ ...value, _key: key })).sort((a, b) => (a.ts || 0) - (b.ts || 0) || a._key.localeCompare(b._key));
    const newMessages = initialized ? all.filter(m => !knownKeys.has(m._key) && m.user !== currentUser.username && !m.system) : [];
    const keys = new Set(all.map(m => m._key));
    for (const [key, entry] of nodes) if (!keys.has(key)) { entry.node.remove(); nodes.delete(key); }
    list.querySelectorAll('.day-divider, .empty-conversation').forEach(el => el.remove());
    let lastDay = '', cursor = list.firstChild, previousMessage = null;
    for (const m of all) {
      if (!m.system) {
        const day = new Date(m.ts || Date.now()).toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });
        if (day !== lastDay) {
          const divider = document.createElement('div'); divider.className = 'day-divider'; divider.textContent = day;
          list.insertBefore(divider, cursor); lastDay = day;
        }
      }
      const signature = JSON.stringify([m, currentUser.isAdmin, currentUser.isMod]);
      let entry = nodes.get(m._key);
      if (!entry || entry.signature !== signature) {
        const node = createMessage(m, channelId);
        if (entry) { if (cursor === entry.node) cursor = node; entry.node.replaceWith(node); }
        entry = { node, signature }; nodes.set(m._key, entry);
      }
      // Recompute adjacency on every update, including edits/deletions, without replacing message nodes.
      const continuation = !m.system && !!m.user && previousMessage && !previousMessage.system
        && previousMessage.user === m.user
        && new Date(previousMessage.ts || Date.now()).toDateString() === new Date(m.ts || Date.now()).toDateString();
      entry.node.classList.toggle('continuation', !!continuation);
      previousMessage = m;
      if (entry.node !== cursor) list.insertBefore(entry.node, cursor);
      cursor = entry.node.nextSibling;
    }
    if (!all.length) list.innerHTML = '<div class="empty-conversation"><span class="empty-icon">✳</span><strong>Toda conversa começa com um oi.</strong>Envie a primeira mensagem por aqui.</div>';
    if (stick) scrollToLatest();
    else {
      container.scrollTop = anchor?.isConnected ? anchor.offsetTop - anchorOffset : oldTop;
      newMessageCount += newMessages.length; updateScrollButton();
    }
    knownKeys = keys; initialized = true;
  }, error => {
    reportError(error, 'Não foi possível carregar esta conversa.');
    $('message-list').innerHTML = '<div class="empty-conversation">Falha ao carregar. Abra a conversa novamente para tentar.</div>';
  });
}
function renderMessageText(text) {
  const fragment = document.createDocumentFragment();
  // Build links as DOM nodes so mentions and quotes cannot corrupt attributes.
  for (const part of String(text || '').split(/(https?:\/\/[^\s<>]+)/g)) {
    if (/^https?:\/\//.test(part)) {
      const link = document.createElement('a'); link.href = part; link.textContent = part;
      link.target = '_blank'; link.rel = 'noopener noreferrer'; fragment.append(link);
    } else {
      const span = document.createElement('span'); span.style.whiteSpace = 'pre-wrap';
      span.innerHTML = mentionify(escHtml(part), currentUser.username); fragment.append(span);
    }
  }
  return fragment;
}
function messageSummary(m) { return String(m.text || (m.sticker ? 'Figurinha' : m.image ? 'Foto' : 'Mensagem')).slice(0, 180); }
function selectReply(m) {
  replyTo = { key: m._key, user: m.user || '', display: allUsers[m.user]?.display || m.display || m.user || 'Usuário', text: messageSummary(m) };
  renderReply(); $('msg-input').focus({ preventScroll: true });
}
function renderReply() {
  $('reply-preview').hidden = !replyTo;
  if (!replyTo) return;
  $('reply-author').textContent = 'Respondendo a ' + replyTo.display;
  $('reply-text').textContent = replyTo.text;
}
function clearReply() { replyTo = null; renderReply(); }
function createMessage(m, channelId) {
  const wrap = document.createElement('div'); wrap.dataset.key = m._key;
  if (m.system) { wrap.className = 'system-msg'; wrap.textContent = m.text || ''; return wrap; }
  const own = m.user === currentUser.username;
  wrap.className = 'msg' + (own ? ' own' : '') + (m.sticker ? ' sticker-message' : '');
  const sender = allUsers[m.user] || { username: m.user, display: m.display || m.user };
  const avatar = document.createElement('div'); avatar.className = 'msg-avatar'; renderAvatar(avatar, sender);
  avatar.onclick = () => viewProfile(m.user);
  const body = document.createElement('div'); body.className = 'msg-body';
  const meta = document.createElement('div'); meta.className = 'msg-meta';
  if (!own) { const name = document.createElement('span'); name.className = 'msg-display'; name.style.color = getColor(m.user); name.textContent = sender.display || m.user; meta.append(name); }
  const time = document.createElement('span'); time.textContent = fmtTime(m.ts || Date.now()); meta.append(time);
  const bubble = document.createElement('div'); bubble.className = 'msg-bubble';
  if (m.replyTo && typeof m.replyTo === 'object') {
    const quote = document.createElement('button'); quote.className = 'reply-quote';
    const author = document.createElement('strong'); author.textContent = m.replyTo.display || m.replyTo.user || 'Mensagem';
    const text = document.createElement('span'); text.textContent = m.replyTo.text || 'Mensagem'; quote.append(author, text);
    quote.onclick = () => {
      const original = Array.from($('message-list').querySelectorAll('.msg')).find(el => el.dataset.key === m.replyTo.key);
      if (!original) { notify('A mensagem original foi removida.'); return; }
      followBottom = false; original.scrollIntoView({ block: 'center', behavior: 'instant' });
      original.classList.add('highlight'); setTimeout(() => original.classList.remove('highlight'), 1800);
    };
    bubble.append(quote);
  }
  const stickerSrc = m.sticker?.image || builtinStickers.find(s => s.id === m.sticker?.id)?.image;
  const source = m.sticker ? stickerSrc : m.image;
  let openImageTimer, suppressImageUntil = 0;
  if (safeImage(source)) {
    const img = new Image(); img.className = m.sticker ? 'message-sticker' : 'msg-img'; img.alt = m.sticker ? (m.sticker.name || 'Figurinha') : 'Foto enviada';
    img.onload = () => { if (followBottom && currentChannel === channelId) scrollToLatest(); };
    img.onerror = () => { img.alt = 'Imagem indisponível'; if (followBottom) scrollToLatest(); };
    img.src = source;
    if (!m.sticker) {
      // Wait for the second click before opening, allowing double-click to reply to photos.
      img.onclick = event => { if (event.detail > 1 || performance.now() < suppressImageUntil) { clearTimeout(openImageTimer); return; } openImageTimer = setTimeout(() => { if (!wrap.isConnected) return; $('lightbox-img').src = source; $('lightbox').style.display = 'flex'; }, 400); };
      img.ondblclick = () => clearTimeout(openImageTimer);
    }
    bubble.append(img);
  }
  if (m.text) { const text = document.createElement('div'); text.append(renderMessageText(m.text)); bubble.append(text); }
  wrap.ondblclick = event => { if (!event.target.closest('button, a, .msg-avatar')) { event.preventDefault(); selectReply(m); } };
  let previousTap = 0, tapX = 0, tapY = 0;
  wrap.addEventListener('pointerup', event => {
    if (event.pointerType !== 'touch' || event.target.closest('button, a, .msg-avatar')) return;
    wrap.classList.add('actions-open');
    const now = performance.now();
    if (previousTap && now - previousTap < 350 && Math.hypot(event.clientX - tapX, event.clientY - tapY) < 25) {
      event.preventDefault(); clearTimeout(openImageTimer); suppressImageUntil = now + 500; selectReply(m); previousTap = 0;
    } else { previousTap = now; tapX = event.clientX; tapY = event.clientY; }
  });
  const actions = document.createElement('div'); actions.className = 'msg-actions';
  const reply = document.createElement('button'); reply.className = 'msg-action-btn'; reply.textContent = '↩'; reply.title = 'Responder'; reply.setAttribute('aria-label', 'Responder à mensagem'); reply.onclick = () => selectReply(m); actions.append(reply);
  if (own || currentUser.isAdmin || currentUser.isMod) {
    const del = document.createElement('button'); del.className = 'msg-action-btn'; del.textContent = '×'; del.title = 'Apagar mensagem'; del.setAttribute('aria-label', 'Apagar mensagem');
    del.onclick = async () => {
      if (!currentUser || !(m.user === currentUser.username || currentUser.isAdmin || currentUser.isMod)) return;
      if (!confirm('Apagar esta mensagem?')) return;
      try { await remove(ref(db, `messages/${channelId}/${m._key}`)); } catch (error) { reportError(error, 'Não foi possível apagar a mensagem.'); }
    }; actions.append(del);
  }
  // Keep the actions in normal flow, beside this message's bubble.
  const content = document.createElement('div'); content.className = 'msg-content';
  content.append(bubble, actions); body.append(meta, content); wrap.append(avatar, body); return wrap;
}
async function sendMessage() {
  if (sending || !currentUser) return;
  const input = $('msg-input'), text = input.value.trim();
  if (!text && !pendingImage) return;
  if (!connected) { notify('Aguardando conexão. Sua mensagem está preservada.'); return; }
  const channel = currentChannel, user = currentUser;
  const rawText = input.value, photo = pendingImage, reply = replyTo;
  const payload = { user: user.username, display: user.display, ts: serverTimestamp() };
  if (text) payload.text = text;
  if (photo) payload.image = photo;
  if (reply) payload.replyTo = reply;
  sending = true; $('send-btn').disabled = true;
  closeMentionPopup(); toggleStickers(false);
  try {
    const snap = await get(ref(db, `users/${user.username}`));
    if (!snap.exists() || snap.val().banned) throw new Error('Conta indisponível');
    if (currentUser !== user) return;
    await push(ref(db, `messages/${channel}`), payload);
    if (currentUser !== user) return;
    if (currentChannel === channel) {
      if (input.value === rawText) { input.value = ''; input.style.height = 'auto'; }
      if (pendingImage === photo) clearPasteImage();
      if (replyTo === reply) clearReply();
      scrollToLatest(); input.focus({ preventScroll: true });
    } else {
      const draft = drafts.get(channel);
      if (draft) {
        if (draft.text === rawText) draft.text = '';
        if (draft.image === photo) draft.image = null;
        if (draft.reply === reply) draft.reply = null;
      }
    }
  } catch (error) { reportError(error, 'A mensagem não foi enviada. Seu texto e anexo foram preservados.'); }
  finally { sending = false; $('send-btn').disabled = false; }
}

async function sendSticker(sticker, custom = true) {
  if (sending || !currentUser) return;
  if (!connected) { notify('Conecte-se para enviar a figurinha.'); return; }
  const session = currentUser, channel = currentChannel, reply = replyTo;
  const payload = {
    user: session.username, display: session.display, ts: serverTimestamp(),
    sticker: custom ? { id: sticker.id, name: sticker.name, image: sticker.image } : { id: sticker.id, name: sticker.name }
  };
  if (reply) payload.replyTo = reply;
  sending = true; $('send-btn').disabled = true;
  closeMentionPopup(); toggleStickers(false);
  try {
    const snap = await get(ref(db, `users/${session.username}`));
    if (!snap.exists() || snap.val().banned) throw new Error('Conta indisponível');
    if (currentUser !== session) return;
    await push(ref(db, `messages/${channel}`), payload);
    if (currentUser !== session) return;
    if (currentChannel === channel) {
      if (replyTo === reply) clearReply();
      scrollToLatest();
    } else {
      const draft = drafts.get(channel);
      if (draft?.reply === reply) draft.reply = null;
    }
  } catch (error) {
    if (currentUser === session) {
      if (currentChannel === channel) toggleStickers(true);
      reportError(error, 'A figurinha não foi enviada. Clique nela para tentar novamente.');
    }
  } finally { sending = false; $('send-btn').disabled = false; }
}

    // ── MENTION AUTOCOMPLETE ──
    function handleMentionInput(inp) {
      const val = inp.value, pos = inp.selectionStart;
      const match = val.slice(0, pos).match(/@([a-z0-9_.\-]*)$/i);
      if (!match) { closeMentionPopup(); return; }
      const query = match[1].toLowerCase();
      const popup = $('mention-popup');
      const specials = [];
      if (['todos', 'all', 'everyone'].some(s => s.startsWith(query))) {
        specials.push({ username: 'todos', display: 'Mencionar todos', special: true });
      }
      const users = Object.values(allUsers).filter(u => u.username !== currentUser.username && (u.username.includes(query) || (u.display || '').toLowerCase().includes(query))).slice(0, 6);
      const all = [...specials, ...users];
      if (!all.length) { closeMentionPopup(); return; }
      popup.innerHTML = ''; mentionPopupIdx = -1;
      all.forEach(u => {
        const item = document.createElement('div'); item.className = 'mention-item';
        const av = document.createElement('div'); av.className = 'mention-item-av';
        if (u.special) {
          av.innerHTML = '@';
          av.style.cssText = 'width:22px;height:22px;border-radius:5px;display:flex;align-items:center;justify-content:center;font-size:.8rem;font-weight:600;background:var(--accent-dim);color:var(--accent);flex-shrink:0';
        } else {
          renderAvatar(av, u);
        }
        const name = document.createElement('div');
        name.innerHTML = `<div style="font-size:.8rem;font-weight:500">${escHtml(u.display)}</div>${!u.special ? `<div style="font-size:.68rem;color:var(--text-muted);font-family:var(--font-mono)">@${u.username}</div>` : ''}`;
        item.appendChild(av); item.appendChild(name);
        item.onclick = () => {
          const newVal = val.slice(0, pos - match[0].length) + '@' + u.username + ' ' + val.slice(pos);
          inp.value = newVal;
          const np = pos - match[0].length + u.username.length + 2;
          inp.setSelectionRange(np, np); closeMentionPopup(); inp.focus();
        };
        popup.appendChild(item);
      });
      popup.style.display = 'block';
    }
    function closeMentionPopup() { const p = $('mention-popup'); if (p) { p.style.display = 'none'; p.innerHTML = ''; mentionPopupIdx = -1; } }

    // ── IMAGE ──
    async function compressImage(file, sticker = false) {
  if (!file || !/^image\/(png|jpeg|webp|gif)$/.test(file.type)) throw new Error('Escolha uma imagem PNG, JPG, WebP ou GIF.');
  if (file.size > 10 * 1024 * 1024) throw new Error('A imagem deve ter até 10 MB.');
  const url = URL.createObjectURL(file);
  try {
    const img = new Image(); img.src = url; await img.decode();
    if (img.width * img.height > 40000000) throw new Error('Esta imagem é muito grande. Escolha uma menor.');
    // Do not draw GIFs onto a canvas: that would discard every frame after the first.
    if (file.type === 'image/gif') {
      if (file.size > MAX_GIF_BYTES) throw new Error('Escolha um GIF de até 2 MB para manter a animação.');
      return await new Promise((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Não foi possível ler o GIF.')); reader.readAsDataURL(file);
      });
    }
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 1200 / Math.max(img.width, img.height));
    canvas.width = sticker ? 384 : Math.max(1, Math.round(img.width * scale)); canvas.height = sticker ? 384 : Math.max(1, Math.round(img.height * scale));
    const ctx = canvas.getContext('2d');
    if (!sticker) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); }
    if (sticker) {
      const side = Math.min(img.width, img.height);
      ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, 384, 384);
    } else ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const data = canvas.toDataURL(sticker ? 'image/webp' : 'image/jpeg', .8);
    if (data.length > 1500000) throw new Error('Não foi possível reduzir a imagem. Escolha outra menor.');
    return data;
  } finally { URL.revokeObjectURL(url); }
}
async function prepareImage(file) {
  const version = ++imageVersion, channel = currentChannel;
  try {
    const data = await compressImage(file);
    if (version === imageVersion && currentChannel === channel && currentUser) setPendingImage(data);
  } catch (error) { if (version === imageVersion) notify(error.message); }
}
function handleImageUpload(event) { const file = event.target.files[0]; event.target.value = ''; if (file) prepareImage(file); }
function handlePaste(event) {
  const item = Array.from(event.clipboardData?.items || []).find(item => item.type.startsWith('image/'));
  if (item) { event.preventDefault(); prepareImage(item.getAsFile()); }
}
function renderAttachment() {
  const source = pendingImage;
  $('paste-preview').style.display = source ? 'flex' : 'none';
  if (source) $('paste-preview-img').src = source; else $('paste-preview-img').removeAttribute('src');
  $('attachment-label').textContent = 'Foto pronta para enviar';
}
function setPendingImage(data) { pendingImage = data; renderAttachment(); }
function clearPasteImage() { imageVersion++; pendingImage = null; renderAttachment(); }
function stashDraft() {
  drafts.set(currentChannel, { text: $('msg-input').value, image: pendingImage, reply: replyTo });
}
function restoreDraft(channel) {
  imageVersion++;
  const draft = drafts.get(channel) || {};
  $('msg-input').value = draft.text || ''; $('msg-input').style.height = 'auto';
  pendingImage = draft.image || null; replyTo = draft.reply || null;
  renderAttachment(); renderReply(); closeMentionPopup(); toggleStickers(false);
}

    // ── PROFILE ──
    function openProfile() {
      $('profile-display').value = currentUser.display;
      $('profile-user').value = '@' + currentUser.username;
      $('profile-email').value = allUsers[currentUser.username]?.email || '';
      $('profile-pass').value = ''; $('profile-err').textContent = '';
      renderAvatar($('profile-preview'), currentUser); pendingAvatar = null;
      openModal('profile-modal');
    }
    function handleAvatarUpload(e) {
      const f = e.target.files[0]; if (!f) return;
      if (f.size > 300 * 1024) { $('profile-err').textContent = 'Máx 300KB.'; return; }
      const r = new FileReader(); r.onload = ev => { pendingAvatar = ev.target.result; $('profile-preview').innerHTML = `<img src="${pendingAvatar}" alt="">`; }; r.readAsDataURL(f);
    }
    async function saveProfile() {
      const display = $('profile-display').value.trim();
      const pass = $('profile-pass').value;
      const email = $('profile-email').value.trim();
      const err = $('profile-err'); err.textContent = '';
      if (!display) { err.textContent = 'Display name não pode ser vazio.'; return; }
      const updates = { display, email };
      if (pendingAvatar) updates.avatar = pendingAvatar;
      if (pass) { if (pass.length < 4) { err.textContent = 'Mínimo 4 caracteres.'; return; } updates.passHash = await sha256(pass); }
      await update(ref(db, `users/${currentUser.username}`), updates);
      if (updates.passHash) sessionStorage.setItem('chat_session', JSON.stringify({ username: currentUser.username, passHash: updates.passHash }));
      currentUser.display = display;
      if (pendingAvatar) { currentUser.avatar = pendingAvatar; pendingAvatar = null; }
      set(presenceRef, { display: currentUser.display, avatar: currentUser.avatar || null, ts: Date.now() });
      updateSidebarUser(); closeModal('profile-modal');
    }
    async function deleteAccount() {
  if (!currentUser || !confirm('Excluir permanentemente sua conta?')) return;
  const username = currentUser.username;
  try {
    const patches = { [`users/${username}`]: null, [`friends/${username}`]: null, [`presence/${username}`]: null, [`stickers/${username}`]: null };
    await update(ref(db), patches);
    if (currentUser) doLogout();
  } catch (error) { reportError(error, 'Não foi possível excluir a conta.'); }
}
function doLogout() {
  if (presenceRef) remove(presenceRef).catch(error => console.error(error));
  presenceRef = null;
  cleanupSession(); sessionStorage.removeItem('chat_session'); currentUser = null;
  ['admin-badge', 'admin-btn', 'mod-badge'].forEach(id => $(id).style.display = 'none');
  ['message-list', 'group-list', 'dm-list', 'online-user-list'].forEach(id => $(id).replaceChildren());
  $('auth-user').value = ''; $('auth-pass').value = ''; $('auth-err').textContent = '';
  showScreen('auth-screen');
}

    // ── VIEW PROFILE ──
    async function viewProfile(username) {
      const user = allUsers[username] || { username, display: username };
      const modal = $('view-modal');
      if (!modal) return;

      modal.style.display = 'flex';
      $('view-display').textContent = user.display || username;
      $('view-handle').textContent = '@' + username;
      renderAvatar($('view-avatar'), user);

      const badges = $('view-badges');
      badges.innerHTML = '';
      if (ADMIN_USERS.includes(username) || user.isAdmin) {
        badges.innerHTML += '<span class="admin-tag">admin</span>';
      } else if (user.isMod) {
        badges.innerHTML += '<span class="mod-tag">mod</span>';
      }

      const actions = $('view-actions');
      actions.innerHTML = '';

      // BOTÕES DE INTERAÇÃO (DESIGN DO SEU GITHUB)
      if (username !== currentUser.username) {
        const dmBtn = document.createElement('button');
        dmBtn.className = 'btn-primary';
        dmBtn.textContent = 'Mensagem direta';
        dmBtn.onclick = () => { modal.style.display = 'none'; openDM(username); };

        const addBtn = document.createElement('button');
        addBtn.className = 'btn-ghost';
        addBtn.style.marginTop = '0';
        addBtn.textContent = 'Adicionar amigo';
        addBtn.onclick = async () => {
          await push(ref(db, 'friend_requests'), { from: currentUser.username, to: username, status: 'pending', ts: Date.now() });
          addBtn.textContent = 'Solicitação enviada!'; addBtn.disabled = true;
        };

        actions.appendChild(dmBtn);
        actions.appendChild(addBtn);
      }

      if (currentUser.isAdmin) {
  const manage = document.createElement('button'); manage.className = 'btn-ghost'; manage.textContent = 'Gerenciar no painel';
  manage.onclick = () => { closeModal('view-modal'); $('admin-search').value = username; openAdmin(); };
  actions.append(manage);
}

    $('close-view-modal').onclick = () => modal.style.display = 'none';
    }
    

    // ── FRIENDS ──
    function openFriends() {
      $('add-friend-inp').value = ''; $('add-friend-err').textContent = ''; $('add-friend-ok').textContent = '';
      openModal('friends-modal');
      loadFriendsList(); loadRequestsList();
    }
    function switchTab(panelId, btnId) {
      document.querySelectorAll('#friends-modal .tab-panel').forEach(p => p.classList.remove('active'));
      document.querySelectorAll('#friends-modal .tab').forEach(t => t.classList.remove('active'));
      $(panelId).classList.add('active'); $(btnId).classList.add('active');
    }
    async function loadFriendsList() {
      const list = $('friends-list'); list.innerHTML = '';
      const snap = await get(ref(db, `friends/${currentUser.username}`));
      if (!snap.exists()) { list.innerHTML = '<div class="dm-empty">Nenhum amigo ainda.</div>'; return; }
      Object.keys(snap.val()).forEach(uname => {
        const user = allUsers[uname] || { username: uname, display: uname };
        const isOnline = !!allPresence[uname];
        const row = document.createElement('div'); row.className = 'user-row';
        const av = document.createElement('div'); av.style.cssText = 'width:34px;height:34px;border-radius:8px;overflow:hidden;display:flex;align-items:center;justify-content:center;font-size:.68rem;font-weight:600;font-family:var(--font-mono);flex-shrink:0';
        renderAvatar(av, user);
        const info = document.createElement('div'); info.className = 'user-row-info';
        info.innerHTML = `<div class="user-row-name">${escHtml(user.display || uname)}</div><div class="user-row-handle">@${uname} ${isOnline ? '<span style="color:var(--success)">● online</span>' : ''}</div>`;
        const acts = document.createElement('div'); acts.className = 'user-row-actions';
        const dmBtn = document.createElement('button'); dmBtn.className = 'btn-sm'; dmBtn.textContent = 'mensagem';
        dmBtn.onclick = () => { closeModal('friends-modal'); openDM(uname); };
        acts.appendChild(dmBtn);
        row.appendChild(av); row.appendChild(info); row.appendChild(acts); list.appendChild(row);
      });
    }
    async function loadRequestsList() {
      const list = $('requests-list'); list.innerHTML = '';
      const snap = await get(ref(db, 'friend_requests'));
      if (!snap.exists()) { list.innerHTML = '<div class="dm-empty">Nenhuma solicitação.</div>'; return; }
      let found = false;
      Object.entries(snap.val()).forEach(([key, r]) => {
        if (r.to !== currentUser.username || r.status !== 'pending') return;
        found = true;
        const user = allUsers[r.from] || { username: r.from, display: r.from };
        const row = document.createElement('div'); row.className = 'user-row';
        const av = document.createElement('div'); av.style.cssText = 'width:34px;height:34px;border-radius:8px;overflow:hidden;display:flex;align-items:center;justify-content:center;font-size:.68rem;font-weight:600;font-family:var(--font-mono);flex-shrink:0';
        renderAvatar(av, user);
        const info = document.createElement('div'); info.className = 'user-row-info';
        info.innerHTML = `<div class="user-row-name">${escHtml(user.display || r.from)}</div><div class="user-row-handle">@${r.from}</div>`;
        const acts = document.createElement('div'); acts.className = 'user-row-actions';
        const acc = document.createElement('button'); acc.className = 'btn-sm success'; acc.textContent = 'aceitar';
        acc.onclick = async () => {
          await set(ref(db, `friends/${currentUser.username}/${r.from}`), true);
          await set(ref(db, `friends/${r.from}/${currentUser.username}`), true);
          await update(ref(db, `friend_requests/${key}`), { status: 'accepted' });
          loadFriendsList(); loadRequestsList(); renderDMList();
        };
        const dec = document.createElement('button'); dec.className = 'btn-sm danger'; dec.textContent = 'recusar';
        dec.onclick = async () => { await update(ref(db, `friend_requests/${key}`), { status: 'declined' }); loadRequestsList(); };
        acts.appendChild(acc); acts.appendChild(dec);
        row.appendChild(av); row.appendChild(info); row.appendChild(acts); list.appendChild(row);
      });
      if (!found) list.innerHTML = '<div class="dm-empty">Nenhuma solicitação pendente.</div>';
    }
    async function sendFriendRequest() {
      const target = $('add-friend-inp').value.trim().toLowerCase();
      const err = $('add-friend-err'), ok = $('add-friend-ok');
      err.textContent = ''; ok.textContent = '';
      if (!validUsername(target)) { err.textContent = 'Digite um usuário válido.'; return; }
      if (target === currentUser.username) { err.textContent = 'Você não pode adicionar a si mesmo.'; return; }
      const snap = await get(ref(db, `users/${target}`));
      if (!snap.exists()) { err.textContent = 'Usuário não encontrado.'; return; }
      await push(ref(db, 'friend_requests'), { from: currentUser.username, to: target, status: 'pending', ts: Date.now() });
      ok.textContent = 'Solicitação enviada!'; $('add-friend-inp').value = '';
    }

    // ── RECOVER ──
    async function submitRecover() {
      const username = $('recover-user').value.trim().toLowerCase();
      const err = $('recover-err'), ok = $('recover-ok');
      err.textContent = ''; ok.textContent = '';
      if (!validUsername(username)) { err.textContent = 'Digite um usuário válido.'; return; }
      const snap = await get(ref(db, `users/${username}`));
      if (!snap.exists()) { err.textContent = 'Usuário não encontrado.'; return; }
      await push(ref(db, 'recover_requests'), { username, ts: Date.now(), done: false });
      ok.textContent = 'Solicitação enviada! O admin irá redefinir sua senha em breve.';
    }

    // ── ADMIN ──
    function openAdmin() {
  if (!currentUser?.isAdmin) return;
  openModal('admin-modal'); $('admin-error').textContent = ''; renderAdminList();
  if (!recoverListener) recoverListener = onValue(ref(db, 'recover_requests'), snap => {
    recoverRequests = snap.val() || {}; renderRecoverRequests();
  }, error => { $('admin-error').textContent = 'Não foi possível carregar as solicitações.'; console.error(error); });
}
async function adminAction(username, operation) {
  try {
    const actor = currentUser?.username;
    if (!actor) throw new Error('Sessão encerrada.');
    const [me, target] = await Promise.all([get(ref(db, `users/${actor}`)), get(ref(db, `users/${username}`))]);
    if (currentUser?.username !== actor || !me.exists() || me.val().banned || !(ADMIN_USERS.includes(actor) || me.val().isAdmin)) throw new Error('Você não tem permissão para esta ação.');
    if (!target.exists()) throw new Error('Este usuário não existe mais.');
    if (username === actor || ADMIN_USERS.includes(username)) throw new Error('Esta conta é protegida.');
    await operation(target.val());
    $('admin-error').textContent = ''; notify('Alteração salva.');
  } catch (error) { $('admin-error').textContent = error.message || 'Não foi possível salvar.'; }
}
function actionButton(label, style, callback) {
  const button = document.createElement('button'); button.className = 'btn-sm ' + style; button.textContent = label;
  button.onclick = async () => { button.disabled = true; try { await callback(); } catch (error) { reportError(error); } finally { button.disabled = false; } };
  return button;
}
function renderAdminList() {
  if (!currentUser?.isAdmin) return;
  const users = Object.values(allUsers);
  const stats = [[users.length, 'Pessoas'], [users.filter(u => u.isAdmin || ADMIN_USERS.includes(u.username)).length, 'Administradores'], [users.filter(u => u.banned).length, 'Banidos']];
  $('admin-stats').innerHTML = stats.map(([value, label]) => `<div class="admin-stat"><strong>${value}</strong><span>${label}</span></div>`).join('');
  const search = $('admin-search').value.trim().toLowerCase(), filter = $('admin-filter').value;
  const filtered = users.filter(u => [u.username, u.display, u.email].join(' ').toLowerCase().includes(search))
    .filter(u => filter === 'all' || (filter === 'admin' ? u.isAdmin || ADMIN_USERS.includes(u.username) : filter === 'mod' ? u.isMod : u.banned))
    .sort((a, b) => (a.display || a.username).localeCompare(b.display || b.username, 'pt-BR'));
  const list = $('admin-user-list'); list.replaceChildren();
  if (!filtered.length) { list.innerHTML = '<div class="dm-empty">Nenhuma pessoa encontrada.</div>'; return; }
  for (const user of filtered) {
    const username = user.username, protectedUser = ADMIN_USERS.includes(username) || username === currentUser.username;
    const row = document.createElement('div'); row.className = 'user-row';
    const avatar = document.createElement('div'); avatar.className = 'msg-avatar'; renderAvatar(avatar, user);
    const info = document.createElement('div'); info.className = 'user-row-info';
    const name = document.createElement('div'); name.className = 'user-row-name'; name.textContent = user.display || username;
    const detail = document.createElement('div'); detail.className = 'user-row-handle';
    const role = ADMIN_USERS.includes(username) ? 'fundador' : user.isAdmin ? 'administrador' : user.isMod ? 'moderador' : 'membro';
    detail.textContent = `@${username} · ${role}${user.banned ? ' · banido' : ''}`;
    const email = document.createElement('div'); email.className = 'user-row-handle'; email.textContent = user.email || 'Sem e-mail';
    info.append(name, detail, email); row.append(avatar, info);
    const actions = document.createElement('div'); actions.className = 'user-row-actions';
    if (protectedUser) { const label = document.createElement('span'); label.className = 'user-row-handle'; label.textContent = username === currentUser.username ? 'Sua conta' : 'Conta protegida'; actions.append(label); }
    else {
      actions.append(actionButton('Editar nome', '', () => adminAction(username, async latest => {
        const name = prompt(`Nome de exibição de @${username}:`, latest.display || username);
        if (name === null) return;
        if (!name.trim() || name.trim().length > 30) throw new Error('Use um nome entre 1 e 30 caracteres.');
        await update(ref(db, `users/${username}`), { display: name.trim() });
      })));
      actions.append(actionButton(user.isMod ? 'Remover mod' : 'Moderador', 'info', () => adminAction(username, latest => update(ref(db, `users/${username}`), { isMod: !latest.isMod }))));
      actions.append(actionButton(user.isAdmin ? 'Remover admin' : 'Administrador', 'info', () => adminAction(username, async latest => {
        if (confirm(`${latest.isAdmin ? 'Remover' : 'Conceder'} acesso de administrador a @${username}?`)) await update(ref(db, `users/${username}`), { isAdmin: !latest.isAdmin });
      })));
      actions.append(actionButton(user.banned ? 'Desbanir' : 'Banir', user.banned ? 'success' : 'danger', () => adminAction(username, async latest => {
        if (!confirm(`${latest.banned ? 'Desbanir' : 'Banir'} @${username}?`)) return;
        const patches = { [`users/${username}/banned`]: !latest.banned };
        if (!latest.banned) patches[`presence/${username}`] = null;
        await update(ref(db), patches);
      })));
      actions.append(actionButton('Excluir', 'danger', () => adminAction(username, async () => {
        if (prompt(`Para excluir permanentemente, digite @${username}:`) !== '@' + username) return;
        const friends = await get(ref(db, `friends/${username}`));
        const patches = { [`users/${username}`]: null, [`friends/${username}`]: null, [`presence/${username}`]: null, [`stickers/${username}`]: null };
        Object.keys(friends.val() || {}).forEach(friend => patches[`friends/${friend}/${username}`] = null);
        await update(ref(db), patches);
      })));
    }
    row.append(actions); list.append(row);
  }
  renderRecoverRequests();
}
function renderRecoverRequests() {
  const list = $('admin-recover-list'); list.replaceChildren();
  if (!currentUser?.isAdmin) return;
  const pending = Object.entries(recoverRequests).filter(([, request]) => !request.done);
  if (!pending.length) return;
  const title = document.createElement('div'); title.className = 'section-label'; title.textContent = `Recuperação de senha · ${pending.length}`; list.append(title);
  for (const [key, request] of pending) {
    const row = document.createElement('div'); row.className = 'user-row';
    const info = document.createElement('div'); info.className = 'user-row-info'; info.textContent = '@' + request.username;
    const email = document.createElement('div'); email.className = 'user-row-handle'; email.textContent = allUsers[request.username]?.email || 'Sem e-mail'; info.append(email); row.append(info);
    row.append(actionButton('Redefinir senha', '', () => adminAction(request.username, async () => {
      const password = prompt(`Nova senha para @${request.username} (mínimo 4 caracteres):`);
      if (password === null) return;
      if (password.length < 4 || password.length > 64) throw new Error('A senha deve ter entre 4 e 64 caracteres.');
      await update(ref(db), { [`users/${request.username}/passHash`]: await sha256(password), [`recover_requests/${key}/done`]: true });
    })));
    list.append(row);
  }
}

    const builtinStickers = [
      ['amei', '🥰', 'AMEI!', '#e9a9ba'], ['bora', '🚀', 'BORA!', '#c1f17b'],
      ['kkkk', '😂', 'KKKK', '#f5cc78'], ['valeu', '🤝', 'VALEU!', '#a6c8ff'],
      ['to-on', '👀', 'TÔ ON', '#c8b3f1'], ['socorro', '🫠', 'SOCORRO', '#ffb58c']
    ].map(([id, emoji, name, color]) => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 240;
      const ctx = canvas.getContext('2d');
      ctx.translate(120, 120);
      ctx.fillStyle = color; ctx.strokeStyle = '#fff8ec'; ctx.lineWidth = 8;
      ctx.beginPath(); ctx.roundRect(-116, -116, 232, 232, 16); ctx.fill(); ctx.stroke();
      ctx.font = '94px "Segoe UI Emoji", "Apple Color Emoji", sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(emoji, 0, -21);
      ctx.fillStyle = '#263124'; ctx.font = '900 27px sans-serif'; ctx.fillText(name, 0, 67);
      return { id, name, image: canvas.toDataURL('image/png') };
    });
    function customStickers() { return stickerLibrary; }
    function updateStickerControls() {
      // Choosing/preparing a file must not depend on permissions for the remote library.
      $('add-sticker').disabled = stickerSaving;
      $('add-sticker').textContent = stickerSaving ? 'Salvando…' : '+ Criar';
      $('sticker-status').hidden = !stickerLibraryError && !unsavedSticker;
      $('sticker-status-text').textContent = unsavedSticker
        ? 'Sua figurinha está pronta para enviar, mas ainda não foi salva na conta. ' + stickerLibraryError
        : stickerLibraryError;
      $('retry-save-sticker').hidden = !unsavedSticker;
      $('retry-save-sticker').disabled = stickerSaving || !connected;
      $('send-unsaved-sticker').hidden = !unsavedSticker;
    }
    function stickerErrorMessage(error) {
      const detail = String(error?.code || '') + ' ' + String(error?.message || '');
      return /permission|permiss|denied/i.test(detail)
        ? 'O servidor não autorizou o acesso à biblioteca. Um administrador precisa corrigir as permissões.'
        : 'Não foi possível acessar sua biblioteca. Verifique a conexão e tente novamente.';
    }
    function startStickerLibrary() {
      const session = currentUser;
      if (!session) return;
      if (stickerLibraryListener) stickerLibraryListener();
      clearTimeout(stickerLibraryTimer);
      stickerLibrary = []; stickerLibraryReady = false; stickerLibraryError = ''; updateStickerControls();
      let migrationStarted = false;
      stickerLibraryTimer = setTimeout(() => {
        if (currentUser !== session || stickerLibraryReady) return;
        stickerLibraryError = 'A biblioteca está demorando para responder. Você pode escolher uma imagem e preparar sua figurinha.';
        updateStickerControls(); if (!$('sticker-panel').hidden) renderStickers();
      }, 12000);
      stickerLibraryListener = onValue(ref(db, `stickers/${session.username}`), snap => {
        if (currentUser !== session) return;
        clearTimeout(stickerLibraryTimer);
        stickerLibrary = Object.entries(snap.val() || {}).filter(([, value]) => value && safeImage(value.image))
          .map(([id, value]) => ({ ...value, id })).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0) || a.id.localeCompare(b.id));
        stickerLibraryReady = true; stickerLibraryError = ''; updateStickerControls();
        if (!$('sticker-panel').hidden) renderStickers();
        if (!migrationStarted) { migrationStarted = true; migrateLocalStickers(session); }
      }, error => {
        if (currentUser !== session) return;
        clearTimeout(stickerLibraryTimer);
        stickerLibrary = []; stickerLibraryReady = false;
        stickerLibraryError = stickerErrorMessage(error);
        updateStickerControls(); if (!$('sticker-panel').hidden) renderStickers(); console.error(error);
      });
    }
    function prepareUnsavedSticker(sticker) {
      unsavedSticker = sticker; updateStickerControls();
    }
    async function saveStickerToAccount(sticker, session) {
      if (!connected || !stickerLibraryReady) {
        stickerLibraryError ||= connected ? 'Não foi possível carregar a biblioteca da conta. Tente reconectar.' : 'Sem conexão. Reconecte para salvar na conta.';
        prepareUnsavedSticker(sticker);
        notify('Figurinha pronta para enviar. Ela ainda não foi salva na conta.');
        return;
      }
      if (stickerLibrary.length >= MAX_STICKERS && !stickerLibrary.some(item => item.id === sticker.id)) {
        prepareUnsavedSticker(sticker);
        stickerLibraryError = 'Sua biblioteca está cheia. Remova uma figurinha para salvar outra.';
        updateStickerControls(); return;
      }
      try {
        await set(ref(db, `stickers/${session.username}/${sticker.id}`), { name: sticker.name, image: sticker.image, createdAt: serverTimestamp() });
        if (currentUser !== session) return;
        if (unsavedSticker?.id === sticker.id) unsavedSticker = null;
        stickerLibraryError = ''; updateStickerControls();
        notify('Figurinha salva na sua conta! Selecione para enviar.');
      } catch (error) {
        if (currentUser !== session) return;
        stickerLibraryError = stickerErrorMessage(error); prepareUnsavedSticker(sticker);
        notify('Figurinha pronta para enviar. Não foi possível salvar na conta.');
      }
    }
    async function migrateLocalStickers(session) {
      const key = 'cuppimxas-stickers:' + session.username;
      let saved;
      try { saved = JSON.parse(localStorage.getItem(key) || '[]'); } catch { return; }
      if (!Array.isArray(saved) || !saved.length || !connected) return;
      stickerSaving = true; updateStickerControls();
      const remaining = [...saved];
      try {
        let count = stickerLibrary.length;
        for (const sticker of saved) {
          if (currentUser !== session) return;
          if (!sticker || !safeImage(sticker.image)) continue;
          if (!stickerLibrary.some(existing => existing.image === sticker.image)) {
            if (count >= MAX_STICKERS) break;
            // Deterministic keys make retries safe if the browser closed during migration.
            const id = 'imported-' + await sha256(sticker.image);
            if (currentUser !== session) return;
            await set(ref(db, `stickers/${session.username}/${id}`), { name: String(sticker.name || 'Minha figurinha').slice(0, 40), image: sticker.image, createdAt: serverTimestamp() });
            count++;
          }
          remaining.splice(remaining.indexOf(sticker), 1);
          // Remove local copies only after the server acknowledges the write.
          if (remaining.length) localStorage.setItem(key, JSON.stringify(remaining)); else localStorage.removeItem(key);
        }
        if (currentUser === session && remaining.length < saved.length) notify('Suas figurinhas antigas foram salvas na conta.' + (remaining.length ? ' Libere espaço para importar as restantes.' : ''));
      } catch (error) {
        if (currentUser === session) reportError(error, 'Não foi possível importar todas as figurinhas. As cópias locais foram preservadas.');
      } finally { if (currentUser === session) { stickerSaving = false; updateStickerControls(); } }
    }
    async function deleteSticker(id) {
      if (!currentUser || !connected) { notify('Conecte-se para remover a figurinha da conta.'); return; }
      const session = currentUser;
      try { await remove(ref(db, `stickers/${session.username}/${id}`)); }
      catch (error) { if (currentUser === session) reportError(error, 'Não foi possível remover a figurinha. Tente novamente.'); }
    }
    function toggleStickers(open = $('sticker-panel').hidden) {
      $('sticker-panel').hidden = !open; $('sticker-btn').setAttribute('aria-expanded', String(open));
      if (open) { closeMentionPopup(); renderStickers(); }
    }
    function renderStickers() {
      for (const [id, stickers, custom] of [['sticker-grid', builtinStickers, false], ['custom-sticker-grid', customStickers(), true]]) {
        const grid = $(id); grid.replaceChildren();
        for (const sticker of stickers) {
          const option = document.createElement('div'); option.className = 'sticker-option';
          const button = document.createElement('button'); button.className = 'sticker-choice'; button.title = 'Enviar ' + sticker.name; button.setAttribute('aria-label', 'Enviar figurinha ' + sticker.name);
          const img = new Image(); img.src = sticker.image; img.alt = sticker.name; button.append(img);
          button.onclick = () => sendSticker(sticker, custom);
          option.append(button);
          if (custom) {
            const remove = document.createElement('button'); remove.className = 'remove-sticker'; remove.textContent = '×'; remove.title = 'Remover figurinha'; remove.setAttribute('aria-label', 'Remover ' + sticker.name);
            remove.onclick = async () => { remove.disabled = true; await deleteSticker(sticker.id); remove.disabled = false; }; option.append(remove);
          }
          grid.append(option);
        }
        if (custom && !stickers.length) { const empty = document.createElement('p'); empty.className = 'user-row-handle'; empty.style.gridColumn = '1 / -1'; empty.textContent = stickerLibraryError || (!stickerLibraryReady ? 'Carregando suas figurinhas…' : 'Suas figurinhas acompanham sua conta. Crie até 24, incluindo GIFs animados de até 2 MB.'); grid.append(empty); }
      }
    }
    function setupChatFeatures() {
      $('notification-btn').onclick = async () => {
        const status = await messageAlerts.toggle();
        if (!currentUser || !status) return;
        notify(!status.enabled ? 'Notificações desativadas.' : status.permission === 'granted'
          ? 'Som e popups ativados quando a aba estiver em segundo plano.'
          : status.permission === 'denied' ? 'Som ativado. Para popups, permita notificações nas configurações deste site no navegador.'
          : 'Som ativado. Os popups precisam de permissão do navegador e de HTTPS.');
      };
      document.addEventListener('pointerdown', () => { if (currentUser) messageAlerts.unlockSound(); }, { passive: true });
      document.addEventListener('keydown', () => { if (currentUser) messageAlerts.unlockSound(); });
      $('scroll-bottom').onclick = scrollToLatest;
      $('cancel-reply').onclick = clearReply;
      $('sticker-btn').onclick = () => toggleStickers();
      $('close-stickers').onclick = () => toggleStickers(false);
      $('add-sticker').onclick = () => $('sticker-upload').click();
      $('retry-sticker-library').onclick = startStickerLibrary;
      $('send-unsaved-sticker').onclick = () => { if (unsavedSticker) sendSticker(unsavedSticker); };
      $('retry-save-sticker').onclick = async () => {
        if (!unsavedSticker || !currentUser || stickerSaving) return;
        const session = currentUser; stickerSaving = true; updateStickerControls();
        try { await saveStickerToAccount(unsavedSticker, session); }
        finally { if (currentUser === session) { stickerSaving = false; updateStickerControls(); } }
      };
      $('close-sidebar').onclick = () => $('sidebar').classList.remove('open');
      $('admin-search').oninput = renderAdminList; $('admin-filter').onchange = renderAdminList;
      $('sticker-upload').onchange = async event => {
        const file = event.target.files[0]; event.target.value = ''; if (!file || !currentUser) return;
        const session = currentUser;
        if (stickerSaving) return;
        stickerSaving = true; updateStickerControls();
        try {
          const image = await compressImage(file, true);
          if (currentUser !== session) return;
          const sticker = { id: push(ref(db, `stickers/${session.username}`)).key, name: file.name.replace(/\.[^.]+$/, '').slice(0, 40) || 'Minha figurinha', image };
          await saveStickerToAccount(sticker, session);
        } catch (error) { if (currentUser === session) notify(error.message || 'Não foi possível salvar a figurinha na conta.'); }
        finally { if (currentUser === session) { stickerSaving = false; updateStickerControls(); } }
      };
      const messages = $('messages');
      messages.addEventListener('scroll', () => {
        followBottom = nearBottom();
        if (followBottom) newMessageCount = 0;
        updateScrollButton();
      }, { passive: true });
      messages.addEventListener('wheel', event => { if (event.deltaY < 0) { followBottom = false; cancelAnimationFrame(scrollFrame); } }, { passive: true });
      messages.addEventListener('touchmove', () => { followBottom = false; cancelAnimationFrame(scrollFrame); }, { passive: true });
      const observer = new ResizeObserver(() => { if (followBottom) scrollToLatest(); else updateScrollButton(); });
      observer.observe($('message-list')); observer.observe(messages);
      document.addEventListener('click', event => {
        const path = event.composedPath();
        if (!path.some(el => el.id === 'sticker-panel' || el.id === 'sticker-btn')) toggleStickers(false);
        if (window.innerWidth <= 640 && !path.some(el => el.id === 'sidebar' || el.id === 'mob-toggle')) $('sidebar').classList.remove('open');
      });
      document.addEventListener('pointerdown', event => {
        const touchedMessage = event.pointerType === 'touch' ? event.target.closest('.msg') : null;
        document.querySelectorAll('.msg.actions-open').forEach(message => {
          if (message !== touchedMessage) message.classList.remove('actions-open');
        });
      });
      document.addEventListener('keydown', event => {
        const modal = Array.from(document.querySelectorAll('.modal-backdrop')).find(el => el.style.display === 'flex');
        if (event.key === 'Tab' && modal) {
          const focusable = Array.from(modal.querySelectorAll('button, input, textarea, select, [tabindex="0"]')).filter(el => !el.disabled && el.getClientRects().length);
          const first = focusable[0], last = focusable.at(-1);
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
        if (event.key !== 'Escape') return;
        document.querySelectorAll('.msg.actions-open').forEach(message => message.classList.remove('actions-open'));
        if (modal) closeModal(modal.id);
        $('lightbox').style.display = 'none'; $('sidebar').classList.remove('open');
        toggleStickers(false); clearReply(); closeMentionPopup();
      });
      document.querySelectorAll('button[title]').forEach(button => { if (!button.hasAttribute('aria-label')) button.setAttribute('aria-label', button.title); });
      $('mob-toggle').setAttribute('aria-label', 'Abrir conversas');
      document.querySelectorAll('.modal-close').forEach(button => button.setAttribute('aria-label', 'Fechar janela'));
      document.querySelectorAll('.modal-backdrop').forEach(modal => { modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); modal.setAttribute('aria-label', modal.querySelector('.modal-title')?.textContent || 'Janela'); });
      document.querySelectorAll('.field').forEach(field => {
        const label = field.querySelector('.label'), input = field.querySelector('input');
        if (label && input) { label.id = input.id + '-label'; input.setAttribute('aria-labelledby', label.id); }
      });
      // Report asynchronous failures without silently losing the user's work.
      window.addEventListener('unhandledrejection', event => { reportError(event.reason); event.preventDefault(); });
    }
    bindEvents();
