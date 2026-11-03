const app = document.querySelector('#app');

let state = {
  config: {},
  attendees: [],
  prizes: [],
  winners: [],
  loginDefaults: {},
  checkinUrl: ''
};
let socket;
let activeAdminTab = 'checkins';
let selectedLoginRole = 'admin';
const checkinUiState = {
  visitorId: '',
  initialized: false,
  editing: false,
  name: '',
  avatar: '',
  preview: '',
  file: null,
  preparing: false,
  submitting: false
};
let screenUiState = {
  selectedPrizeId: null
};
let drawState = {
  rolling: false,
  stopping: false,
  scene: null,
  runId: 0,
  prizeId: null,
  count: 1,
  timer: null,
  fxTimer: null,
  candidates: [],
  railTick: 0,
  activeAnimation: 'sphere'
};
let dragState = {
  active: false
};

document.addEventListener('DOMContentLoaded', boot);
window.addEventListener('popstate', render);
window.addEventListener('resize', () => {
  if (drawState.rolling) refreshDrawGeometry(drawState.activeAnimation);
  else if (window.location.pathname === '/screen/checkin') paintAvatarStage();
});

async function boot() {
  await refreshState();
  connectSocket();
  render();
}

async function refreshState() {
  const response = await fetch('/api/state');
  state = await response.json();
}

function connectSocket() {
  socket = io();
  socket.on('state', (nextState) => {
    state = nextState;
    const keepCheckinDraft = window.location.pathname === '/checkin'
      && state.config.checkinMode !== 'wechat' && document.querySelector('#localCheckinForm');
    if (keepCheckinDraft) return;
    if (!drawState.rolling && !dragState.active) render();
  });
  socket.on('checkin:new', showFlyCard);
}

function render() {
  const path = window.location.pathname;
  if (path !== '/screen/checkin') {
    document.querySelectorAll('.fly-card').forEach((card) => card.remove());
  }
  if (path === '/checkin') {
    renderCheckin();
    return;
  }
  if (['/screen', '/screen/checkin', '/screen/lottery'].includes(path)) {
    if (!hasRole('screen')) {
      renderLogin('screen');
      return;
    }
    if (path === '/screen/checkin') renderCheckinScreen();
    else renderScreen();
    return;
  }
  if (path === '/admin') {
    if (!hasRole('admin')) {
      renderLogin('admin');
      return;
    }
    renderAdmin();
    return;
  }
  renderLogin('admin');
}

function hasRole(role) {
  const current = sessionStorage.getItem('lotteryRole');
  if (role === 'screen') return current === 'screen' || current === 'admin';
  return current === 'admin';
}

function navigate(path) {
  window.history.pushState({}, '', path);
  render();
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}

function formatTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('zh-CN', { hour12: false });
}

async function api(path, options = {}) {
  const init = { ...options };
  if (init.body && !(init.body instanceof FormData)) {
    init.headers = { 'Content-Type': 'application/json', ...(init.headers || {}) };
    init.body = JSON.stringify(init.body);
  }
  const response = await fetch(path, init);
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) {
    const message = typeof payload === 'object' ? payload.message : payload;
    throw new Error(message || '请求失败');
  }
  return payload;
}

async function uploadFile(file, kind) {
  const data = new FormData();
  data.append('file', file);
  return api(`/api/upload/${kind}`, { method: 'POST', body: data });
}

function renderLogin(forceRole = selectedLoginRole) {
  selectedLoginRole = forceRole;
  const defaultPassword = selectedLoginRole === 'admin' ? 'admin123' : 'screen123';
  const passwordValue = state.loginDefaults?.[selectedLoginRole] ? defaultPassword : '';
  app.innerHTML = `
    <main class="login-page">
      <section class="login-card">
        <div class="brand-panel">
          <div>
            <div class="brand-mark">签</div>
            <h1>${escapeHtml(state.config.eventTitle || '微信签到抽奖')}</h1>
            <p>${escapeHtml(state.config.subtitle || '扫码签到 · 头像滚动 · 幸运抽奖')}</p>
          </div>
          <p>内网运行 / 大屏互动 / 后台导出</p>
        </div>
        <form class="login-form" id="loginForm">
          <div class="role-switch">
            <button type="button" data-role="admin" class="${selectedLoginRole === 'admin' ? 'active' : ''}">后台</button>
            <button type="button" data-role="screen" class="${selectedLoginRole === 'screen' ? 'active' : ''}">大屏</button>
          </div>
          <label>
            访问密码
            <input id="loginPassword" type="password" autocomplete="current-password" value="${passwordValue}" placeholder="请输入访问密码" />
          </label>
          <button type="submit">进入${selectedLoginRole === 'admin' ? '后台' : '大屏'}</button>
          <div class="error-text" id="loginError"></div>
        </form>
      </section>
    </main>
  `;
  document.querySelectorAll('[data-role]').forEach((button) => {
    button.addEventListener('click', () => renderLogin(button.dataset.role));
  });
  document.querySelector('#loginForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const error = document.querySelector('#loginError');
    error.textContent = '';
    try {
      const result = await api('/api/login', {
        method: 'POST',
        body: { role: selectedLoginRole, password: document.querySelector('#loginPassword').value }
      });
      sessionStorage.setItem('lotteryRole', result.role);
      const screenPath = ['/screen', '/screen/checkin', '/screen/lottery'].includes(location.pathname)
        ? location.pathname : '/screen/checkin';
      navigate(result.role === 'screen' ? screenPath : result.path);
    } catch (err) {
      error.textContent = err.message;
    }
  });
}

function renderCheckin() {
  if (state.config.checkinMode !== 'wechat') {
    renderLocalCheckin();
    return;
  }
  const params = new URLSearchParams(window.location.search);
  const isWechat = /MicroMessenger/i.test(navigator.userAgent);
  const attendee = state.attendees.find((item) => item.id === params.get('attendee'));
  if (params.get('checked') === '1') {
    renderCheckinSuccess(attendee || {
      name: '微信用户',
      nickname: '微信用户',
      avatar: makeAvatarDataUrl('微信')
    });
    return;
  }
  const wechat = state.wechat || {};
  if (wechat.ready) {
    app.innerHTML = `
      <main class="checkin-page">
        <section class="checkin-card success-state">
          <div class="brand-mark">微</div>
          <h1 class="mobile-title">微信授权签到</h1>
          <p class="mobile-copy">${isWechat ? '正在打开微信授权，完成后自动签到。' : '请用微信扫码打开此页面完成自动签到。'}</p>
          <a class="button-link" href="/wechat/oauth/start">打开微信授权</a>
        </section>
      </main>
    `;
    if (isWechat) window.location.replace('/wechat/oauth/start');
    return;
  }
  const setupLine = wechat.needsPublicUrl
    ? '还缺 PUBLIC_URL，请使用公网 HTTPS 域名作为微信网页授权回调地址。'
    : '还没有配置微信公众号 AppID 和 AppSecret。';
  app.innerHTML = `
    <main class="checkin-page">
      <section class="checkin-card success-state">
        <div>
          <div class="brand-mark">微</div>
          <h1 class="mobile-title">微信授权未配置</h1>
          <p class="mobile-copy">${escapeHtml(setupLine)}</p>
        </div>
        <p class="mobile-copy">配置完成后，来宾扫码无需填写资料，会直接获取微信昵称和头像进入签到名单。</p>
      </section>
    </main>
  `;
}

function renderLocalCheckin() {
  const visitorId = getVisitorId();
  const attendee = state.attendees.find((item) => item.openid === visitorId);
  if (attendee && !checkinUiState.editing) {
    renderCheckinSuccess(attendee, true);
    return;
  }
  if (!checkinUiState.initialized) {
    checkinUiState.name = attendee?.name || '';
    checkinUiState.avatar = attendee?.avatar?.startsWith('/uploads/') ? attendee.avatar : '';
    checkinUiState.initialized = true;
  }
  const preview = checkinUiState.preview || checkinUiState.avatar || makeAvatarDataUrl(checkinUiState.name);
  app.innerHTML = `
    <main class="checkin-page local-checkin-page">
      <section class="checkin-card local-checkin-card">
        <header class="local-checkin-heading">
          <span>来宾签到</span>
          <h1>${escapeHtml(state.config.eventTitle || '欢迎来到活动现场')}</h1>
        </header>
        <form id="localCheckinForm" class="checkin-form">
          <div class="checkin-avatar-field">
            <div class="checkin-avatar-preview">
              <img id="checkinAvatarPreview" src="${escapeHtml(preview)}" alt="签到头像预览" />
              <button id="chooseCheckinAvatar" type="button" aria-label="选择头像" title="选择头像">${screenIcon('camera')}</button>
            </div>
            <input id="checkinAvatarFile" class="checkin-file-input" type="file" accept="image/jpeg,image/png,image/webp,image/gif" aria-label="上传头像" tabindex="-1" />
            <span class="checkin-avatar-label">头像（选填）</span>
            <button id="useNameAvatar" class="checkin-text-button" type="button" ${checkinUiState.preview || checkinUiState.avatar ? '' : 'hidden'}>使用姓名头像</button>
          </div>
          <label for="checkinName">姓名
            <input id="checkinName" name="name" autocomplete="name" maxlength="40" required value="${escapeHtml(checkinUiState.name)}" placeholder="请输入姓名" />
          </label>
          <div id="checkinError" class="error-text" role="alert" aria-live="polite"></div>
          <button id="submitCheckin" type="submit">${screenIcon('check')}<span>${attendee ? '保存资料' : '确认签到'}</span></button>
        </form>
      </section>
    </main>`;
  bindLocalCheckinForm();
  window.lucide?.createIcons();
}

function updateCheckinAvatarPreview() {
  const preview = document.querySelector('#checkinAvatarPreview');
  if (preview) preview.src = checkinUiState.preview || checkinUiState.avatar || makeAvatarDataUrl(checkinUiState.name);
  const reset = document.querySelector('#useNameAvatar');
  if (reset) reset.hidden = !checkinUiState.preview && !checkinUiState.avatar;
}

function updateCheckinBusy() {
  const busy = checkinUiState.preparing || checkinUiState.submitting;
  for (const selector of ['#submitCheckin', '#chooseCheckinAvatar', '#checkinAvatarFile', '#useNameAvatar']) {
    const element = document.querySelector(selector);
    if (element) element.disabled = busy;
  }
  const name = document.querySelector('#checkinName');
  if (name) name.disabled = checkinUiState.submitting;
  const button = document.querySelector('#submitCheckin span');
  if (button) button.textContent = checkinUiState.submitting ? '正在提交' : checkinUiState.preparing ? '正在处理头像' : checkinUiState.editing ? '保存资料' : '确认签到';
  document.querySelector('#localCheckinForm')?.setAttribute('aria-busy', String(busy));
}

