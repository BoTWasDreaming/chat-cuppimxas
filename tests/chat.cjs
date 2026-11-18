// Browser regression tests. Firebase is fully intercepted: no real account or database writes.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { mkdirSync, readFileSync, existsSync } = require('node:fs');
const path = require('node:path');
const { createServer } = require('node:http');

const root = path.resolve(__dirname, '..');
const password = createHash('sha256').update('test1234').digest('hex');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=', 'base64');
// A valid looping GIF with two different frames, kept byte-for-byte through upload/send.
const gif = Buffer.from('47494638396101000100800000ff00000000ff21ff0b4e45545343415045322e30030100000021f904000a0000002c000000000100010000020244010021f904000a0000002c00000000010001000002024c01003b', 'hex');
const errors = [];
let passed = 0;

async function test(name, fn) { await fn(); passed++; console.log('PASS ' + name); }
async function bottom(page) { await page.waitForFunction(() => { const el = document.getElementById('messages'); return el.scrollHeight - el.clientHeight - el.scrollTop < 3; }); }
async function login(page, user = 'tester') {
  await page.locator('#auth-user').fill(user); await page.locator('#auth-pass').fill('test1234');
  await page.locator('#auth-btn').click(); await page.locator('#chat-screen.active').waitFor(); await bottom(page);
}