function clearCheckinPreview() {
  if (checkinUiState.preview) URL.revokeObjectURL(checkinUiState.preview);
  checkinUiState.preview = '';
}

async function prepareCheckinAvatar(file) {
  if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type)) {
    throw new Error('请选择 JPG、PNG、WebP 或 GIF 图片');
  }
  if (file.size > 12 * 1024 * 1024) throw new Error('照片不能超过 12 MB');
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error('无法读取这张照片，请重新选择'));
      element.src = url;
    });
    const side = Math.min(image.naturalWidth, image.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = Math.min(512, side);
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    if (!blob) throw new Error('照片处理失败，请重新选择');
    return new File([blob], 'avatar.jpg', { type: 'image/jpeg' });
  } finally {
    URL.revokeObjectURL(url);
  }
}

function bindLocalCheckinForm() {
  const fileInput = document.querySelector('#checkinAvatarFile');
  document.querySelector('#chooseCheckinAvatar').addEventListener('click', () => fileInput.click());
  document.querySelector('#checkinName').addEventListener('input', (event) => {
    checkinUiState.name = event.target.value;
    document.querySelector('#checkinError').textContent = '';
    updateCheckinAvatarPreview();
  });
  document.querySelector('#useNameAvatar').addEventListener('click', () => {
    clearCheckinPreview();
    checkinUiState.avatar = '';
    checkinUiState.file = null;
    fileInput.value = '';
    document.querySelector('#checkinError').textContent = '';
    updateCheckinAvatarPreview();
  });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    checkinUiState.preparing = true;
    updateCheckinBusy();
    const error = document.querySelector('#checkinError');
    error.textContent = '';
    try {
      const prepared = await prepareCheckinAvatar(file);
      clearCheckinPreview();
      checkinUiState.file = prepared;
      checkinUiState.avatar = '';
      checkinUiState.preview = URL.createObjectURL(prepared);
      updateCheckinAvatarPreview();
    } catch (err) {
      error.textContent = err.message;
    } finally {
      checkinUiState.preparing = false;
      fileInput.value = '';
      updateCheckinBusy();
    }
  });
  document.querySelector('#localCheckinForm').addEventListener('submit', submitLocalCheckin);
}

async function submitLocalCheckin(event) {
  event.preventDefault();
  if (checkinUiState.submitting || checkinUiState.preparing) return;
  const name = checkinUiState.name.replace(/\s+/g, ' ').trim();
  const error = document.querySelector('#checkinError');
  error.textContent = '';
  if (!name) {
    error.textContent = '请填写姓名';
    document.querySelector('#checkinName').focus();
    return;
  }
  checkinUiState.submitting = true;
  updateCheckinBusy();
  try {
    if (checkinUiState.file) {
      const data = new FormData();
      data.append('file', checkinUiState.file);
      const uploaded = await api('/api/checkin/avatar', { method: 'POST', body: data });
      checkinUiState.avatar = uploaded.url;
      checkinUiState.file = null;
    }
    const result = await api('/api/checkin', {
      method: 'POST',
      body: { visitorId: getVisitorId(), name, avatar: checkinUiState.avatar, source: 'local-form' }
    });
    const index = state.attendees.findIndex((item) => item.id === result.attendee.id);
    if (index < 0) state.attendees.push(result.attendee);
    else state.attendees[index] = result.attendee;
    checkinUiState.editing = false;
    clearCheckinPreview();
    renderLocalCheckin();
  } catch (err) {
    error.textContent = err.message;
  } finally {
    checkinUiState.submitting = false;
    updateCheckinBusy();
  }
}

function renderCheckinSuccess(attendee, local = false) {
  app.innerHTML = `
    <main class="checkin-page ${local ? 'local-checkin-page' : ''}">
      <section class="checkin-card success-state ${local ? 'local-checkin-card' : ''}">
        <img class="rolling-avatar" src="${escapeHtml(attendee.avatar || makeAvatarDataUrl(attendee.name))}" alt="" />
        <h1 class="mobile-title">签到成功</h1>
        <p class="mobile-copy checkin-success-name">${escapeHtml(attendee.name)}，祝你好运</p>
        ${local ? '<button id="editCheckin" class="checkin-text-button" type="button">修改资料</button>' : ''}
      </section>
    </main>
  `;
  if (local) {
    document.querySelector('#editCheckin').addEventListener('click', () => {
      checkinUiState.initialized = true;
      checkinUiState.editing = true;
      checkinUiState.name = attendee.name;
      checkinUiState.avatar = attendee.avatar?.startsWith('/uploads/') ? attendee.avatar : '';
      renderLocalCheckin();
    });
  }
}

function getVisitorId(openid) {
  if (!openid && checkinUiState.visitorId) return checkinUiState.visitorId;
  let visitorId = openid;
  try {
    visitorId ||= localStorage.getItem('wechatLotteryVisitorId');
  } catch { /* Private webviews may disable storage. */ }
  visitorId ||= `visitor-${cryptoRandom()}`;
  checkinUiState.visitorId = visitorId;
  try {
    localStorage.setItem('wechatLotteryVisitorId', visitorId);
  } catch { /* Keep a stable identity for this page session. */ }
  return visitorId;
}

function cryptoRandom() {
  const bytes = new Uint8Array(12);
  window.crypto.getRandomValues(bytes);
  return Array.from(bytes, (item) => item.toString(16).padStart(2, '0')).join('');
}

function makeAvatarDataUrl(seed) {
  const colors = ['#b91c1c', '#0f766e', '#1d4ed8', '#a16207', '#be185d', '#6d28d9'];
  const text = String(seed || '嘉宾').trim().slice(-2);
  const color = colors[Math.abs(hashCode(text)) % colors.length];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" rx="80" fill="${color}"/><circle cx="118" cy="30" r="46" fill="#f4c762" opacity=".65"/><text x="80" y="96" text-anchor="middle" font-size="48" fill="#fff" font-family="Arial, sans-serif" font-weight="700">${escapeHtml(text)}</text></svg>`;
  return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
}

function hashCode(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return hash;
}

function screenIcon(name) {
  return `<i data-lucide="${name}" aria-hidden="true"></i>`;
}

function renderScreenBrand() {
  const config = state.config || {};
  const x = clampScreenPosition(config.logoPosition?.x, 32, 190, 'x');
  const y = clampScreenPosition(config.logoPosition?.y, 24, 82, 'y');
  return `<div class="draggable screen-logo" data-drag-key="logoPosition" aria-label="可拖动活动 Logo" title="按住拖动 Logo" style="left:${x}px; top:${y}px;">
    ${config.logoUrl ? `<img src="${escapeHtml(config.logoUrl)}" alt="活动 Logo" />` : '<div class="brand-mark">签</div><strong>活动现场</strong>'}
  </div>`;
}

function renderScreenToolbar(mode) {
  return `<footer class="screen-toolbar">
    <nav class="screen-page-switch" aria-label="大屏页面">
      <a href="/screen/checkin" data-screen-path="/screen/checkin" ${mode === 'checkin' ? 'aria-current="page"' : ''}>${screenIcon('scan-line')}签到展示</a>
      <a href="/screen/lottery" data-screen-path="/screen/lottery" ${mode === 'lottery' ? 'aria-current="page"' : ''}>${screenIcon('gift')}幸运抽奖</a>
    </nav>
    <div class="screen-tools">
      ${mode === 'checkin' ? `<button class="ghost icon-button" id="shapeButton" aria-label="切换头像墙" title="切换头像墙">${screenIcon('layout-grid')}</button>` : ''}
      <button class="ghost icon-button" id="fullscreenButton" aria-label="全屏" title="全屏">${screenIcon('maximize')}</button>
      <button class="ghost icon-button" id="musicButton" aria-label="音乐" title="音乐" ${state.config.musicUrl ? '' : 'disabled'}>${screenIcon('music-2')}</button>
      <button class="ghost icon-button" id="backAdminButton" aria-label="后台" title="后台">${screenIcon('settings')}</button>
    </div>
  </footer>`;
}

function renderCheckinScreen() {
  disposeDrawScene();
  const config = state.config || {};
  const qrSize = clampQrSize(config.qrSize || 106);
  const qrX = clampScreenPosition(config.qrPosition?.x, Math.max(window.innerWidth - qrSize - 16, 36), qrSize + 10, 'x');
  const qrY = clampScreenPosition(config.qrPosition?.y, 28, qrSize + 46, 'y');
  const recent = state.attendees.slice(-6).reverse();
  app.innerHTML = `
    <main class="screen-page checkin-display-page">
      ${renderScreenBrand()}
      <div class="draggable qr-card" data-drag-key="qrPosition" aria-label="可拖动签到二维码" title="按住拖动二维码，拖右下角可缩放" style="right:auto; left:${qrX}px; top:${qrY}px; --qr-size:${qrSize}px;">
        <img draggable="false" src="/api/qrcode.svg?target=${encodeURIComponent(state.checkinUrl || `${location.origin}/checkin`)}" alt="签到二维码" />
        <strong>微信扫码签到</strong>
        <button class="qr-resize-handle" type="button" aria-label="拖动缩放二维码" title="拖动缩放"></button>
        <div class="qr-size-controls" aria-label="二维码大小调整">
          <button class="qr-size-step" type="button" data-qr-size-delta="-24" aria-label="缩小二维码">-</button>
          <button class="qr-size-step" type="button" data-qr-size-delta="24" aria-label="放大二维码">+</button>
        </div>
      </div>
      ${config.musicUrl ? `<audio id="screenAudio" src="${escapeHtml(config.musicUrl)}" loop></audio>` : ''}
      <div class="screen-content checkin-display-content">
        <header class="screen-title checkin-display-title">
          <span class="screen-section-label">现场签到</span>
          <h1>${escapeHtml(config.eventTitle || '微信签到抽奖活动')}</h1>
          <div class="checkin-total" aria-live="polite">已签到 <strong>${state.attendees.length}</strong> 位</div>
        </header>
        <section class="checkin-display-wall" aria-label="签到头像墙">
          <div id="avatarStage" class="avatar-stage ${escapeHtml(config.wallMode || 'sphere')}"></div>
        </section>
        <section class="recent-checkins" aria-label="最近签到">
          <h2>最近签到</h2>
          <div class="recent-checkin-list">${recent.length ? recent.map((attendee) => `
            <div class="recent-checkin-item">
              <img src="${escapeHtml(attendee.avatar || makeAvatarDataUrl(attendee.name))}" alt="" />
              <strong>${escapeHtml(attendee.name || attendee.nickname || '微信嘉宾')}</strong>
            </div>`).join('') : '<span class="checkin-waiting">等待嘉宾入场</span>'}
          </div>
        </section>
        ${renderScreenToolbar('checkin')}
      </div>
    </main>`;
  paintAvatarStage();
  bindScreenEvents();
  bindDrag();
  bindQrResize();
  window.lucide?.createIcons();
}

function renderScreen() {
  disposeDrawScene();
  const config = state.config || {};
  const selectedPrize = getSelectedScreenPrize();
  const selectedWinners = selectedPrize ? state.winners.filter((winner) => winner.prizeId === selectedPrize.id) : [];
  const selectedQuantity = Math.max(0, Number(selectedPrize?.quantity || 0));
  const selectedRemaining = Math.max(0, selectedQuantity - selectedWinners.length);
  const selectedDrawCount = Math.max(1, Math.min(Number(selectedPrize?.drawCount || 1), selectedRemaining || 1));
  const prizeOptions = state.prizes.map((prize) => `<option value="${escapeHtml(prize.id)}" ${prize.id === selectedPrize?.id ? 'selected' : ''}>${escapeHtml(prize.name)}</option>`).join('');
  app.innerHTML = `
    <main class="screen-page lottery-display-page">
      <div class="screen-tech-lines" aria-hidden="true"><i></i><i></i><i></i></div>
      ${renderScreenBrand()}
      ${config.musicUrl ? `<audio id="screenAudio" src="${escapeHtml(config.musicUrl)}" loop></audio>` : ''}
      <button id="drawStopButton" class="draw-stop-button" type="button">
        ${screenIcon('square')}
        <strong>停止抽奖</strong>
      </button>
      <div id="drawLiveStatus" class="draw-live-status" role="status" aria-live="polite"></div>
      <div class="screen-content">
        <header class="screen-title">
          <h1>${escapeHtml(config.eventTitle || '微信签到抽奖活动')}</h1>
          <p>${escapeHtml(config.subtitle || '扫码签到 · 头像滚动 · 幸运抽奖')}</p>
        </header>
        <section class="screen-main">
          <section class="lottery-panel">
            <div class="panel-ribbon">
              <h2>幸运抽奖</h2>
            </div>
            <div class="active-prize-name">${escapeHtml(selectedPrize?.name || '请创建奖项')}</div>
            <div class="gift-stage">
              <button id="previousPrizeButton" class="gift-arrow" type="button" aria-label="上一个奖项" title="上一个奖项" ${state.prizes.length > 1 ? '' : 'disabled'}>${screenIcon('chevron-left')}</button>
              <div class="gift-visual" aria-hidden="true">
                <div class="gift-rays"></div>
                <div class="gift-particles"></div>
                ${selectedPrize?.imageUrl ? `
                  <div class="prize-artwork"><img src="${escapeHtml(selectedPrize.imageUrl)}" alt="" /></div>
                ` : `
                  <div class="gift-box">
                    <div class="gift-lid"></div>
                    <div class="gift-body"></div>
                    <div class="gift-bow"></div>
                  </div>
                `}
              </div>
              <button id="nextPrizeButton" class="gift-arrow" type="button" aria-label="下一个奖项" title="下一个奖项" ${state.prizes.length > 1 ? '' : 'disabled'}>${screenIcon('chevron-right')}</button>
            </div>
            <div class="prize-summary">
              <strong>${escapeHtml(selectedPrize?.name || '暂无奖项')}</strong>
              <span>${selectedPrize ? `共 ${selectedQuantity} 份 · 剩余 ${selectedRemaining} 份` : '请先在后台添加奖项'}</span>
            </div>
            <div class="lottery-meta">参与人数：${state.attendees.length}</div>
            <div class="draw-actions">
              <select id="screenPrize" class="screen-prize-select" aria-label="当前奖项">${prizeOptions}</select>
              <div class="draw-count-control">
                <button type="button" data-draw-count-delta="-1" aria-label="减少抽取人数" title="减少抽取人数">${screenIcon('minus')}</button>
                <input id="screenCount" type="number" min="1" max="${Math.max(1, selectedRemaining)}" value="${selectedDrawCount}" aria-label="本次抽取人数" readonly />
                <button type="button" data-draw-count-delta="1" aria-label="增加抽取人数" title="增加抽取人数">${screenIcon('plus')}</button>
              </div>
              <button id="drawButton" ${availableCandidates().length && selectedPrize && selectedRemaining ? '' : 'disabled'}>${screenIcon('play')}${selectedPrize && !selectedRemaining ? '本奖项已抽完' : '开始抽奖'}</button>
            </div>
          </section>
          <section class="winner-panel">
            <div class="panel-ribbon panel-ribbon-wide">
              <h2>抽奖结果</h2>
              <span>${escapeHtml(selectedPrize?.name || '暂无奖项')} · ${selectedWinners.length} 位</span>
            </div>
            <div class="winner-stage">
              <div id="avatarStage" class="avatar-stage" aria-hidden="true"></div>
              <div id="drawFocusRail" class="draw-focus-rail" aria-hidden="true"></div>
              <div id="prizeResults" class="prize-results" aria-label="${escapeHtml(selectedPrize?.name || '')}抽奖结果">${renderPrizeResults(selectedPrize)}</div>
              <button id="openWinnerBookButton" class="winner-book-trigger" type="button">${screenIcon('list')}查看本奖项名单</button>
            </div>
          </section>
        </section>
        ${renderScreenToolbar('lottery')}
      </div>
    </main>
  `;
  bindScreenEvents();
  bindDrag();
  window.lucide?.createIcons();
}

function getSelectedScreenPrize() {
  const prize = state.prizes.find((item) => item.id === screenUiState.selectedPrizeId) || state.prizes[0] || null;
  screenUiState.selectedPrizeId = prize?.id || null;
  return prize;
}

function cycleScreenPrize(direction) {
  if (state.prizes.length < 2 || drawState.rolling) return;
  const currentIndex = Math.max(0, state.prizes.findIndex((item) => item.id === screenUiState.selectedPrizeId));
  const nextIndex = (currentIndex + direction + state.prizes.length) % state.prizes.length;
  screenUiState.selectedPrizeId = state.prizes[nextIndex].id;
  renderScreen();
}

function clampQrSize(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 106;
  return Math.max(88, Math.min(280, Math.round(number)));
}

function clampScreenPosition(value, fallback, elementSize, axis) {
  const number = Number(value);
  const viewport = axis === 'y' ? window.innerHeight : window.innerWidth;
  const max = Math.max(0, viewport - elementSize - 12);
  if (!Number.isFinite(number)) return Math.min(fallback, max);
  return Math.max(0, Math.min(number, max));
}

function winnersForPrize(prizeId) {
  return state.winners.filter((winner) => winner.prizeId === prizeId);
}

function renderPrizeResults(prize) {
  const winners = prize ? winnersForPrize(prize.id) : [];
  if (!winners.length) {
    return `<div class="prize-results-empty">${screenIcon('trophy')}<strong>${prize ? `${escapeHtml(prize.name)} · 等待幸运揭晓` : '暂无奖项'}</strong><span>暂无中奖记录</span></div>`;
  }
  return `<div class="prize-results-grid">${winners.slice().reverse().map((winner, index) => `
    <article class="prize-result" data-winner-id="${escapeHtml(winner.id)}">
      <span class="prize-result-number">${String(winners.length - index).padStart(2, '0')}</span>
      <img src="${escapeHtml(winner.avatar || makeAvatarDataUrl(winner.name))}" alt="" />
      <strong>${escapeHtml(winner.name || winner.nickname || '幸运嘉宾')}</strong>
      <span>${escapeHtml(winner.company || winner.nickname || '')}</span>
    </article>`).join('')}</div>`;
}

function paintAvatarStage(attendeePool = state.attendees) {
  const stage = document.querySelector('#avatarStage');
  if (!stage) return;
  const wallMode = state.config.wallMode || 'sphere';
  const visualMode = getVisualWallMode(wallMode, attendeePool.length);
  stage.classList.remove('sphere', 'wall', 'text', 'orbit');
  stage.classList.add(visualMode);
  const width = Math.max(stage.clientWidth, 320);
  const height = Math.max(stage.clientHeight, 320);
  const wallCapacity = Math.max(24, Math.floor(width / 60) * Math.floor(height / 22));
  const maxVisible = ['sphere', 'orbit'].includes(visualMode) ? 520 : Math.min(180, wallCapacity);
  const attendees = attendeePool.slice(-maxVisible);
  stage.classList.toggle('is-dense', attendees.length >= 36);
  if (!attendees.length) {
    stage.innerHTML = '<div class="empty-stage">等待扫码签到</div>';
    return;
  }
  const avatarSize = getResponsiveAvatarSize(attendees.length, width, height, visualMode);
  stage.style.setProperty('--avatar-size', `${avatarSize}px`);
  stage.style.setProperty('--avatar-node-width', `${Math.max(avatarSize + 12, 56)}px`);
  stage.style.setProperty('--avatar-label-max', `${Math.max(avatarSize + 22, 64)}px`);
  const avoidRect = getStageAvoidRect(stage, width, height);
  const sphereBounds = visualMode === 'sphere' ? getSphereBounds(width, height, avoidRect) : null;
  const orbitBounds = visualMode === 'orbit' ? getOrbitBounds(width, height, avoidRect) : null;
  if (sphereBounds) {
    stage.style.setProperty('--sphere-left', `${sphereBounds.centerX}px`);
    stage.style.setProperty('--sphere-top', `${sphereBounds.centerY}px`);
    stage.style.setProperty('--sphere-diameter', `${sphereBounds.radius * 2}px`);
  } else {
    stage.style.removeProperty('--sphere-left');
    stage.style.removeProperty('--sphere-top');
    stage.style.removeProperty('--sphere-diameter');
  }
  if (orbitBounds) {
    stage.style.setProperty('--orbit-left', `${orbitBounds.centerX}px`);
    stage.style.setProperty('--orbit-top', `${orbitBounds.centerY}px`);
    stage.style.setProperty('--orbit-width', `${orbitBounds.radiusX * 2}px`);
    stage.style.setProperty('--orbit-height', `${orbitBounds.radiusY * 2}px`);
  } else {
    stage.style.removeProperty('--orbit-left');
    stage.style.removeProperty('--orbit-top');
    stage.style.removeProperty('--orbit-width');
    stage.style.removeProperty('--orbit-height');
  }
  const positions = getAvatarPositions(attendees.length, width, height, visualMode, state.config.wallText, avatarSize, avoidRect, sphereBounds, orbitBounds);
  stage.innerHTML = attendees.map((attendee, index) => {
    const position = positions[index] || { x: width / 2, y: height / 2 };
    const sphere = getSphereAvatarPosition(index, attendees.length, width, height);
    const delay = (index % 12) * -0.28;
    return `
      <div class="avatar-node" data-attendee-id="${escapeHtml(attendee.id)}" data-sphere-angle="${sphere.angle}" style="left:${position.x}px; top:${position.y}px; z-index:${position.zIndex || 1}; animation-delay:${delay}s; --sphere-angle:${sphere.angle}deg; --sphere-y:${sphere.y}px; --sphere-radius:${sphere.radius}px; --sphere-scale:${position.scale || sphere.scale}; --sphere-delay:${sphere.delay}s; --sphere-opacity:${position.opacity || 1}; --sphere-blur:${position.blur || 0}px;">
        <img src="${escapeHtml(attendee.avatar || makeAvatarDataUrl(attendee.name))}" alt="" />
        <span>${escapeHtml(attendee.name || attendee.nickname)}</span>
      </div>
    `;
  }).join('');
}