(async () => {
  // Self-contained static server so npm test does not require a second command.
  const server = createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const file = path.resolve(root, '.' + (name === '/' ? '/index.html' : name));
    if (!file.startsWith(root + path.sep) || !existsSync(file)) { res.writeHead(404).end(); return; }
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png' };
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' }); res.end(readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
    browser = await chromium.launch({ headless: true, ...(existsSync(edge) ? { executablePath: edge } : {}) });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, hasTouch: true });
    await context.addInitScript(({ password }) => {
      // Deterministic browser APIs: tests never emit real audio or operating-system popups.
      const hidden = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden').get;
      const hasFocus = document.hasFocus.bind(document);
      window.alertFixture = { background: null, permission: 'default', sounds: 0, popups: [], permissionRequests: 0 };
      Object.defineProperty(document, 'hidden', { get: () => window.alertFixture.background ?? hidden.call(document) });
      document.hasFocus = () => window.alertFixture.background === null ? hasFocus() : !window.alertFixture.background;
      window.Notification = class {
        static get permission() { return window.alertFixture.permission; }
        static async requestPermission() { window.alertFixture.permissionRequests++; return window.alertFixture.permission = 'granted'; }
        constructor(title, options) { this.title = title; this.options = options; this.closed = false; window.alertFixture.popups.push(this); }
        close() { this.closed = true; }
      };
      window.AudioContext = class {
        constructor() { this.state = 'suspended'; this.currentTime = 0; this.destination = {}; }
        async resume() { this.state = 'running'; }
        async close() { this.state = 'closed'; }
        createOscillator() { return { frequency: {}, connect() {}, disconnect() {}, start() { window.alertFixture.sounds++; }, stop() {} }; }
        createGain() { return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} }; }
      };
      const messages = {};
      for (let i = 0; i < 70; i++) messages['m' + String(i).padStart(3, '0')] = {
        user: i % 3 ? 'ana' : 'tester', display: i % 3 ? 'Ana Souza' : 'Emmanuel',
        text: ['Alguém por aqui? Bora colocar o papo em dia 🌿', 'Sim! Como foi o dia de vocês?', 'A gente podia combinar alguma coisa no fim de semana.', 'Gostei da ideia! Vou chamar o pessoal.'][i % 4],
        ts: 1794940000000 + i * 60000
      };
      messages.m069.image = 'https://fixtures.invalid/slow.png';
      const data = {
        '.info': { connected: true },
        users: {
          tester: { username: 'tester', display: 'Emmanuel', passHash: password, email: 'teste@example.com', isAdmin: true },
          ana: { username: 'ana', display: 'Ana Souza', passHash: password, email: 'ana@example.com' },
          bruno: { username: 'bruno', display: 'Bruno Costa', passHash: password, email: 'bruno@example.com' },
          rei_chikit0: { username: 'rei_chikit0', display: 'Chikito', passHash: password },
          manobotkk: { username: 'manobotkk', display: 'Fundador', passHash: password }
        },
        messages: { geral: messages }, groups: { jogos: { name: 'jogos' } },
        friends: { tester: { ana: true } }, presence: { ana: { display: 'Ana Souza' }, bruno: { display: 'Bruno Costa' } },
        recover_requests: { r1: { username: 'bruno', done: false } }
      };
      const listeners = new Set();
      const read = key => key.split('/').filter(Boolean).reduce((value, part) => value?.[part], data);
      const snapshot = key => { const value = structuredClone(read(key) ?? null); return { exists: () => value !== null, val: () => value }; };
      const notify = key => { for (const entry of [...listeners]) if (!key || !entry.path || key === entry.path || key.startsWith(entry.path + '/') || entry.path.startsWith(key + '/')) queueMicrotask(() => { if (listeners.has(entry)) entry.callback(snapshot(entry.path)); }); };
      const write = (key, value) => {
        const parts = key.split('/').filter(Boolean); let parent = data;
        for (const part of parts.slice(0, -1)) parent = parent[part] ||= {};
        if (value === null) delete parent[parts.at(-1)]; else parent[parts.at(-1)] = structuredClone(value);
        notify(key);
      };
      window.fixture = {
        data, listeners, write, read, failNextPush: false, failNextStickerSet: false, denyStickerRead: false, pushDelay: 0, writes: [],
        get: async key => snapshot(key),
        onValue(key, callback, cancel) {
          const entry = { path: key, callback }; listeners.add(entry);
          queueMicrotask(() => {
            if (!listeners.has(entry)) return;
            if (key.startsWith('stickers/') && this.denyStickerRead) { listeners.delete(entry); cancel?.(new Error('Permission denied')); }
            else callback(snapshot(key));
          });
          return () => listeners.delete(entry);
        },
        async set(key, value) {
          if (key.startsWith('stickers/') && this.failNextStickerSet) { this.failNextStickerSet = false; throw new Error('Sem permissão para salvar a figurinha.'); }
          write(key, value);
        },
        async remove(key) { write(key, null); },
        async update(key, values) { for (const [part, value] of Object.entries(values)) write([key, part].filter(Boolean).join('/'), value); },
        async push(key, value) {
          if (this.pushDelay) await new Promise(resolve => setTimeout(resolve, this.pushDelay));
          if (this.failNextPush) { this.failNextPush = false; throw new Error('Simulated send failure'); }
          this.writes.push({ path: key, value: structuredClone(value) }); write(key + '/p' + Date.now(), value);
        }
      };
    }, { password });
    await context.route('https://www.gstatic.com/firebasejs/**', route => {
      const database = route.request().url().includes('firebase-database');
      route.fulfill({ contentType: 'text/javascript', body: database ? `
        export const getDatabase = () => ({}), ref = (db, path = '') => path, serverTimestamp = () => Date.now();
        export const get = path => window.fixture.get(path), onValue = (path, cb, cancel) => window.fixture.onValue(path, cb, cancel);
        export const set = (path, value) => window.fixture.set(path, value), remove = path => window.fixture.remove(path);
        export const update = (path, value) => window.fixture.update(path, value), push = (path, value) => value === undefined ? { key: 'key-' + crypto.randomUUID() } : window.fixture.push(path, value);
        export const onDisconnect = () => ({ remove: async () => {}, cancel: async () => {} });
      ` : 'export const initializeApp = () => ({});' });
    });
    // Block actual Firebase hosts as a second safeguard for the test suite.
    await context.route(/firebaseio\.com|firebasedatabase\.app|googleapis\.com\/identitytoolkit/, route => route.abort());
    await context.route('https://fixtures.invalid/slow.png', async route => {
      await new Promise(resolve => setTimeout(resolve, 800));
      await route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="#8baf98"/><circle cx="580" cy="160" r="65" fill="#e6e9b5"/><path d="M0 600V370L250 160 550 600M240 600 580 300 800 430V600" fill="#3b6353"/></svg>' });
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    await page.goto(url);
    mkdirSync(path.join(root, 'test-results'), { recursive: true });
    await page.screenshot({ path: path.join(root, 'test-results/login.png') });

    await test('Login, long history and delayed image settle at the last message', async () => {
      await login(page);
      await page.waitForFunction(() => document.querySelector('.msg-img')?.complete);
      await bottom(page); assert.equal(await page.locator('.msg').count(), 70);
      const photoRatio = await page.locator('.msg-img').evaluate(img => {
        const box = img.getBoundingClientRect();
        return Math.abs(box.width / box.height - img.naturalWidth / img.naturalHeight);
      });
      assert.ok(photoRatio < .02, 'Photos retain their original aspect ratio');
    });
    await test('Double-click replies and the quote is sent with the message', async () => {
      await page.locator('.msg[data-key="m068"] .msg-bubble').dblclick();
      assert.equal(await page.locator('#reply-preview').isVisible(), true);
      await page.locator('#msg-input').fill('Combinado! ✨'); await page.locator('#send-btn').click();
      await page.waitForFunction(() => window.fixture.writes.length === 1);
      const payload = await page.evaluate(() => window.fixture.writes.at(-1).value);
      assert.equal(payload.replyTo.key, 'm068'); assert.equal(payload.text, 'Combinado! ✨');
      await page.locator('.reply-quote').last().waitFor(); await bottom(page);
    });
    await test('Double tap on a photo selects a reply without opening the lightbox', async () => {
      const photo = page.locator('[data-key="m069"] .msg-img');
      await photo.scrollIntoViewIfNeeded();
      const box = await photo.boundingBox();
      await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
      await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
      await page.locator('#reply-preview').waitFor({ state: 'visible' });
      await page.waitForTimeout(500); // Allow the photo's single-click timer to expire.
      assert.equal(await page.locator('#lightbox').isVisible(), false);
      await page.locator('#cancel-reply').click();
    });
    await test('Historical reading stays in place; arrow and unread count reach the bottom', async () => {
      await page.locator('#messages').hover();
      await page.mouse.wheel(0, -2000);
      await page.waitForFunction(() => !document.getElementById('scroll-bottom').hidden);
      const before = await page.locator('#messages').evaluate(el => el.scrollTop);
      await page.evaluate(() => { window.preservedNode = document.querySelector('[data-key="m010"]'); window.fixture.write('messages/geral/new', { user: 'ana', text: 'Nova mensagem', ts: Date.now() }); });
      await page.waitForFunction(() => document.querySelector('[data-key="new"]'));
      assert.ok(Math.abs(await page.locator('#messages').evaluate(el => el.scrollTop) - before) < 3);
      assert.equal(await page.evaluate(() => window.preservedNode === document.querySelector('[data-key="m010"]')), true);
      assert.equal(await page.locator('#new-message-count').textContent(), '1');
      await page.locator('#scroll-bottom').click(); await bottom(page);
    });
    await test('Photo preview is compact, removable and remains on a failed send', async () => {
      await page.locator('#img-upload').setInputFiles({ name: 'foto.png', mimeType: 'image/png', buffer: png });
      await page.locator('#paste-preview').waitFor({ state: 'visible' });
      const preview = await page.locator('#paste-preview').boundingBox();
      assert.equal(preview.width, preview.height); assert.ok(preview.height <= 90);
      const close = await page.locator('#clear-paste-btn').boundingBox();
      assert.ok(close.x > preview.x + preview.width / 2 && close.y < preview.y + preview.height / 2);
      await page.locator('#clear-paste-btn').click(); assert.equal(await page.locator('#paste-preview').isVisible(), false);
      await page.locator('#img-upload').setInputFiles({ name: 'foto.png', mimeType: 'image/png', buffer: png });
      await page.locator('#paste-preview').waitFor({ state: 'visible' });
      await page.locator('#msg-input').fill('Esta legenda fica salva');
      await page.evaluate(() => window.fixture.failNextPush = true); await page.locator('#send-btn').click();
      await page.getByText('A mensagem não foi enviada. Seu texto e anexo foram preservados.', { exact: true }).waitFor();
      assert.equal(await page.locator('#msg-input').inputValue(), 'Esta legenda fica salva');
      assert.equal(await page.locator('#paste-preview').isVisible(), true);
      await page.locator('#send-btn').click(); await page.waitForFunction(() => document.getElementById('msg-input').value === '');
    });
    await test('Built-in and custom stickers can be created, sent, persisted and removed', async () => {
      await page.locator('#sticker-btn').click(); await page.locator('#sticker-grid button').first().click();
      await page.locator('.message-sticker').first().waitFor();
      assert.equal(await page.locator('#paste-preview').isVisible(), false);
      await page.locator('#sticker-btn').click();
      await page.locator('#sticker-upload').setInputFiles({ name: 'minha.png', mimeType: 'image/png', buffer: png });
      await page.locator('#custom-sticker-grid .sticker-choice').waitFor();
      assert.equal(await page.evaluate(() => Object.keys(window.fixture.read('stickers/tester') || {}).length), 1);
      assert.equal(await page.evaluate(() => localStorage.getItem('cuppimxas-stickers:tester')), null);
      const size = await page.locator('#custom-sticker-grid img').evaluate(img => [img.naturalWidth, img.naturalHeight]);
      assert.deepEqual(size, [384, 384]);
      await page.locator('#custom-sticker-grid .sticker-choice').click();
      await page.waitForFunction(() => window.fixture.writes.at(-1)?.value.sticker?.image?.startsWith('data:image/webp'));
      await page.locator('#sticker-btn').click(); await page.locator('.remove-sticker').click();
      assert.equal(await page.locator('#custom-sticker-grid .sticker-choice').count(), 0); await page.locator('#close-stickers').click();
    });
    await test('GIF animations survive upload, preview, sending and cloud library updates', async () => {
      await page.locator('#sticker-btn').click();
      await page.locator('#sticker-upload').setInputFiles({ name: 'animada.gif', mimeType: 'image/gif', buffer: gif });
      await page.locator('#custom-sticker-grid .sticker-choice').waitFor();
      const library = await page.evaluate(() => window.fixture.read('stickers/tester'));
      const image = Object.values(library)[0].image;
      assert.equal(image, 'data:image/gif;base64,' + gif.toString('base64'));
      await page.locator('#custom-sticker-grid .sticker-choice').click();
      assert.equal(await page.locator('#paste-preview').isVisible(), false);
      await page.waitForFunction(() => window.fixture.writes.at(-1)?.value.sticker?.image?.startsWith('data:image/gif'));
      assert.equal(await page.evaluate(() => window.fixture.writes.at(-1).value.sticker.image), image);
      const media = await page.locator('.message-sticker').last().boundingBox();
      assert.equal(media.width, media.height);
      // A second client receives the same remote snapshot without any local sticker storage.
      const peer = await context.newPage(); await peer.goto(url);
      await peer.evaluate(library => window.fixture.write('stickers/tester', library), library);
      await login(peer); await peer.locator('#sticker-btn').click();
      assert.equal(await peer.locator('#custom-sticker-grid img').getAttribute('src'), image);
      await peer.evaluate(() => window.fixture.write('stickers/tester', null));
      await peer.waitForFunction(() => !document.querySelector('#custom-sticker-grid .sticker-choice'));
      await peer.close();
      await page.locator('#sticker-btn').click(); await page.locator('.remove-sticker').click();
      await page.waitForFunction(() => Object.keys(window.fixture.read('stickers/tester') || {}).length === 0);
      await page.locator('#close-stickers').click();
      // GIF attachments use the same animation-preserving path.
      await page.locator('#img-upload').setInputFiles({ name: 'anexo.gif', mimeType: 'image/gif', buffer: gif });
      await page.locator('#paste-preview').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#paste-preview-img').getAttribute('src'), image);
      await page.locator('#send-btn').click();
      await page.waitForFunction(() => window.fixture.writes.at(-1)?.value.image?.startsWith('data:image/gif'));
      const attachment = await page.locator('.msg-img').last().boundingBox();
      assert.equal(attachment.width, attachment.height);
    });
    await test('Failed cloud saves are reported and do not pretend to save locally', async () => {
      await page.locator('#sticker-btn').click();
      await page.evaluate(() => window.fixture.failNextStickerSet = true);
      await page.locator('#sticker-upload').setInputFiles({ name: 'erro.png', mimeType: 'image/png', buffer: png });
      await page.getByText('Figurinha pronta para enviar. Não foi possível salvar na conta.', { exact: true }).waitFor();
      assert.equal(await page.locator('#custom-sticker-grid .sticker-choice').count(), 0);
      assert.equal(await page.evaluate(() => localStorage.getItem('cuppimxas-stickers:tester')), null);
      assert.match(await page.locator('#sticker-status').innerText(), /não foi salva na conta/);
      await page.locator('#retry-save-sticker').click();
      await page.locator('#custom-sticker-grid .sticker-choice').waitFor();
      await page.locator('.remove-sticker').click();
      await page.locator('#close-stickers').click();
      assert.equal(await page.locator('#paste-preview').isVisible(), false);
    });
    await test('Permission-denied libraries still allow choosing/sending a sticker and reconnecting', async () => {
      await page.locator('#sidebar-avatar').click(); await page.locator('#logout-btn').click();
      await page.evaluate(() => window.fixture.denyStickerRead = true);
      await login(page); await page.locator('#sticker-btn').click();
      assert.equal(await page.locator('#add-sticker').isEnabled(), true);
      assert.match(await page.locator('#sticker-status').innerText(), /não autorizou/);
      const chooserPromise = page.waitForEvent('filechooser');
      await page.locator('#add-sticker').click();
      await (await chooserPromise).setFiles({ name: 'permitida.gif', mimeType: 'image/gif', buffer: gif });
      await page.getByText('Figurinha pronta para enviar. Ela ainda não foi salva na conta.', { exact: true }).waitFor();
      assert.equal(await page.locator('#paste-preview').isVisible(), false);
      await page.locator('#send-unsaved-sticker').click();
      await page.waitForFunction(() => window.fixture.writes.at(-1)?.value.sticker?.name === 'permitida');
      assert.equal(await page.evaluate(() => Object.keys(window.fixture.read('stickers/tester') || {}).length), 0);
      await page.evaluate(() => window.fixture.denyStickerRead = false);
      await page.locator('#sticker-btn').click(); await page.locator('#retry-sticker-library').click();
      await page.waitForFunction(() => !document.getElementById('sticker-status-text').textContent.includes('não autorizou'));
      await page.locator('#retry-save-sticker').click();
      await page.locator('#custom-sticker-grid .sticker-choice').waitFor();
      await page.locator('.remove-sticker').click(); await page.locator('#close-stickers').click();
    });
    await test('One-click stickers never attach to text/photos, and failed sends can be retried', async () => {
      await page.locator('#msg-input').fill('Meu rascunho fica aqui');
      await page.locator('#img-upload').setInputFiles({ name: 'rascunho.png', mimeType: 'image/png', buffer: png });
      await page.locator('#paste-preview').waitFor({ state: 'visible' });
      const photo = await page.locator('#paste-preview-img').getAttribute('src');
      await page.locator('#sticker-btn').click();
      await page.evaluate(() => window.fixture.failNextPush = true);
      await page.locator('#sticker-grid button').first().click();
      await page.getByText('A figurinha não foi enviada. Clique nela para tentar novamente.', { exact: true }).waitFor();
      assert.equal(await page.locator('#sticker-panel').isVisible(), true);
      await page.evaluate(() => window.fixture.pushDelay = 150);
      const count = await page.evaluate(() => window.fixture.writes.length);
      await page.locator('#sticker-grid button').first().evaluate(button => { button.click(); button.click(); });
      await page.waitForFunction(count => window.fixture.writes.length === count + 1, count);
      const sent = await page.evaluate(() => window.fixture.writes.at(-1).value);
      assert.equal(sent.sticker.id, 'amei'); assert.equal(sent.text, undefined); assert.equal(sent.image, undefined);
      assert.equal(await page.locator('#msg-input').inputValue(), 'Meu rascunho fica aqui');
      assert.equal(await page.locator('#paste-preview-img').getAttribute('src'), photo);
      await page.evaluate(() => window.fixture.pushDelay = 0);
      await page.locator('#clear-paste-btn').click(); await page.locator('#msg-input').fill('');
    });
    await test('Sticker sends retain their original channel and do not clear another conversation draft', async () => {
      await page.locator('#msg-input').fill('Rascunho preservado');
      await page.locator('#sticker-btn').click();
      await page.evaluate(() => window.fixture.pushDelay = 300);
      const count = await page.evaluate(() => window.fixture.writes.length);
      await page.locator('#sticker-grid button').first().click();
      await page.locator('[data-channel="jogos"]').click();
      await page.locator('#msg-input').fill('Outra conversa');
      await page.waitForFunction(count => window.fixture.writes.length === count + 1, count);
      assert.equal(await page.evaluate(() => window.fixture.writes.at(-1).path), 'messages/geral');
      assert.equal(await page.locator('#msg-input').inputValue(), 'Outra conversa');
      await page.locator('#msg-input').fill(''); await page.locator('#ch-geral').click();
      assert.equal(await page.locator('#msg-input').inputValue(), 'Rascunho preservado');
      await page.locator('#msg-input').fill(''); await page.evaluate(() => window.fixture.pushDelay = 0);
    });
    await test('Drafts stay in their conversation and sending is guarded against duplicate clicks', async () => {
      await page.locator('#msg-input').fill('Rascunho geral');
      await page.locator('[data-channel="jogos"]').click(); assert.equal(await page.locator('#msg-input').inputValue(), '');
      await page.locator('#msg-input').fill('Rascunho jogos'); await page.locator('#ch-geral').click();
      assert.equal(await page.locator('#msg-input').inputValue(), 'Rascunho geral');
      const count = await page.evaluate(() => { window.fixture.pushDelay = 300; return window.fixture.writes.length; });
      await page.locator('#send-btn').evaluate(el => { el.click(); el.click(); el.click(); });
      await page.locator('[data-channel="jogos"]').click();
      await page.waitForFunction(count => window.fixture.writes.length === count + 1, count);
      assert.equal(await page.locator('#msg-input').inputValue(), 'Rascunho jogos');
      assert.equal(await page.evaluate(() => window.fixture.writes.at(-1).path), 'messages/geral');
      await page.locator('#ch-geral').click(); assert.equal(await page.locator('#msg-input').inputValue(), '');
      await page.evaluate(() => window.fixture.pushDelay = 0);
    });
    await test('Admin promotion stays visible and can be revoked; search and roles update live', async () => {
      await page.locator('#admin-btn').click();
      await page.locator('#admin-search').fill('ana');
      await page.locator('#admin-user-list').getByRole('button', { name: 'Administrador', exact: true }).click();
      await page.locator('#admin-user-list').getByRole('button', { name: 'Remover admin', exact: true }).waitFor();
      assert.equal(await page.locator('#admin-user-list .user-row').count(), 1);
      await page.locator('#admin-user-list').getByRole('button', { name: 'Remover admin', exact: true }).click();
      await page.locator('#admin-user-list').getByRole('button', { name: 'Administrador', exact: true }).waitFor();
      await page.locator('#admin-user-list').getByRole('button', { name: 'Moderador', exact: true }).click();
      await page.locator('#admin-filter').selectOption('mod');
      await page.locator('#admin-user-list').getByRole('button', { name: 'Remover mod', exact: true }).waitFor();
      await page.locator('#admin-search').fill(''); await page.locator('#admin-filter').selectOption('all');
      await page.screenshot({ path: path.join(root, 'test-results/admin.png') });
      assert.equal(await page.locator('#admin-user-list .user-row').count(), 5);
      const formerOwner = page.locator('#admin-user-list .user-row').filter({ hasText: '@rei_chikit0' });
      assert.match(await formerOwner.innerText(), /membro/);
      assert.equal(await formerOwner.getByRole('button', { name: 'Administrador', exact: true }).count(), 1);
      await page.locator('#close-admin-modal').click();
    });
    await test('Message content and display names do not inject HTML or execute scripts', async () => {
      await page.evaluate(() => window.fixture.write('messages/geral/xss', { user: 'unknown', display: '<img src=x onerror="window.xss=true">', text: '<img src=x onerror="window.xss=true"> https://example.com/?x=" @ana', ts: Date.now() }));
      await page.locator('[data-key="xss"]').waitFor();
      assert.equal(await page.evaluate(() => window.xss), undefined);
      assert.equal(await page.locator('[data-key="xss"] img').count(), 0);
      assert.equal(await page.locator('[data-key="xss"] a').count(), 1);
    });
    await test('Re-entry restores the last message and logout unsubscribes all database listeners', async () => {
      await page.locator('[data-channel="jogos"]').click(); await page.locator('#ch-geral').click(); await bottom(page);
      await page.locator('#sidebar-avatar').click(); await page.locator('#logout-btn').click();
      await page.locator('#auth-screen.active').waitFor();
      assert.equal(await page.evaluate(() => window.fixture.listeners.size), 0);
      await login(page); assert.equal(await page.evaluate(() => window.fixture.listeners.size), 11);
    });
    await test('Existing local stickers migrate only after a successful cloud write', async () => {
      await page.locator('#sidebar-avatar').click(); await page.locator('#logout-btn').click();
      await page.evaluate(image => localStorage.setItem('cuppimxas-stickers:tester', JSON.stringify([{ id: 'old-sticker', name: 'Antiga', image }])), 'data:image/png;base64,' + png.toString('base64'));
      await page.evaluate(() => window.fixture.failNextStickerSet = true);
      await login(page);
      await page.getByText('Não foi possível importar todas as figurinhas. As cópias locais foram preservadas.', { exact: true }).waitFor();
      assert.notEqual(await page.evaluate(() => localStorage.getItem('cuppimxas-stickers:tester')), null);
      await page.locator('#sidebar-avatar').click(); await page.locator('#logout-btn').click();
      await login(page);
      await page.waitForFunction(() => Object.keys(window.fixture.read('stickers/tester') || {}).some(key => key.startsWith('imported-')));
      await page.waitForFunction(() => localStorage.getItem('cuppimxas-stickers:tester') === null);
      await page.locator('#sticker-btn').click();
      assert.equal(await page.locator('#custom-sticker-grid .sticker-choice').count(), 1);
      await page.locator('#close-stickers').click();
    });
    await test('Chikito has no automatic owner access and sticker libraries are per account', async () => {
      await page.locator('#sidebar-avatar').click(); await page.locator('#logout-btn').click();
      await login(page, 'rei_chikit0');
      assert.equal(await page.locator('#admin-btn').isVisible(), false);
      await page.locator('#sticker-btn').click();
      assert.equal(await page.locator('#custom-sticker-grid .sticker-choice').count(), 0);
      await page.locator('#close-stickers').click();
      await page.locator('#sidebar-avatar').click(); await page.locator('#logout-btn').click();
      await login(page); await page.locator('#sticker-btn').click();
      assert.equal(await page.locator('#custom-sticker-grid .sticker-choice').count(), 1);
      await page.locator('#close-stickers').click();
    });
    await test('Reply/delete controls stay beside the bubble on desktop', async () => {
      const positions = await page.locator('.msg').evaluateAll(messages => messages.map(msg => {
        const bubble = msg.querySelector('.msg-bubble'), actions = msg.querySelector('.msg-actions');
        const b = bubble.getBoundingClientRect(), a = actions.getBoundingClientRect();
        return { child: actions.parentElement === bubble.parentElement, gap: msg.classList.contains('own') ? b.left - a.right : a.left - b.right, center: Math.abs((a.top + a.bottom - b.top - b.bottom) / 2) };
      }));
      assert.ok(positions.every(p => p.child && p.gap >= 0 && p.gap <= 8 && p.center <= 1));
    });
    await test('Consecutive senders share identity; deletion, sender changes, dates and notices reset groups', async () => {
      await page.evaluate(() => {
        const start = new Date(2030, 0, 1, 23, 59, 53).getTime();
        const rows = [
          ['group-first', { user: 'ana', text: 'Primeira' }],
          ['group-second', { user: 'ana', text: 'Continuação' }],
          ['group-own', { user: 'tester', text: 'Minha mensagem' }],
          ['group-return', { user: 'ana', text: 'Outro grupo' }],
          ['group-notice', { system: true, text: 'Aviso' }],
          ['group-after-notice', { user: 'ana', text: 'Após o aviso' }],
          ['group-before-midnight', { user: 'ana', text: 'Ainda hoje' }],
          ['group-new-day', { user: 'ana', text: 'Novo dia' }]
        ];
        for (const [i, [key, value]] of rows.entries()) window.fixture.write('messages/geral/' + key, { ...value, ts: start + i * 1000 });
      });
      await page.locator('[data-key="group-new-day"]').waitFor();
      for (const key of ['group-second', 'group-before-midnight']) {
        assert.equal(await page.locator(`[data-key="${key}"] .msg-avatar`).isVisible(), false);
        assert.equal(await page.locator(`[data-key="${key}"] .msg-display`).isVisible(), false);
        assert.equal(await page.locator(`[data-key="${key}"] .msg-meta`).isVisible(), false);
      }
      for (const key of ['group-first', 'group-own', 'group-return', 'group-after-notice', 'group-new-day']) {
        assert.equal(await page.locator(`[data-key="${key}"] .msg-avatar`).isVisible(), true);
        assert.equal(await page.locator(`[data-key="${key}"] .msg-meta`).isVisible(), true);
      }
      await page.evaluate(() => window.fixture.write('messages/geral/group-first', null));
      await page.waitForFunction(() => !document.querySelector('[data-key="group-second"]').classList.contains('continuation'));
      assert.equal(await page.locator('[data-key="group-second"] .msg-display').isVisible(), true);
      assert.equal(await page.locator('[data-key="group-second"] .msg-meta').isVisible(), true);
    });
    await test('Controls appear on hover or keyboard focus without moving the bubble', async () => {
      const cdp = await context.newCDPSession(page);
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
      const message = page.locator('.msg').last(), actions = message.locator('.msg-actions');
      await message.scrollIntoViewIfNeeded(); await page.locator('#msg-input').focus(); await page.mouse.move(1, 1);
      await page.waitForFunction(() => getComputedStyle(document.querySelector('.msg:last-child .msg-actions')).opacity === '0');
      const before = await message.locator('.msg-bubble').boundingBox();
      await message.locator('.msg-bubble').hover();
      await page.waitForFunction(() => getComputedStyle(document.querySelector('.msg:last-child .msg-actions')).opacity === '1');
      assert.deepEqual(await message.locator('.msg-bubble').boundingBox(), before);
      await page.mouse.move(1, 1);
      await page.waitForFunction(() => getComputedStyle(document.querySelector('.msg:last-child .msg-actions')).opacity === '0');
      await actions.getByRole('button', { name: 'Responder à mensagem' }).focus();
      await page.waitForFunction(() => getComputedStyle(document.querySelector('.msg:last-child .msg-actions')).opacity === '1');
      await page.locator('#msg-input').focus();
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
      await cdp.detach();
    });
    await test('Background messages trigger sound and popup; initial history, focused chat and self messages stay quiet', async () => {
      await page.evaluate(() => { window.alertFixture.background = false; });
      await page.locator('#notification-btn').click();
      assert.equal(await page.evaluate(() => window.alertFixture.permissionRequests), 1);
      assert.equal(await page.evaluate(() => window.alertFixture.popups.length), 0);
      await page.evaluate(() => {
        window.fixture.write('messages/jogos/quiet', { user: 'ana', text: 'Sem alerta em primeiro plano', ts: Date.now() });
      });
      await page.waitForTimeout(30);
      assert.equal(await page.evaluate(() => window.alertFixture.popups.length), 0);
      await page.evaluate(() => {
        window.alertFixture.background = true;
        window.fixture.write('messages/jogos/incoming', { user: 'ana', display: 'Ana', text: 'Bora jogar?', ts: Date.now() });
      });
      await page.waitForFunction(() => window.alertFixture.popups.length === 1);
      assert.equal(await page.evaluate(() => window.alertFixture.sounds), 2);
      assert.equal(await page.evaluate(() => window.alertFixture.popups[0].title), 'Ana · #jogos');
      const title = await page.title(); assert.match(title, /^\(1\)/);
      await page.evaluate(() => {
        window.fixture.write('messages/jogos/incoming/text', 'Editada');
        window.fixture.write('messages/jogos/self', { user: 'tester', text: 'Minha mensagem', ts: Date.now() });
        window.fixture.write('messages/jogos/system', { system: true, text: 'Aviso', ts: Date.now() });
      });
      await page.waitForTimeout(30);
      assert.equal(await page.evaluate(() => window.alertFixture.popups.length), 1);
      await page.evaluate(() => window.alertFixture.popups[0].onclick());
      assert.equal(await page.locator('#chat-channel-name').textContent(), 'jogos');
      assert.equal(await page.evaluate(() => window.alertFixture.popups[0].closed), true);
      await page.evaluate(() => { window.alertFixture.background = false; window.dispatchEvent(new Event('focus')); });
      await page.locator('#ch-geral').click();
    });
    await test('DM alerts, denied permission and return-to-chat work without duplicate sounds', async () => {
      await page.evaluate(() => {
        window.alertFixture.background = true;
        window.fixture.write('messages/ana__tester/dm-alert', { user: 'ana', text: 'Oi no privado', ts: Date.now() });
      });
      await page.waitForFunction(() => window.alertFixture.popups.length === 2);
      assert.match(await page.evaluate(() => window.alertFixture.popups.at(-1).title), /Mensagem direta/);
      await page.evaluate(() => { window.alertFixture.background = false; window.dispatchEvent(new Event('focus')); });
      assert.equal(await page.evaluate(() => window.alertFixture.popups.every(p => p.closed)), true);
      await page.evaluate(() => {
        window.alertFixture.permission = 'denied'; window.alertFixture.background = true;
        window.fixture.write('messages/geral/denied-alert', { user: 'ana', text: 'Sem popup permitido', ts: Date.now() });
      });
      await page.waitForFunction(() => document.querySelector('[data-key="denied-alert"]'));
      assert.equal(await page.evaluate(() => window.alertFixture.popups.length), 2);
      assert.ok(await page.evaluate(() => window.alertFixture.sounds <= 2));
      await page.evaluate(() => { window.alertFixture.permission = 'granted'; window.alertFixture.background = false; window.dispatchEvent(new Event('focus')); });
    });
    await test('Logout closes popups, stops sound and all watchers; logging back in ignores existing history', async () => {
      await page.evaluate(() => {
        window.alertFixture.background = true;
        window.fixture.write('messages/geral/logout-alert', { user: 'ana', text: 'Alerta antes de sair', ts: Date.now() });
      });
      await page.waitForFunction(() => window.alertFixture.popups.length === 3);
      await page.locator('#sidebar-avatar').click(); await page.locator('#logout-btn').click();
      assert.equal(await page.evaluate(() => window.alertFixture.popups.every(p => p.closed)), true);
      assert.equal(await page.evaluate(() => window.fixture.listeners.size), 0);
      const before = await page.evaluate(() => [window.alertFixture.popups.length, window.alertFixture.sounds]);
      await page.evaluate(() => window.fixture.write('messages/geral/logged-out-alert', { user: 'ana', text: 'Deslogado', ts: Date.now() }));
      await page.waitForTimeout(30);
      assert.deepEqual(await page.evaluate(() => [window.alertFixture.popups.length, window.alertFixture.sounds]), before);
      await login(page);
      assert.deepEqual(await page.evaluate(() => [window.alertFixture.popups.length, window.alertFixture.sounds]), before);
      await page.evaluate(() => { window.alertFixture.background = false; window.dispatchEvent(new Event('focus')); });
      await page.locator('#notification-btn').click();
      assert.equal(await page.locator('#notification-btn').getAttribute('aria-pressed'), 'false');
      await page.evaluate(() => { window.alertFixture.background = true; window.fixture.write('messages/geral/muted-alert', { user: 'ana', text: 'Silenciado', ts: Date.now() }); });
      await page.waitForTimeout(30);
      assert.deepEqual(await page.evaluate(() => [window.alertFixture.popups.length, window.alertFixture.sounds]), before);
      await page.evaluate(() => { window.alertFixture.background = false; window.dispatchEvent(new Event('focus')); });
      await page.locator('#notification-btn').click();
    });
    await page.evaluate(() => {
      // Restore a representative conversation for visual review after the regression fixtures.
      for (const key of Object.keys(window.fixture.data.messages.geral)) if (!key.startsWith('m')) window.fixture.write('messages/geral/' + key, null);
      window.fixture.write('messages/geral/m069/image', null);
      window.fixture.write('messages/geral/visual-sticker', { user: 'ana', display: 'Ana Souza', sticker: { id: 'bora', name: 'BORA!' }, ts: Date.now() });
      document.getElementById('toast').hidden = true;
    });
    await bottom(page);
    await page.screenshot({ path: path.join(root, 'test-results/chat-desktop.png'), animations: 'disabled' });
    await test('Mobile layout fits the viewport, drawer closes, and reply is accessible by touch', async () => {
      await page.setViewportSize({ width: 390, height: 844 }); await bottom(page);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.locator('#mob-toggle').click(); await page.locator('#sidebar.open').waitFor();
      await page.locator('#close-sidebar').click();
      assert.equal(await page.locator('#sidebar').evaluate(el => el.classList.contains('open')), false);
      await page.waitForFunction(() => document.getElementById('sidebar').getBoundingClientRect().right <= 0);
      await page.locator('.msg').last().locator('.msg-bubble').tap();
      await page.locator('.msg').last().getByRole('button', { name: 'Responder à mensagem' }).tap();
      assert.equal(await page.locator('#reply-preview').isVisible(), true);
      await page.locator('#cancel-reply').click();
      const placement = await page.locator('.msg').last().evaluate(msg => {
        const bubble = msg.querySelector('.message-sticker').getBoundingClientRect(), actions = msg.querySelector('.msg-actions').getBoundingClientRect();
        return [actions.left - bubble.right, Math.abs((actions.top + actions.bottom - bubble.top - bubble.bottom) / 2), actions.right <= innerWidth];
      });
      assert.ok(placement[0] >= 0 && placement[0] <= 8 && placement[1] <= 1 && placement[2]);
      await page.screenshot({ path: path.join(root, 'test-results/chat-mobile.png'), animations: 'disabled' });
    });
    assert.deepEqual(errors, [], 'No uncaught browser errors');
    console.log(`\n${passed} browser regression tests passed. No production Firebase writes.`);
  } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