function getVisualWallMode(mode, count) {
  if (mode === 'text' && count >= 36) return 'orbit';
  return ['orbit', 'sphere', 'wall', 'text'].includes(mode) ? mode : 'sphere';
}

function getSphereAvatarPosition(index, count, width, height) {
  const safeCount = Math.max(count, 1);
  const rings = Math.max(4, Math.ceil(Math.sqrt(safeCount)));
  const row = Math.floor((index / safeCount) * rings);
  const rowProgress = rings === 1 ? 0.5 : row / (rings - 1);
  const yUnit = -0.9 + rowProgress * 1.8;
  const radiusUnit = Math.max(0.25, Math.sqrt(Math.max(0, 1 - yUnit * yUnit)));
  const goldenAngle = 137.508;
  const angle = (index * goldenAngle + row * 18) % 360;
  const radius = Math.max(120, Math.min(width, height) * 0.34 * radiusUnit);
  return {
    angle: Math.round(angle * 100) / 100,
    y: Math.round(yUnit * Math.min(height, width) * 0.36),
    radius: Math.round(radius),
    scale: (0.68 + radiusUnit * 0.34).toFixed(2),
    delay: Number((index * -0.08).toFixed(2))
  };
}

function getResponsiveAvatarSize(count, width, height, mode) {
  if (mode === 'orbit') {
    const arena = Math.min(width * 0.78, height * 0.58);
    const tile = Math.sqrt((arena * arena * 0.95) / Math.max(count, 1));
    return Math.max(24, Math.min(40, Math.round(tile)));
  }
  if (mode === 'sphere') {
    const diameter = Math.min(width * 0.72, height * 0.64);
    const tile = Math.sqrt((diameter * diameter * 0.72) / Math.max(count, 1)) * 1.04;
    return Math.max(14, Math.min(28, Math.round(tile)));
  }
  if (mode !== 'wall') return 64;
  const cols = Math.max(1, Math.min(Math.ceil(Math.sqrt(count * 1.35)), Math.floor(width / 60)));
  const rows = Math.max(1, Math.ceil(count / cols));
  const byWidth = Math.floor((width / (cols + 0.5)) * 0.82);
  const byHeight = Math.floor((Math.max(1, height - 104) / rows) * 0.8);
  return Math.max(14, Math.min(64, byWidth, byHeight));
}

function getStageAvoidRect(stage, width, height) {
  const qr = document.querySelector('.qr-card');
  if (!qr) return null;
  const stageRect = stage.getBoundingClientRect();
  const rects = [qr, qr.querySelector('.qr-size-controls')].filter(Boolean).map((item) => item.getBoundingClientRect());
  const qrRect = rects.reduce((acc, rect) => ({
    left: Math.min(acc.left, rect.left),
    top: Math.min(acc.top, rect.top),
    right: Math.max(acc.right, rect.right),
    bottom: Math.max(acc.bottom, rect.bottom)
  }));
  const overlaps = qrRect.right > stageRect.left && qrRect.left < stageRect.right && qrRect.bottom > stageRect.top && qrRect.top < stageRect.bottom;
  if (!overlaps) return null;
  const padding = 10;
  return {
    left: Math.max(0, qrRect.left - stageRect.left - padding),
    top: Math.max(0, qrRect.top - stageRect.top - padding),
    right: Math.min(width, qrRect.right - stageRect.left + padding),
    bottom: Math.min(height, qrRect.bottom - stageRect.top + padding)
  };
}

function getSphereBounds(width, height, avoidRect = null) {
  let radius = Math.min(width * 0.39, height * 0.32);
  let centerX = width * 0.44;
  let centerY = height * 0.47;
  if (avoidRect && avoidRect.top < centerY + radius && avoidRect.left < centerX + radius) {
    radius = Math.min(radius, avoidRect.left - centerX - 18);
  }
  radius = Math.max(126, radius);
  centerX = Math.max(radius + 18, Math.min(width - radius - 18, centerX));
  centerY = Math.max(radius + 18, Math.min(height - radius - 18, centerY));
  return { centerX, centerY, radius };
}

function getOrbitBounds(width, height, avoidRect = null) {
  const bottomReserve = Math.max(136, height * 0.22);
  const bottomLimit = Math.max(height * 0.58, height - bottomReserve);
  let centerX = width * 0.5;
  let centerY = height * 0.43;
  let radiusX = Math.min(width * 0.38, 270);
  let radiusY = Math.min(height * 0.24, 190);
  if (avoidRect && avoidRect.top < centerY && avoidRect.left < centerX + radiusX) {
    centerX = Math.max(width * 0.42, Math.min(centerX, avoidRect.left - radiusX * 0.28));
  }
  centerX = Math.max(radiusX + 28, Math.min(width - radiusX - 28, centerX));
  radiusY = Math.min(radiusY, Math.max(96, bottomLimit - centerY - 22));
  centerY = Math.max(radiusY + 34, Math.min(bottomLimit - radiusY, centerY));
  return { centerX, centerY, radiusX, radiusY };
}

function getAvatarPositions(count, width, height, mode, text, avatarSize = 64, avoidRect = null, sphereBounds = null, orbitBounds = null) {
  if (mode === 'orbit') return orbitPositions(count, width, height, avatarSize, avoidRect, orbitBounds);
  if (mode === 'wall') return gridPositions(count, width, height, avatarSize, avoidRect);
  if (mode === 'sphere') return spherePositions(count, width, height, avatarSize, avoidRect, sphereBounds);
  if (mode === 'text') return textPositions(count, width, height, text || 'LUCKY');
  const positions = [];
  const centerX = width * 0.48;
  const centerY = height * 0.52;
  const radiusX = width * 0.34;
  const radiusY = height * 0.34;
  for (let index = 0; index < count; index += 1) {
    const angle = (index / count) * Math.PI * 2;
    const ring = 0.46 + ((index % 5) / 5) * 0.54;
    positions.push({
      x: centerX + Math.cos(angle) * radiusX * ring,
      y: centerY + Math.sin(angle * 1.35) * radiusY * ring
    });
  }
  return positions;
}

function orbitPositions(count, width, height, avatarSize = 32, avoidRect = null, orbitBounds = null) {
  const { centerX, centerY, radiusX, radiusY } = orbitBounds || getOrbitBounds(width, height, avoidRect);
  const ringCount = Math.max(3, Math.min(5, Math.ceil(Math.sqrt(Math.max(count, 1)) / 2)));
  const weightTotal = (ringCount * (ringCount + 1)) / 2;
  const ringCounts = Array.from({ length: ringCount }, (_, index) => Math.max(1, Math.round((count * (index + 1)) / weightTotal)));
  let diff = count - ringCounts.reduce((sum, value) => sum + value, 0);
  while (diff !== 0) {
    const target = diff > 0 ? ringCounts.length - 1 : ringCounts.indexOf(Math.max(...ringCounts));
    ringCounts[target] += diff > 0 ? 1 : -1;
    diff += diff > 0 ? -1 : 1;
  }
  const positions = [];
  ringCounts.forEach((amount, ringIndex) => {
    const progress = (ringIndex + 1) / ringCount;
    const rx = radiusX * (0.24 + progress * 0.76);
    const ry = radiusY * (0.18 + progress * 0.82);
    const phase = ringIndex * 0.42;
    for (let index = 0; index < amount && positions.length < count; index += 1) {
      const angle = ((index / amount) * Math.PI * 2) + phase;
      const depth = (Math.sin(angle) + 1) / 2;
      positions.push({
        x: centerX + Math.cos(angle) * rx,
        y: centerY + Math.sin(angle) * ry + depth * 18 - 8,
        scale: (0.72 + progress * 0.14 + depth * 0.18).toFixed(2),
        opacity: (0.56 + progress * 0.16 + depth * 0.22).toFixed(2),
        blur: depth < 0.18 ? 0.25 : 0,
        zIndex: 10 + ringIndex * 8 + Math.round(depth * 56)
      });
    }
  });
  return positions;
}

function spherePositions(count, width, height, avatarSize = 18, avoidRect = null, sphereBounds = null) {
  const { centerX, centerY, radius } = sphereBounds || getSphereBounds(width, height, avoidRect);
  let rows = Math.max(14, Math.ceil(Math.sqrt(count) * 0.95));
  let cols = Math.max(14, Math.ceil(rows * 1.06));
  let candidates = [];
  const buildCandidates = () => {
    const list = [];
    for (let row = 0; row < rows; row += 1) {
      const ny = rows === 1 ? 0 : -1 + (2 * row) / (rows - 1);
      for (let col = 0; col < cols; col += 1) {
        const nx = cols === 1 ? 0 : -1 + (2 * col) / (cols - 1);
        const normalized = nx * nx + ny * ny;
        if (normalized > 1) continue;
        const z = Math.sqrt(1 - normalized);
        const sideShade = 0.88 + z * 0.16;
        list.push({
          x: centerX + nx * radius * sideShade,
          y: centerY + ny * radius,
          scale: (0.62 + z * 0.5).toFixed(2),
          opacity: (0.34 + z * 0.6).toFixed(2),
          blur: z < 0.32 ? 0.35 : 0,
          zIndex: 10 + Math.round(z * 70)
        });
      }
    }
    return list;
  };
  while (candidates.length < count) {
    candidates = buildCandidates();
    if (candidates.length >= count) break;
    rows += 2;
    cols += 2;
  }
  candidates.sort((a, b) => (a.y - b.y) || (a.x - b.x));
  if (candidates.length <= count) return candidates;
  return Array.from({ length: count }, (_, index) => {
    const sourceIndex = count === 1 ? Math.floor(candidates.length / 2) : Math.round((index * (candidates.length - 1)) / (count - 1));
    return candidates[sourceIndex];
  });
}

function gridPositions(count, width, height, avatarSize = 64, avoidRect = null) {
  const idealCols = Math.ceil(Math.sqrt(count * 1.35));
  const maxCols = Math.max(1, Math.floor(width / Math.max(avatarSize + 18, 60)));
  const cols = Math.max(1, Math.min(idealCols, maxCols));
  const nodeWidth = Math.max(avatarSize + 12, 56);
  const nodeHeight = avatarSize + 28;
  const safeX = Math.max(nodeWidth / 2 + 6, 32);
  const safeTop = Math.max(nodeHeight / 2 + 8, 36);
  const safeBottom = Math.max(nodeHeight / 2 + 14, 58);
  const usableW = Math.max(1, width - safeX * 2);
  const usableH = Math.max(1, height - safeTop - safeBottom);
  const intersectsAvoidRect = (x, y) => {
    if (!avoidRect) return false;
    return x + nodeWidth / 2 > avoidRect.left
      && x - nodeWidth / 2 < avoidRect.right
      && y + nodeHeight / 2 > avoidRect.top
      && y - nodeHeight / 2 < avoidRect.bottom;
  };
  const makeCandidates = (rows) => {
    const candidates = [];
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const x = cols === 1 ? width / 2 : safeX + (usableW * col) / (cols - 1);
        const y = rows === 1 ? height / 2 : safeTop + (usableH * row) / (rows - 1);
        if (!intersectsAvoidRect(x, y)) candidates.push({ x, y });
      }
    }
    return candidates;
  };
  let rows = Math.ceil(count / cols);
  let candidates = makeCandidates(rows);
  while (candidates.length < count && rows < count) {
    rows += 1;
    candidates = makeCandidates(rows);
  }
  return candidates.slice(0, count);
}

function textPositions(count, width, height, text) {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  canvas.width = 520;
  canvas.height = 220;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#000';
  context.font = '900 116px Arial, sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(String(text).slice(0, 8), canvas.width / 2, canvas.height / 2);
  const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const points = [];
  for (let y = 14; y < canvas.height; y += 10) {
    for (let x = 12; x < canvas.width; x += 10) {
      if (data[(y * canvas.width + x) * 4 + 3] > 80) points.push({ x, y });
    }
  }
  if (!points.length) return gridPositions(count, width, height);
  return Array.from({ length: count }, (_, index) => {
    const point = points[Math.floor(index * points.length / count) % points.length];
    return {
      x: width * 0.16 + (point.x / canvas.width) * width * 0.66,
      y: height * 0.18 + (point.y / canvas.height) * height * 0.6
    };
  });
}

function bindScreenEvents() {
  document.querySelectorAll('[data-screen-path]').forEach((link) => {
    link.addEventListener('click', (event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      if (!drawState.rolling) navigate(link.dataset.screenPath);
    });
  });
  document.querySelector('#fullscreenButton')?.addEventListener('click', () => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
    else document.exitFullscreen?.();
  });
  document.querySelector('#musicButton')?.addEventListener('click', async () => {
    const audio = document.querySelector('#screenAudio');
    if (!audio) return;
    if (audio.paused) await audio.play();
    else audio.pause();
  });
  document.querySelector('#shapeButton')?.addEventListener('click', async () => {
    const modes = ['orbit', 'sphere', 'wall', 'text'];
    const current = modes.indexOf(state.config.wallMode || 'sphere');
    await api('/api/config', { method: 'PUT', body: { wallMode: modes[(current + 1) % modes.length] } });
  });
  document.querySelector('#backAdminButton')?.addEventListener('click', () => navigate('/admin'));
  document.querySelector('#openWinnerBookButton')?.addEventListener('click', showWinnerBookModal);
  document.querySelector('#previousPrizeButton')?.addEventListener('click', () => cycleScreenPrize(-1));
  document.querySelector('#nextPrizeButton')?.addEventListener('click', () => cycleScreenPrize(1));
  document.querySelector('#screenPrize')?.addEventListener('change', (event) => {
    const prize = state.prizes.find((item) => item.id === event.target.value);
    if (!prize) return;
    screenUiState.selectedPrizeId = prize.id;
    renderScreen();
  });
  document.querySelectorAll('[data-draw-count-delta]').forEach((button) => {
    button.addEventListener('click', () => {
      const input = document.querySelector('#screenCount');
      if (!input) return;
      const minimum = Math.max(1, Number(input.min || 1));
      const maximum = Math.max(minimum, Number(input.max || state.attendees.length || 1));
      const nextValue = Number(input.value || minimum) + Number(button.dataset.drawCountDelta || 0);
      input.value = String(Math.max(minimum, Math.min(maximum, nextValue)));
    });
  });
  document.querySelector('#drawButton')?.addEventListener('click', () => {
    if (drawState.rolling) stopDraw();
    else startDraw();
  });
  document.querySelector('#drawStopButton')?.addEventListener('click', () => {
    if (drawState.rolling) stopDraw();
  });
}

function bindDrag() {
  document.querySelectorAll('[data-drag-key]').forEach((node) => {
    let startX = 0;
    let startY = 0;
    let originX = 0;
    let originY = 0;
    let moved = false;
    let currentPointerId = null;
    node.draggable = false;
    const removeMouseFallback = () => {
      document.removeEventListener('mousemove', mouseMove);
      document.removeEventListener('mouseup', mouseUp);
    };
    const beginDrag = (clientX, clientY) => {
      if (dragState.active) return false;
      dragState.active = true;
      moved = false;
      startX = clientX;
      startY = clientY;
      originX = Number.parseInt(node.style.left, 10) || 0;
      originY = Number.parseInt(node.style.top, 10) || 0;
      node.classList.add('is-dragging');
      return true;
    };
    const moveDrag = (clientX, clientY) => {
      moved = true;
      const x = clampDragCoordinate(originX + clientX - startX, node.offsetWidth, 'x');
      const y = clampDragCoordinate(originY + clientY - startY, node.offsetHeight, 'y');
      node.style.left = `${x}px`;
      node.style.top = `${y}px`;
    };
    const endDrag = async () => {
      if (!dragState.active) return;
      removeMouseFallback();
      node.classList.remove('is-dragging');
      dragState.active = false;
      currentPointerId = null;
      if (!moved) return;
      const key = node.dataset.dragKey;
      await api('/api/config', {
        method: 'PUT',
        body: { [key]: { x: Number.parseInt(node.style.left, 10) || 0, y: Number.parseInt(node.style.top, 10) || 0 } }
      });
    };
    const cancelDrag = () => {
      removeMouseFallback();
      node.classList.remove('is-dragging');
      dragState.active = false;
      currentPointerId = null;
    };
    const mouseMove = (event) => {
      event.preventDefault();
      moveDrag(event.clientX, event.clientY);
    };
    const mouseUp = async (event) => {
      event.preventDefault();
      document.removeEventListener('mousemove', mouseMove);
      document.removeEventListener('mouseup', mouseUp);
      await endDrag();
    };
    node.addEventListener('pointerdown', (event) => {
      if (event.target.closest('.qr-resize-handle')) return;
      event.preventDefault();
      if (!beginDrag(event.clientX, event.clientY)) return;
      currentPointerId = event.pointerId;
      node.setPointerCapture(event.pointerId);
      document.addEventListener('mousemove', mouseMove);
      document.addEventListener('mouseup', mouseUp);
    });
    node.addEventListener('pointermove', (event) => {
      if (currentPointerId !== event.pointerId || !node.hasPointerCapture(event.pointerId)) return;
      moveDrag(event.clientX, event.clientY);
    });
    node.addEventListener('pointerup', async (event) => {
      if (currentPointerId !== event.pointerId || !node.hasPointerCapture(event.pointerId)) return;
      node.releasePointerCapture(event.pointerId);
      await endDrag();
    });
    node.addEventListener('pointercancel', (event) => {
      if (node.hasPointerCapture(event.pointerId)) node.releasePointerCapture(event.pointerId);
      cancelDrag();
    });
    node.addEventListener('mousedown', (event) => {
      if (event.target.closest('.qr-resize-handle')) return;
      if (event.button !== 0 || dragState.active) return;
      event.preventDefault();
      if (!beginDrag(event.clientX, event.clientY)) return;
      document.addEventListener('mousemove', mouseMove);
      document.addEventListener('mouseup', mouseUp);
    });
    node.addEventListener('dragstart', (event) => {
      event.preventDefault();
    });
  });
}

function clampDragCoordinate(value, elementSize, axis) {
  const viewport = axis === 'y' ? window.innerHeight : window.innerWidth;
  const max = Math.max(0, viewport - elementSize - 8);
  return Math.max(0, Math.min(Math.round(value), max));
}

function bindQrResize() {
  const card = document.querySelector('.qr-card');
  const handle = document.querySelector('.qr-resize-handle');
  if (!card || !handle) return;
  let startX = 0;
  let startY = 0;
  let startSize = 0;
  let currentSize = 0;
  let resizing = false;
  const beginResize = (clientX, clientY) => {
    resizing = true;
    dragState.active = true;
    startX = clientX;
    startY = clientY;
    startSize = Number.parseInt(getComputedStyle(card).getPropertyValue('--qr-size'), 10) || card.offsetWidth;
    currentSize = startSize;
    card.classList.add('is-resizing');
  };
  const moveResize = (clientX, clientY) => {
    if (!resizing) return;
    const delta = Math.max(clientX - startX, clientY - startY);
    currentSize = clampQrSize(startSize + delta);
    card.style.setProperty('--qr-size', `${currentSize}px`);
    const nextX = clampDragCoordinate(Number.parseInt(card.style.left, 10) || 0, card.offsetWidth, 'x');
    const nextY = clampDragCoordinate(Number.parseInt(card.style.top, 10) || 0, card.offsetHeight, 'y');
    card.style.left = `${nextX}px`;
    card.style.top = `${nextY}px`;
  };
  const endResize = async () => {
    if (!resizing) return;
    resizing = false;
    dragState.active = false;
    card.classList.remove('is-resizing');
    document.removeEventListener('mousemove', mouseMove);
    document.removeEventListener('mouseup', mouseUp);
    await api('/api/config', {
      method: 'PUT',
      body: {
        qrSize: currentSize,
        qrPosition: {
          x: Number.parseInt(card.style.left, 10) || 0,
          y: Number.parseInt(card.style.top, 10) || 0
        }
      }
    });
  };
  const saveSize = async (nextSize) => {
    const size = clampQrSize(nextSize);
    card.style.setProperty('--qr-size', `${size}px`);
    const nextX = clampDragCoordinate(Number.parseInt(card.style.left, 10) || 0, card.offsetWidth, 'x');
    const nextY = clampDragCoordinate(Number.parseInt(card.style.top, 10) || 0, card.offsetHeight, 'y');
    card.style.left = `${nextX}px`;
    card.style.top = `${nextY}px`;
    await api('/api/config', {
      method: 'PUT',
      body: {
        qrSize: size,
        qrPosition: { x: nextX, y: nextY }
      }
    });
  };
  const mouseMove = (event) => {
    event.preventDefault();
    moveResize(event.clientX, event.clientY);
  };
  const mouseUp = async (event) => {
    event.preventDefault();
    await endResize();
  };
  handle.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    event.stopPropagation();
    beginResize(event.clientX, event.clientY);
    handle.setPointerCapture(event.pointerId);
  });
  handle.addEventListener('pointermove', (event) => {
    if (!handle.hasPointerCapture(event.pointerId)) return;
    moveResize(event.clientX, event.clientY);
  });
  handle.addEventListener('pointerup', async (event) => {
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    await endResize();
  });
  handle.addEventListener('pointercancel', async (event) => {
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    await endResize();
  });
  handle.addEventListener('mousedown', (event) => {
    if (event.button !== 0 || resizing) return;
    event.preventDefault();
    event.stopPropagation();
    beginResize(event.clientX, event.clientY);
    document.addEventListener('mousemove', mouseMove);
    document.addEventListener('mouseup', mouseUp);
  });
  handle.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  document.querySelectorAll('.qr-size-step').forEach((button) => {
    button.addEventListener('pointerdown', (event) => {
      event.stopPropagation();
    });
    button.addEventListener('mousedown', (event) => {
      event.stopPropagation();
    });
    button.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const current = Number.parseInt(getComputedStyle(card).getPropertyValue('--qr-size'), 10) || card.offsetWidth;
      await saveSize(current + Number(button.dataset.qrSizeDelta || 0));
    });
  });
}

function startDraw() {
  if (drawState.rolling || drawState.stopping) return;
  const prizeId = document.querySelector('#screenPrize')?.value;
  if (!prizeId) {
    toast('请先在后台创建奖项');
    return;
  }
  const prize = state.prizes.find((item) => item.id === prizeId);
  const usedCount = state.winners.filter((winner) => winner.prizeId === prizeId).length;
  const remainingCount = Math.max(0, Number(prize?.quantity || 0) - usedCount);
  if (!prize || remainingCount <= 0) {
    showScreenNotice('该奖项已全部发放', prize?.name || '当前奖项', '请切换其他奖项或到后台增加奖项数量');
    return;
  }
  drawState.candidates = availableCandidates();
  if (!drawState.candidates.length) {
    toast('没有可参与抽奖的签到人员');
    return;
  }
  drawState.rolling = true;
  drawState.runId += 1;
  drawState.prizeId = prizeId;
  drawState.count = Math.max(1, Math.min(Number(document.querySelector('#screenCount')?.value) || 1, remainingCount));
  drawState.railTick = 0;
  drawState.activeAnimation = ['orbit', 'sphere', 'wall', 'text'].includes(prize.animation) ? prize.animation : 'sphere';
  setDrawEffects(true, drawState.activeAnimation);
  paintAvatarStage(drawState.candidates);
  startDrawScene(drawState.activeAnimation);
  updateDrawStatus(`${prize.name} · 正在抽取 ${drawState.count} 位幸运嘉宾`);
  const initialAttendee = drawState.candidates[Math.floor(Math.random() * drawState.candidates.length)];
  highlightRollingCandidate(initialAttendee);
  updateDrawFocusRail(initialAttendee);
  drawState.timer = window.setInterval(() => {
    const attendee = drawState.candidates[Math.floor(Math.random() * drawState.candidates.length)];
    highlightRollingCandidate(attendee);
    drawState.railTick += 1;
    if (drawState.railTick % 2 === 0) updateDrawFocusRail(attendee);
  }, 70);
  drawState.fxTimer = window.setInterval(syncSphereDepth, 180);
}

async function stopDraw() {
  if (!drawState.rolling || drawState.stopping) return;
  drawState.stopping = true;
  window.clearInterval(drawState.timer);
  window.clearInterval(drawState.fxTimer);
  const stopButton = document.querySelector('#drawStopButton');
  stopButton.disabled = true;
  stopButton.querySelector('strong').textContent = '正在揭晓';
  document.querySelector('.screen-page')?.classList.add('is-revealing');
  drawState.scene?.pause();
  updateDrawStatus('正在揭晓中奖嘉宾');
  try {
    const result = await api('/api/draw', {
      method: 'POST',
      body: {
        prizeId: drawState.prizeId,
        count: drawState.count
      }
    });
    // Socket updates may arrive before or after the HTTP response.
    const winnerIds = new Set(state.winners.map((winner) => winner.id));
    state.winners.push(...result.winners.filter((winner) => !winnerIds.has(winner.id)));
    screenUiState.selectedPrizeId = result.prize.id;
    drawState.rolling = false;
    drawState.stopping = false;
    renderScreen();
    showWinnerModal(result.prize, result.winners);
  } catch (err) {
    drawState.rolling = false;
    drawState.stopping = false;
    renderScreen();
    toast(err.message);
  }
}

function availableCandidates() {
  if (state.config.allowRepeatWinners) return state.attendees;
  const winnerIds = new Set(state.winners.map((item) => item.attendeeId));
  return state.attendees.filter((attendee) => !winnerIds.has(attendee.id));
}

async function startDrawScene(animation) {
  if (!['sphere', 'orbit'].includes(animation)) return;
  const runId = drawState.runId;
  try {
    const { createLotteryScene } = await import('/lottery-scene.js');
    if (!drawState.rolling || drawState.stopping || runId !== drawState.runId) return;
    const host = document.querySelector('.winner-stage');
    if (!host) return;
    const attendees = drawState.candidates.slice(-180).map((attendee) => ({
      src: attendee.avatar || makeAvatarDataUrl(attendee.name),
      fallback: makeAvatarDataUrl(attendee.name)
    }));
    const scene = createLotteryScene(host, attendees, animation);
    drawState.scene = scene;
    await scene.ready;
    if (drawState.rolling && !drawState.stopping && runId === drawState.runId) {
      document.querySelector('.screen-page')?.classList.add('has-webgl');
    }
  } catch {
    // Keep the CSS avatar animation on devices without WebGL.
    if (runId === drawState.runId) disposeDrawScene();
  }
}

function disposeDrawScene() {
  drawState.scene?.dispose();
  drawState.scene = null;
  drawState.runId += 1;
}

function updateDrawStatus(text) {
  const status = document.querySelector('#drawLiveStatus');
  if (status) status.textContent = text;
}

function setDrawEffects(active, animation = drawState.activeAnimation) {
  const page = document.querySelector('.screen-page');
  const stage = document.querySelector('#avatarStage');
  page?.classList.toggle('is-drawing', active);
  if (page) page.dataset.drawAnimation = active ? animation : '';
  stage?.classList.toggle('drawing', active);
  document.querySelector('.rolling-card')?.classList.toggle('is-rolling', active);
  if (active && stage) {
    window.requestAnimationFrame(() => {
      refreshDrawGeometry(animation);
      syncSphereDepth();
    });
  }
  if (!active) {
    document.querySelectorAll('.avatar-node').forEach((node) => {
      node.classList.remove('draw-hot');
      node.style.removeProperty('opacity');
      node.style.removeProperty('z-index');
    });
    stage?.classList.remove('draw-mode-sphere', 'draw-mode-orbit', 'draw-mode-wall', 'draw-mode-text');
    updateDrawFocusRail(null);
    paintAvatarStage();
  }
}

function refreshDrawGeometry(animation) {
  const stage = document.querySelector('#avatarStage');
  if (!stage) return;
  const nodes = Array.from(stage.querySelectorAll('.avatar-node'));
  const width = Math.max(stage.clientWidth, 280);
  const height = Math.max(stage.clientHeight, 320);
  const mode = ['orbit', 'sphere', 'wall', 'text'].includes(animation) ? animation : 'sphere';
  stage.classList.remove('draw-mode-sphere', 'draw-mode-orbit', 'draw-mode-wall', 'draw-mode-text');
  stage.classList.add(`draw-mode-${mode}`);

  if (mode === 'wall' || mode === 'text') {
    const positions = mode === 'text'
      ? textPositions(nodes.length, width, height, state.config.wallText || 'LUCKY')
      : gridPositions(nodes.length, width * 0.88, height * 0.74, 48).map((position) => ({
          x: position.x + width * 0.06,
          y: position.y + height * 0.12
        }));
    nodes.forEach((node, index) => {
      const position = positions[index] || { x: width / 2, y: height / 2 };
      node.style.setProperty('--draw-x', `${position.x}px`);
      node.style.setProperty('--draw-y', `${position.y}px`);
      node.style.setProperty('--draw-delay', `${(index % 10) * -0.11}s`);
    });
    return;
  }

  nodes.forEach((node, index) => {
    const position = getDrawSpherePosition(index, nodes.length, width, height, mode);
    node.dataset.sphereAngle = String(position.angle);
    node.style.setProperty('--sphere-angle', `${position.angle}deg`);
    node.style.setProperty('--sphere-y', `${position.y}px`);
    node.style.setProperty('--sphere-radius', `${position.radius}px`);
    node.style.setProperty('--sphere-scale', String(position.scale));
    node.style.setProperty('--sphere-delay', `${position.delay}s`);
  });
}

function getDrawSpherePosition(index, count, width, height, mode) {
  const safeCount = Math.max(count, 1);
  const rings = Math.max(6, Math.ceil(Math.sqrt(safeCount)));
  const row = Math.floor((index / safeCount) * rings);
  const progress = rings === 1 ? 0.5 : row / (rings - 1);
  const yUnit = -0.94 + progress * 1.88;
  const ringRadius = Math.max(0.22, Math.sqrt(Math.max(0, 1 - yUnit * yUnit)));
  const angle = (index * 137.508 + row * 21) % 360;
  const baseRadius = mode === 'orbit'
    ? Math.min(width * 0.38, height * 0.42)
    : Math.min(width * 0.34, height * 0.48);
  return {
    angle: Math.round(angle * 100) / 100,
    y: Math.round(yUnit * height * (mode === 'orbit' ? 0.26 : 0.41)),
    radius: Math.round(Math.max(35, baseRadius * ringRadius)),
    scale: (0.72 + ringRadius * 0.34).toFixed(2),
    delay: Number((index * -0.08).toFixed(2))
  };
}

function highlightRollingCandidate(attendee) {
  document.querySelectorAll('.avatar-node.draw-hot').forEach((node) => node.classList.remove('draw-hot'));
  if (!attendee?.id) return;
  const node = document.querySelector(`[data-attendee-id="${CSS.escape(attendee.id)}"]`);
  node?.classList.add('draw-hot');
}

function updateDrawFocusRail(centerAttendee) {
  const rail = document.querySelector('#drawFocusRail');
  if (!rail) return;
  if (!drawState.rolling || !centerAttendee) {
    rail.innerHTML = '';
    return;
  }
  const pool = drawState.candidates.filter((item) => item.id !== centerAttendee.id);
  const sideItems = [];
  const used = new Set([centerAttendee.id]);
  while (pool.length && sideItems.length < 4) {
    const item = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
    if (!used.has(item.id)) {
      used.add(item.id);
      sideItems.push(item);
    }
  }
  const items = [sideItems[0], sideItems[1], centerAttendee, sideItems[2], sideItems[3]].filter(Boolean);
  rail.innerHTML = `
    <div class="focus-rail-inner">
      ${items.map((item) => `
        <div class="focus-card ${item.id === centerAttendee.id ? 'is-active' : ''}">
          <img src="${escapeHtml(item.avatar || makeAvatarDataUrl(item.name))}" alt="" />
          <strong>${escapeHtml(item.name || item.nickname || '幸运嘉宾')}</strong>
        </div>
      `).join('')}
    </div>
  `;
}

function syncSphereDepth() {
  if (!['sphere', 'orbit'].includes(drawState.activeAnimation)) return;
  document.querySelectorAll('.avatar-stage.drawing .avatar-node').forEach((node, index) => {
    const angle = Number(node.dataset.sphereAngle || 0) + (Date.now() / 12000) * 360;
    const z = Math.cos((angle * Math.PI) / 180);
    node.style.zIndex = node.classList.contains('draw-hot') ? '68' : String(8 + Math.round((z + 1) * 24));
    node.style.opacity = String(0.42 + ((z + 1) / 2) * 0.5);
  });
}

function showWinnerModal(prize, winners) {
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <section class="modal winner-modal" role="dialog" aria-modal="true" aria-labelledby="winnerModalTitle">
      <div class="winner-modal-rays"></div>
      <button class="winner-modal-close" type="button" data-close-modal aria-label="关闭中奖名单" title="关闭">${screenIcon('x')}</button>
      <header class="winner-modal-header">
        <span>LUCKY MOMENT</span>
        <h2 id="winnerModalTitle">获奖名单</h2>
        <p>${escapeHtml(prize.name)}</p>
      </header>
      <div class="winner-grid ${winners.length === 1 ? 'is-single' : ''}">
        ${winners.map((winner, index) => `
          <div class="winner-card" style="--winner-delay:${index * 0.08}s">
            <div class="winner-rank">${String(index + 1).padStart(2, '0')}</div>
            <div class="winner-avatar-frame">
              <img src="${escapeHtml(winner.avatar || makeAvatarDataUrl(winner.name))}" alt="" />
            </div>
            <h3>${escapeHtml(winner.name)}</h3>
            <p>${escapeHtml(winner.company || winner.nickname || '')}</p>
            ${winner.fixed ? '<span class="winner-fixed">内定</span>' : ''}
          </div>
        `).join('')}
      </div>
      <div class="winner-modal-actions"><button type="button" data-close-modal>返回抽奖结果</button></div>
    </section>
  `;
  document.body.appendChild(mask);
  mask.querySelectorAll('[data-close-modal]').forEach((button) => button.addEventListener('click', () => mask.remove()));
  window.lucide?.createIcons();
}

function showWinnerBookModal() {
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  const prize = getSelectedScreenPrize();
  const winners = prize ? winnersForPrize(prize.id) : [];
  const prizeGroups = prize ? [{ prize, winners }] : [];
  const total = winners.length;
  mask.innerHTML = `
    <section class="modal winner-book-modal">
      <header class="winner-book-header">
        <span>WINNER LIST</span>
        <h2>${escapeHtml(prize?.name || '当前奖项')}中奖名单</h2>
        <p>已抽中 ${total} 位</p>
      </header>
      <div class="winner-book-content">
        ${total ? prizeGroups.map((group) => `
          <section class="winner-book-section">
            <div class="winner-book-title">
              <strong>${escapeHtml(group.prize.name)}</strong>
              <span>${group.winners.length}/${Number(group.prize.quantity || group.winners.length) || group.winners.length} 位</span>
            </div>
            <div class="winner-book-grid">
              ${group.winners.slice().reverse().map((winner, index) => `
                <div class="winner-book-item">
                  <span class="winner-book-index">${String(group.winners.length - index).padStart(2, '0')}</span>
                  <img src="${escapeHtml(winner.avatar || makeAvatarDataUrl(winner.name))}" alt="" />
                  <div>
                    <strong>${escapeHtml(winner.name || winner.nickname || '幸运嘉宾')}</strong>
                    <span>${escapeHtml(winner.company || winner.nickname || '')}</span>
                  </div>
                </div>
              `).join('')}
            </div>
          </section>
        `).join('') : '<div class="winner-book-empty">暂无中奖记录</div>'}
      </div>
      <div class="winner-modal-actions">
        <button data-close-modal>关闭</button>
      </div>
    </section>
  `;
  document.body.appendChild(mask);
  mask.querySelector('[data-close-modal]').addEventListener('click', () => mask.remove());
}

function showFlyCard(attendee) {
  if (window.location.pathname !== '/screen/checkin' || !hasRole('screen')) return;
  document.querySelector('.fly-card')?.remove();
  const card = document.createElement('div');
  card.className = 'fly-card';
  card.innerHTML = `
    <img class="winner-avatar" src="${escapeHtml(attendee.avatar || makeAvatarDataUrl(attendee.name))}" alt="" />
    <div>
      <strong>${escapeHtml(attendee.name || attendee.nickname)}</strong>
      <span class="muted">${escapeHtml(attendee.company || '已签到')}</span>
    </div>
  `;
  document.body.appendChild(card);
  window.setTimeout(() => card.remove(), 2800);
}

function renderAdmin() {
  const checkinCount = state.attendees.length;
  const winnerCount = state.winners.length;
  const prizeCount = state.prizes.length;
  app.innerHTML = `
    <main class="admin-shell">
      <aside class="admin-sidebar">
        <h1>签到抽奖后台</h1>
        <nav class="admin-nav">
          ${adminTabButton('checkins', '签到管理')}
          ${adminTabButton('prizes', '抽奖设置')}
          ${adminTabButton('settings', '页面设置')}
          ${adminTabButton('exports', '数据导出')}
          <a class="button-link" href="/screen/checkin">签到展示</a>
          <a class="button-link" href="/screen/lottery">抽奖大屏</a>
        </nav>
      </aside>
      <section class="admin-main">
        <header class="admin-header">
          <div>
            <h2>${escapeHtml(state.config.eventTitle || '微信签到抽奖活动')}</h2>
            <p class="muted">${escapeHtml(state.checkinUrl || '')}</p>
          </div>
          <div class="stat-row">
            <div class="stat"><span>已签到</span><strong>${checkinCount}</strong></div>
            <div class="stat"><span>奖项</span><strong>${prizeCount}</strong></div>
            <div class="stat"><span>已中奖</span><strong>${winnerCount}</strong></div>
          </div>
        </header>
        <div id="adminPanel">${renderAdminPanel()}</div>
      </section>
    </main>
  `;
  bindAdminEvents();
}

function adminTabButton(tab, label) {
  return `<button type="button" data-tab="${tab}" class="${activeAdminTab === tab ? 'active' : ''}">${label}</button>`;
}

function renderAdminPanel() {
  if (activeAdminTab === 'prizes') return renderPrizePanel();
  if (activeAdminTab === 'settings') return renderSettingsPanel();
  if (activeAdminTab === 'exports') return renderExportPanel();
  return renderCheckinPanel();
}

function renderCheckinPanel() {
  const rows = state.attendees.slice().reverse().map((attendee, index) => `
    <tr>
      <td class="nowrap">${state.attendees.length - index}</td>
      <td><img class="table-avatar" src="${escapeHtml(attendee.avatar || makeAvatarDataUrl(attendee.name))}" alt="" /></td>
      <td>${escapeHtml(attendee.name)}</td>
      <td>${escapeHtml(attendee.nickname)}</td>
      <td>${escapeHtml(attendee.company)}</td>
      <td>${escapeHtml(attendee.phone)}</td>
      <td>${escapeHtml(formatTime(attendee.checkedInAt))}</td>
      <td><button class="secondary" data-delete-attendee="${escapeHtml(attendee.id)}">删除</button></td>
    </tr>
  `).join('');
  return `
    <section class="panel">
      <div class="panel-title">
        <h2>签到人员</h2>
        <div class="toolbar">
          <button id="seedDemoButton" class="secondary">生成演示签到</button>
          <a class="button-link secondary" href="/api/export/checkins.xlsx">导出签到 Excel</a>
          <button id="resetAttendeesButton" class="danger">清空签到</button>
        </div>
      </div>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th style="width:64px;">序号</th>
              <th style="width:58px;">头像</th>
              <th>姓名</th>
              <th>昵称</th>
              <th>单位</th>
              <th>手机号</th>
              <th>签到时间</th>
              <th style="width:92px;">操作</th>
            </tr>
          </thead>
          <tbody>${rows || '<tr><td colspan="8" class="muted">暂无签到数据</td></tr>'}</tbody>
        </table>
      </div>
    </section>
  `;
}

function renderPrizePanel() {
  const attendeeOptions = state.attendees.map((attendee) => `<option value="${escapeHtml(attendee.id)}">${escapeHtml(attendee.name)} · ${escapeHtml(attendee.company || attendee.phone || '')}</option>`).join('');
  const prizeCards = state.prizes.map((prize) => {
    const winners = state.winners.filter((winner) => winner.prizeId === prize.id).length;
    return `
      <article class="prize-card" data-prize-card="${escapeHtml(prize.id)}">
        <div class="prize-thumb">${prize.imageUrl ? `<img src="${escapeHtml(prize.imageUrl)}" alt="" />` : '奖品'}</div>
        <div class="form-grid">
          <div class="grid-3">
            <label>奖项名称<input class="prize-name" value="${escapeHtml(prize.name)}" /></label>
            <label>总名额<input class="prize-quantity" type="number" min="1" value="${Number(prize.quantity || 1)}" /></label>
            <label>每次抽取<input class="prize-count" type="number" min="1" value="${Number(prize.drawCount || 1)}" /></label>
          </div>
          <div class="grid-2">
            <label>动画方式
              <select class="prize-animation">
                ${modeOption('orbit', '星环排列', prize.animation)}
                ${modeOption('sphere', '球形滚动', prize.animation)}
                ${modeOption('wall', '头像矩阵', prize.animation)}
                ${modeOption('text', '文字造型', prize.animation)}
              </select>
            </label>
            <label>奖品图片<input class="prize-image" type="file" accept="image/*" /></label>
          </div>
          <label>内定人员
            <select class="fixed-select" multiple>
              ${state.attendees.map((attendee) => `<option value="${escapeHtml(attendee.id)}" ${(prize.fixedWinnerIds || []).includes(attendee.id) ? 'selected' : ''}>${escapeHtml(attendee.name)} · ${escapeHtml(attendee.company || attendee.phone || '')}</option>`).join('') || attendeeOptions}
            </select>
          </label>
          <p class="muted">已抽出 ${winners} / ${Number(prize.quantity || 0)}</p>
          <div class="toolbar">
            <button data-save-prize="${escapeHtml(prize.id)}">保存奖项</button>
            <button class="danger" data-delete-prize="${escapeHtml(prize.id)}">删除奖项</button>
          </div>
        </div>
      </article>
    `;
  }).join('');
  return `
    <section class="panel">
      <div class="panel-title"><h2>新增奖项</h2></div>
      <form id="newPrizeForm" class="form-grid">
        <div class="grid-3">
          <label>奖项名称<input name="name" placeholder="例如 一等奖" required /></label>
          <label>总名额<input name="quantity" type="number" min="1" value="1" /></label>
          <label>每次抽取<input name="drawCount" type="number" min="1" value="1" /></label>
        </div>
        <div class="grid-2">
          <label>动画方式
            <select name="animation">
              <option value="orbit">星环排列</option>
              <option value="sphere">球形滚动</option>
              <option value="wall">头像矩阵</option>
              <option value="text">文字造型</option>
            </select>
          </label>
          <label>奖品图片<input name="image" type="file" accept="image/*" /></label>
        </div>
        <div class="toolbar"><button type="submit">新增奖项</button></div>
      </form>
    </section>
    <section class="panel">
      <div class="panel-title"><h2>奖项列表</h2></div>
      <div class="prize-list">${prizeCards || '<p class="muted">暂无奖项</p>'}</div>
    </section>
  `;
}

function modeOption(value, label, current) {
  return `<option value="${value}" ${current === value ? 'selected' : ''}>${label}</option>`;
}

function renderSettingsPanel() {
  const config = state.config || {};
  return `
    <section class="panel">
      <div class="panel-title"><h2>页面设置</h2></div>
      <form id="settingsForm" class="form-grid">
        <div class="grid-2">
          <label>活动标题<input name="eventTitle" value="${escapeHtml(config.eventTitle || '')}" /></label>
          <label>副标题<input name="subtitle" value="${escapeHtml(config.subtitle || '')}" /></label>
        </div>
        <label>签到方式
          <select name="checkinMode" aria-label="签到方式">
            ${modeOption('local', '内网填写姓名与头像', config.checkinMode || 'local')}
            ${modeOption('wechat', '微信网页授权', config.checkinMode)}
          </select>
        </label>
        <div class="grid-3">
          <label>头像墙模式
            <select name="wallMode">
              ${modeOption('orbit', '星环排列', config.wallMode)}
              ${modeOption('sphere', '球形滚动', config.wallMode)}
              ${modeOption('wall', '头像矩阵', config.wallMode)}
              ${modeOption('text', '文字造型', config.wallMode)}
            </select>
          </label>
          <label>文字造型<input name="wallText" maxlength="16" value="${escapeHtml(config.wallText || 'LUCKY')}" /></label>
          <label>主题
            <select name="theme">
              <option value="celebration" ${config.theme === 'celebration' ? 'selected' : ''}>庆典红金</option>
            </select>
          </label>
        </div>
        <div class="grid-2">
          <label>上传 Logo<input name="logo" type="file" accept="image/*" /></label>
          <label>上传背景音乐<input name="music" type="file" accept="audio/*" /></label>
        </div>
        <label>单位下拉预设
          <textarea name="companies">${escapeHtml((config.companies || []).join('\n'))}</textarea>
        </label>
        <div class="grid-2">
          <label>后台新密码<input name="adminPassword" type="password" autocomplete="new-password" /></label>
          <label>大屏新密码<input name="screenPassword" type="password" autocomplete="new-password" /></label>
        </div>
        <label style="display:flex;align-items:center;gap:10px;">
          <input name="allowRepeatWinners" type="checkbox" style="width:18px;min-height:18px;" ${config.allowRepeatWinners ? 'checked' : ''} />
          允许同一人员重复中奖
        </label>
        <div class="toolbar"><button type="submit">保存设置</button></div>
      </form>
    </section>
    <section class="panel">
      <div class="panel-title"><h2>签到二维码</h2></div>
      <div class="grid-2">
        <div><img src="/api/qrcode.svg?target=${encodeURIComponent(state.checkinUrl || `${location.origin}/checkin`)}" alt="签到二维码" style="width:220px;height:220px;background:#fff;padding:10px;border-radius:8px;" /></div>
        <label>签到链接<input readonly value="${escapeHtml(state.checkinUrl || '')}" /></label>
      </div>
    </section>
  `;
}

function renderExportPanel() {
  const rows = state.winners.slice().reverse().map((winner) => `
    <tr>
      <td>${escapeHtml(winner.prizeName)}</td>
      <td>${escapeHtml(winner.name)}</td>
      <td>${escapeHtml(winner.company)}</td>
      <td>${escapeHtml(winner.phone)}</td>
      <td>${winner.fixed ? '是' : '否'}</td>
      <td>${escapeHtml(formatTime(winner.drawnAt))}</td>
      <td><button class="secondary" data-delete-winner="${escapeHtml(winner.id)}">删除</button></td>
    </tr>
  `).join('');
  return `
    <section class="panel">
      <div class="panel-title">
        <h2>数据导出</h2>
        <div class="toolbar">
          <a class="button-link secondary" href="/api/export/checkins.xlsx">导出签到 Excel</a>
          <a class="button-link secondary" href="/api/export/winners.xlsx">导出中奖 Excel</a>
          <button id="resetWinnersButton" class="danger">清空中奖</button>
        </div>
      </div>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>奖项</th>
              <th>姓名</th>
              <th>单位</th>
              <th>手机号</th>
              <th>内定</th>
              <th>中奖时间</th>
              <th style="width:92px;">操作</th>
            </tr>
          </thead>
          <tbody>${rows || '<tr><td colspan="7" class="muted">暂无中奖数据</td></tr>'}</tbody>
        </table>
      </div>
    </section>
  `;
}

function bindAdminEvents() {
  document.querySelectorAll('[data-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      activeAdminTab = button.dataset.tab;
      renderAdmin();
    });
  });
  document.querySelector('#seedDemoButton')?.addEventListener('click', async () => {
    const result = await api('/api/demo/seed', { method: 'POST' });
    toast(`已生成 ${result.count} 位演示签到`);
  });
  document.querySelector('#resetAttendeesButton')?.addEventListener('click', async () => {
    if (!confirm('确认清空签到和中奖数据？')) return;
    await api('/api/reset', { method: 'POST', body: { scope: 'attendees' } });
  });
  document.querySelector('#resetWinnersButton')?.addEventListener('click', async () => {
    if (!confirm('确认清空中奖数据？')) return;
    await api('/api/reset', { method: 'POST', body: { scope: 'winners' } });
  });
  document.querySelectorAll('[data-delete-attendee]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (!confirm('删除该签到人员？')) return;
      await api(`/api/attendees/${button.dataset.deleteAttendee}`, { method: 'DELETE' });
    });
  });
  document.querySelectorAll('[data-delete-winner]').forEach((button) => {
    button.addEventListener('click', async () => {
      await api(`/api/winners/${button.dataset.deleteWinner}`, { method: 'DELETE' });
    });
  });
  document.querySelector('#newPrizeForm')?.addEventListener('submit', saveNewPrize);
  document.querySelectorAll('[data-save-prize]').forEach((button) => {
    button.addEventListener('click', () => savePrize(button.dataset.savePrize));
  });
  document.querySelectorAll('[data-delete-prize]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (!confirm('删除该奖项及相关中奖记录？')) return;
      await api(`/api/prizes/${button.dataset.deletePrize}`, { method: 'DELETE' });
    });
  });
  document.querySelector('#settingsForm')?.addEventListener('submit', saveSettings);
}

async function saveNewPrize(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const imageFile = form.get('image');
  let imageUrl = '';
  if (imageFile && imageFile.size) {
    const uploaded = await uploadFile(imageFile, 'prize');
    imageUrl = uploaded.url;
  }
  await api('/api/prizes', {
    method: 'POST',
    body: {
      name: form.get('name'),
      quantity: form.get('quantity'),
      drawCount: form.get('drawCount'),
      animation: form.get('animation'),
      imageUrl
    }
  });
  toast('奖项已新增');
}

async function savePrize(id) {
  const card = document.querySelector(`[data-prize-card="${CSS.escape(id)}"]`);
  const file = card.querySelector('.prize-image').files[0];
  const current = state.prizes.find((item) => item.id === id);
  let imageUrl = current?.imageUrl || '';
  if (file) {
    const uploaded = await uploadFile(file, 'prize');
    imageUrl = uploaded.url;
  }
  const fixedWinnerIds = Array.from(card.querySelector('.fixed-select').selectedOptions).map((option) => option.value);
  await api(`/api/prizes/${id}`, {
    method: 'PUT',
    body: {
      name: card.querySelector('.prize-name').value,
      quantity: card.querySelector('.prize-quantity').value,
      drawCount: card.querySelector('.prize-count').value,
      animation: card.querySelector('.prize-animation').value,
      imageUrl,
      fixedWinnerIds
    }
  });
  toast('奖项已保存');
}

async function saveSettings(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const logoFile = form.get('logo');
  const musicFile = form.get('music');
  let logoUrl = state.config.logoUrl || '';
  let musicUrl = state.config.musicUrl || '';
  if (logoFile && logoFile.size) logoUrl = (await uploadFile(logoFile, 'logo')).url;
  if (musicFile && musicFile.size) musicUrl = (await uploadFile(musicFile, 'music')).url;
  const body = {
    eventTitle: form.get('eventTitle'),
    subtitle: form.get('subtitle'),
    checkinMode: form.get('checkinMode'),
    wallMode: form.get('wallMode'),
    wallText: form.get('wallText'),
    theme: form.get('theme'),
    logoUrl,
    musicUrl,
    companies: String(form.get('companies') || '').split('\n').map((item) => item.trim()).filter(Boolean),
    allowRepeatWinners: form.get('allowRepeatWinners') === 'on'
  };
  if (form.get('adminPassword')) body.adminPassword = form.get('adminPassword');
  if (form.get('screenPassword')) body.screenPassword = form.get('screenPassword');
  await api('/api/config', { method: 'PUT', body });
  toast('设置已保存');
}

function toast(message) {
  const node = document.createElement('div');
  node.className = 'toast';
  node.textContent = message;
  document.body.appendChild(node);
  window.setTimeout(() => node.remove(), 2400);
}

function showScreenNotice(title, subtitle = '', detail = '') {
  document.querySelector('.screen-notice-mask')?.remove();
  const mask = document.createElement('div');
  mask.className = 'screen-notice-mask';
  mask.innerHTML = `
    <section class="screen-notice">
      <span>${escapeHtml(subtitle)}</span>
      <h2>${escapeHtml(title)}</h2>
      ${detail ? `<p>${escapeHtml(detail)}</p>` : ''}
      <button type="button" data-close-screen-notice>知道了</button>
    </section>
  `;
  document.body.appendChild(mask);
  const close = () => mask.remove();
  mask.querySelector('[data-close-screen-notice]').addEventListener('click', close);
  mask.addEventListener('click', (event) => {
    if (event.target === mask) close();
  });
  window.setTimeout(close, 3600);
}
