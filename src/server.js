import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';
import multer from 'multer';
import QRCode from 'qrcode';
import { Server } from 'socket.io';
import writeExcelFile from 'write-excel-file/node';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const ENV_FILE = path.join(ROOT_DIR, '.env');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const DATA_FILE = path.join(DATA_DIR, 'store.json');
const EXAMPLE_DATA_FILE = path.join(DATA_DIR, 'store.example.json');
const UPLOAD_DIR = path.join(ROOT_DIR, 'assets', 'uploads');
const PUBLIC_DIR = path.join(__dirname, 'public');

loadEnvFile(ENV_FILE);

const PORT = Number(process.env.PORT || 3000);

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(UPLOAD_DIR));
app.use(express.static(PUBLIC_DIR));

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, callback) => {
      const kind = cleanText(req.params.kind || 'file') || 'file';
      const ext = path.extname(file.originalname || '').toLowerCase() || '.bin';
      callback(null, `${kind}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`);
    }
  }),
  limits: { fileSize: 30 * 1024 * 1024 }
});

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(key) || key in process.env) continue;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function loadStore() {
  if (!fs.existsSync(DATA_FILE)) {
    fs.copyFileSync(EXAMPLE_DATA_FILE, DATA_FILE);
  }
  const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  return normalizeStore(parsed);
}

function saveStore(store) {
  fs.writeFileSync(DATA_FILE, `${JSON.stringify(normalizeStore(store), null, 2)}\n`, 'utf8');
}

function normalizeStore(store) {
  const defaults = JSON.parse(fs.readFileSync(EXAMPLE_DATA_FILE, 'utf8'));
  return {
    config: { ...defaults.config, ...(store.config || {}) },
    attendees: Array.isArray(store.attendees) ? store.attendees : [],
    prizes: Array.isArray(store.prizes) ? store.prizes : defaults.prizes,
    winners: Array.isArray(store.winners) ? store.winners : []
  };
}

function cleanText(value, max = 120) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanPhone(value) {
  return String(value ?? '').replace(/[^\d+\-\s]/g, '').trim().slice(0, 32);
}

function safePosition(value, fallback) {
  const x = Number(value?.x);
  const y = Number(value?.y);
  return {
    x: Number.isFinite(x) ? Math.max(0, Math.min(3000, Math.round(x))) : fallback.x,
    y: Number.isFinite(y) ? Math.max(0, Math.min(2000, Math.round(y))) : fallback.y
  };
}

function safeNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function publicConfig(config) {
  const { adminPassword, screenPassword, ...rest } = config;
  return rest;
}

function publicState(req, store = loadStore()) {
  return {
    config: publicConfig(store.config),
    attendees: store.attendees,
    prizes: store.prizes,
    winners: store.winners,
    loginDefaults: {
      admin: store.config.adminPassword === 'admin123',
      screen: store.config.screenPassword === 'screen123'
    },
    checkinUrl: `${baseUrl(req)}/checkin`,
    wechat: wechatOAuthStatus(req)
  };
}

function baseUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  const host = req.get('host');
  if (/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host || '')) {
    const [firstLanUrl] = lanUrls(PORT);
    if (firstLanUrl) return firstLanUrl;
  }
  return `${req.protocol}://${host}`;
}

function emitState(req, eventName, payload) {
  const state = publicState(req);
  io.emit('state', state);
  if (eventName) io.emit(eventName, payload);
}

function isAlreadyWinner(store, attendeeId) {
  return store.winners.some((winner) => winner.attendeeId === attendeeId);
}

function remainingPrizeCount(store, prize) {
  const used = store.winners.filter((winner) => winner.prizeId === prize.id).length;
  return Math.max(0, Number(prize.quantity || 0) - used);
}

function pickRandom(items, count) {
  const pool = [...items];
  const picked = [];
  while (pool.length && picked.length < count) {
    const index = crypto.randomInt(pool.length);
    picked.push(pool.splice(index, 1)[0]);
  }
  return picked;
}

function escapeXml(value) {
  return String(value).replace(/[<>&"']/g, (char) => ({
    '<': '&lt;',
    '>': '&gt;',
    '&': '&amp;',
    '"': '&quot;',
    "'": '&apos;'
  })[char]);
}

function avatarDataUri(name, color) {
  const label = escapeXml((name || '嘉宾').slice(-2));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160"><defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="1"><stop stop-color="${color}"/><stop offset="1" stop-color="#f8d56b"/></linearGradient></defs><rect width="160" height="160" rx="80" fill="url(#g)"/><text x="80" y="94" text-anchor="middle" font-size="48" fill="#fff" font-family="Arial, sans-serif" font-weight="700">${label}</text></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

function getWechatOAuthConfig(req) {
  const publicUrl = cleanText(process.env.PUBLIC_URL, 500).replace(/\/$/, '');
  const appId = cleanText(process.env.WECHAT_APP_ID, 120);
  const appSecret = cleanText(process.env.WECHAT_APP_SECRET, 180);
  const scope = cleanText(process.env.WECHAT_OAUTH_SCOPE, 40) || 'snsapi_userinfo';
  const callbackBaseUrl = publicUrl || baseUrl(req);
  return {
    appId,
    appSecret,
    scope,
    publicUrl,
    callbackUrl: `${callbackBaseUrl}/wechat/oauth/callback`,
    configured: Boolean(appId && appSecret),
    ready: Boolean(appId && appSecret && publicUrl)
  };
}

function wechatOAuthStatus(req) {
  const config = getWechatOAuthConfig(req);
  return {
    configured: config.configured,
    ready: config.ready,
    scope: config.scope,
    callbackUrl: config.callbackUrl,
    needsPublicUrl: config.configured && !config.publicUrl
  };
}

function isWechatBrowser(req) {
  return /MicroMessenger/i.test(req.get('user-agent') || '');
}

function saveWechatAttendee(req, userInfo) {
  const store = loadStore();
  const now = new Date().toISOString();
  const openid = cleanText(userInfo.openid, 160);
  if (!openid) throw new Error('微信授权没有返回 openid');
  const nickname = cleanText(userInfo.nickname, 80) || '微信用户';
  const avatar = cleanText(userInfo.headimgurl, 1000) || avatarDataUri(nickname, '#b91c1c');
  const existing = store.attendees.find((item) => item.openid === openid);
  const attendee = {
    id: existing?.id || crypto.randomUUID(),
    openid,
    nickname,
    avatar,
    name: nickname,
    company: '',
    phone: '',
    source: 'wechat-oauth',
    checkedInAt: existing?.checkedInAt || now,
    updatedAt: existing ? now : undefined
  };
  if (existing) Object.assign(existing, attendee);
  else store.attendees.push(attendee);
  saveStore(store);
  emitState(req, 'checkin:new', existing || attendee);
  return existing || attendee;
}

async function fetchWechatJson(url) {
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok || data.errcode) {
    throw new Error(data.errmsg || `微信接口请求失败：${response.status}`);
  }
  return data;
}

function demoAttendees() {
  const names = ['王一鸣', '李思雨', '张嘉宁', '赵明轩', '陈若琳', '刘宇航', '周可欣', '吴昊然', '孙雅琪', '郑子墨', '许清扬', '何沐辰', '郭诗涵', '林俊熙', '马依诺', '高梓睿', '黄语桐', '唐景行'];
  const companies = ['总部', '市场部', '销售部', '技术部', '合作伙伴'];
  const colors = ['#c91f37', '#0f766e', '#7c3aed', '#d97706', '#2563eb', '#db2777'];
  return names.map((name, index) => ({
    id: crypto.randomUUID(),
    openid: `demo-openid-${index + 1}`,
    nickname: name.slice(0, 1) + '同学',
    avatar: avatarDataUri(name, colors[index % colors.length]),
    name,
    company: companies[index % companies.length],
    phone: `1380000${String(index + 1).padStart(4, '0')}`,
    source: 'demo',
    checkedInAt: new Date(Date.now() - (names.length - index) * 45000).toISOString()
  }));
}

function excelHeader(value) {
  return {
    value,
    fontWeight: 'bold',
    backgroundColor: '#8b1e1e',
    color: '#ffffff',
    align: 'center'
  };
}

async function sendWorkbook(res, filename, rows, columns) {
  const buffer = await writeExcelFile(rows, {
    columns,
    fontFamily: 'Arial',
    fontSize: 11
  }).toBuffer();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.send(buffer);
}

app.get('/api/state', (req, res) => {
  res.json(publicState(req));
});

app.post('/api/login', (req, res) => {
  const store = loadStore();
  const role = req.body.role === 'screen' ? 'screen' : 'admin';
  const expected = role === 'admin' ? store.config.adminPassword : store.config.screenPassword;
  if (cleanText(req.body.password, 80) !== expected) {
    res.status(401).json({ message: '密码不正确' });
    return;
  }
  res.json({ ok: true, role, path: role === 'admin' ? '/admin' : '/screen' });
});

app.get('/api/qrcode.svg', async (req, res, next) => {
  try {
    const target = cleanText(req.query.target, 500) || `${baseUrl(req)}/checkin`;
    const svg = await QRCode.toString(target, {
      type: 'svg',
      width: 420,
      margin: 1,
      errorCorrectionLevel: 'M'
    });
    res.type('image/svg+xml').send(svg);
  } catch (error) {
    next(error);
  }
});

app.get('/wechat/oauth/start', (req, res) => {
  const config = getWechatOAuthConfig(req);
  if (!config.ready) {
    res.redirect('/checkin?wechat=not-ready');
    return;
  }
  const params = new URLSearchParams({
    appid: config.appId,
    redirect_uri: config.callbackUrl,
    response_type: 'code',
    scope: config.scope,
    state: `checkin-${Date.now()}`
  });
  res.redirect(`https://open.weixin.qq.com/connect/oauth2/authorize?${params.toString()}#wechat_redirect`);
});

app.get('/wechat/oauth/callback', async (req, res, next) => {
  try {
    const config = getWechatOAuthConfig(req);
    const code = cleanText(req.query.code, 180);
    if (!config.ready || !code) {
      res.redirect('/checkin?wechat=failed');
      return;
    }
    const tokenParams = new URLSearchParams({
      appid: config.appId,
      secret: config.appSecret,
      code,
      grant_type: 'authorization_code'
    });
    const token = await fetchWechatJson(`https://api.weixin.qq.com/sns/oauth2/access_token?${tokenParams.toString()}`);
    let userInfo = {
      openid: token.openid,
      nickname: '微信用户',
      headimgurl: ''
    };
    if (config.scope === 'snsapi_userinfo') {
      const userParams = new URLSearchParams({
        access_token: token.access_token,
        openid: token.openid,
        lang: 'zh_CN'
      });
      userInfo = await fetchWechatJson(`https://api.weixin.qq.com/sns/userinfo?${userParams.toString()}`);
    }
    const attendee = saveWechatAttendee(req, userInfo);
    res.redirect(`/checkin?checked=1&attendee=${encodeURIComponent(attendee.id)}`);
  } catch (error) {
    next(error);
  }
});

app.get('/checkin', (req, res, next) => {
  const config = getWechatOAuthConfig(req);
  if (!req.query.checked && config.ready && (isWechatBrowser(req) || req.query.oauth === '1')) {
    res.redirect('/wechat/oauth/start');
    return;
  }
  next();
});

app.put('/api/config', (req, res) => {
  const store = loadStore();
  const body = req.body || {};
  const next = { ...store.config };
  if ('eventTitle' in body) next.eventTitle = cleanText(body.eventTitle, 80) || next.eventTitle;
  if ('subtitle' in body) next.subtitle = cleanText(body.subtitle, 120);
  if ('logoUrl' in body) next.logoUrl = cleanText(body.logoUrl, 500);
  if ('musicUrl' in body) next.musicUrl = cleanText(body.musicUrl, 500);
  if ('theme' in body) next.theme = cleanText(body.theme, 40) || 'celebration';
  if ('wallMode' in body) next.wallMode = ['orbit', 'sphere', 'wall', 'text'].includes(body.wallMode) ? body.wallMode : next.wallMode;
  if ('wallText' in body) next.wallText = cleanText(body.wallText, 16) || 'LUCKY';
  if ('allowRepeatWinners' in body) next.allowRepeatWinners = Boolean(body.allowRepeatWinners);
  if ('companies' in body && Array.isArray(body.companies)) {
    next.companies = body.companies.map((item) => cleanText(item, 40)).filter(Boolean).slice(0, 80);
  }
  if ('logoPosition' in body) next.logoPosition = safePosition(body.logoPosition, next.logoPosition);
  if ('qrPosition' in body) next.qrPosition = safePosition(body.qrPosition, next.qrPosition);
  if ('qrSize' in body) next.qrSize = safeNumber(body.qrSize, next.qrSize || 106, 88, 280);
  if (cleanText(body.adminPassword, 80)) next.adminPassword = cleanText(body.adminPassword, 80);
  if (cleanText(body.screenPassword, 80)) next.screenPassword = cleanText(body.screenPassword, 80);
  store.config = next;
  saveStore(store);
  emitState(req, 'config:update', publicConfig(next));
  res.json(publicState(req, store));
});

app.post('/api/upload/:kind', upload.single('file'), (req, res) => {
  if (!req.file) {
    res.status(400).json({ message: '没有收到文件' });
    return;
  }
  res.json({
    url: `/uploads/${req.file.filename}`,
    name: req.file.originalname,
    size: req.file.size
  });
});

app.post('/api/checkin', (req, res) => {
  const store = loadStore();
  const now = new Date().toISOString();
  const body = req.body || {};
  const openid = cleanText(body.openid, 160) || cleanText(body.visitorId, 160) || `local-${crypto.randomUUID()}`;
  const phone = cleanPhone(body.phone);
  const attendee = {
    id: crypto.randomUUID(),
    openid,
    nickname: cleanText(body.nickname, 60) || '微信用户',
    avatar: cleanText(body.avatar, 5000),
    name: cleanText(body.name, 40),
    company: cleanText(body.company, 80),
    phone,
    source: cleanText(body.source, 30) || 'wechat-scan',
    checkedInAt: now
  };
  if (!attendee.name || !attendee.phone) {
    res.status(400).json({ message: '姓名和手机号必填' });
    return;
  }
  const existing = store.attendees.find((item) => item.openid === openid || (phone && item.phone === phone));
  let saved;
  if (existing) {
    Object.assign(existing, attendee, { id: existing.id, checkedInAt: existing.checkedInAt, updatedAt: now });
    saved = existing;
  } else {
    store.attendees.push(attendee);
    saved = attendee;
  }
  saveStore(store);
  emitState(req, 'checkin:new', saved);
  res.json({ ok: true, attendee: saved });
});

app.get('/api/attendees', (req, res) => {
  res.json(loadStore().attendees);
});

app.delete('/api/attendees/:id', (req, res) => {
  const store = loadStore();
  const before = store.attendees.length;
  store.attendees = store.attendees.filter((item) => item.id !== req.params.id);
  store.winners = store.winners.filter((item) => item.attendeeId !== req.params.id);
  saveStore(store);
  emitState(req, 'attendee:delete', { id: req.params.id });
  res.json({ ok: true, removed: before - store.attendees.length });
});

app.post('/api/demo/seed', (req, res) => {
  const store = loadStore();
  const existing = new Set(store.attendees.map((item) => item.openid));
  const additions = demoAttendees().filter((item) => !existing.has(item.openid));
  store.attendees.push(...additions);
  saveStore(store);
  emitState(req, 'demo:seed', { count: additions.length });
  res.json({ ok: true, count: additions.length });
});

app.get('/api/prizes', (req, res) => {
  res.json(loadStore().prizes);
});

app.post('/api/prizes', (req, res) => {
  const store = loadStore();
  const prize = {
    id: crypto.randomUUID(),
    name: cleanText(req.body.name, 80) || '新奖项',
    quantity: Math.max(1, Number.parseInt(req.body.quantity, 10) || 1),
    drawCount: Math.max(1, Number.parseInt(req.body.drawCount, 10) || 1),
    imageUrl: cleanText(req.body.imageUrl, 500),
    animation: ['orbit', 'sphere', 'wall', 'text'].includes(req.body.animation) ? req.body.animation : 'sphere',
    fixedWinnerIds: Array.isArray(req.body.fixedWinnerIds) ? req.body.fixedWinnerIds : []
  };
  store.prizes.push(prize);
  saveStore(store);
  emitState(req, 'prize:create', prize);
  res.json(prize);
});

app.put('/api/prizes/:id', (req, res) => {
  const store = loadStore();
  const prize = store.prizes.find((item) => item.id === req.params.id);
  if (!prize) {
    res.status(404).json({ message: '奖项不存在' });
    return;
  }
  if ('name' in req.body) prize.name = cleanText(req.body.name, 80) || prize.name;
  if ('quantity' in req.body) prize.quantity = Math.max(1, Number.parseInt(req.body.quantity, 10) || prize.quantity);
  if ('drawCount' in req.body) prize.drawCount = Math.max(1, Number.parseInt(req.body.drawCount, 10) || prize.drawCount);
  if ('imageUrl' in req.body) prize.imageUrl = cleanText(req.body.imageUrl, 500);
  if ('animation' in req.body) prize.animation = ['orbit', 'sphere', 'wall', 'text'].includes(req.body.animation) ? req.body.animation : prize.animation;
  if ('fixedWinnerIds' in req.body && Array.isArray(req.body.fixedWinnerIds)) {
    const attendeeIds = new Set(store.attendees.map((item) => item.id));
    prize.fixedWinnerIds = req.body.fixedWinnerIds.filter((id) => attendeeIds.has(id));
  }
  saveStore(store);
  emitState(req, 'prize:update', prize);
  res.json(prize);
});

app.delete('/api/prizes/:id', (req, res) => {
  const store = loadStore();
  store.prizes = store.prizes.filter((item) => item.id !== req.params.id);
  store.winners = store.winners.filter((item) => item.prizeId !== req.params.id);
  saveStore(store);
  emitState(req, 'prize:delete', { id: req.params.id });
  res.json({ ok: true });
});

app.post('/api/draw', (req, res) => {
  const store = loadStore();
  const prize = store.prizes.find((item) => item.id === req.body.prizeId);
  if (!prize) {
    res.status(404).json({ message: '请选择有效奖项' });
    return;
  }
  const remaining = remainingPrizeCount(store, prize);
  if (remaining <= 0) {
    res.status(400).json({ message: '该奖项已全部发放' });
    return;
  }
  const requested = Math.max(1, Number.parseInt(req.body.count, 10) || Number(prize.drawCount) || 1);
  const targetCount = Math.min(requested, remaining);
  const attendees = store.attendees;
  const fixedIds = Array.isArray(prize.fixedWinnerIds) ? prize.fixedWinnerIds : [];
  const fixed = fixedIds
    .map((id) => attendees.find((item) => item.id === id))
    .filter(Boolean)
    .filter((item) => store.config.allowRepeatWinners || !isAlreadyWinner(store, item.id))
    .slice(0, targetCount);
  const fixedSet = new Set(fixed.map((item) => item.id));
  const pool = attendees.filter((item) => {
    if (fixedSet.has(item.id)) return false;
    if (!store.config.allowRepeatWinners && isAlreadyWinner(store, item.id)) return false;
    return true;
  });
  const picked = [...fixed, ...pickRandom(pool, targetCount - fixed.length)];
  if (!picked.length) {
    res.status(400).json({ message: '没有可抽取的签到人员' });
    return;
  }
  const now = new Date().toISOString();
  const winners = picked.map((attendee) => ({
    id: crypto.randomUUID(),
    prizeId: prize.id,
    prizeName: prize.name,
    attendeeId: attendee.id,
    name: attendee.name,
    nickname: attendee.nickname,
    company: attendee.company,
    phone: attendee.phone,
    avatar: attendee.avatar,
    fixed: fixedSet.has(attendee.id),
    drawnAt: now
  }));
  store.winners.push(...winners);
  saveStore(store);
  emitState(req, 'draw:complete', { prize, winners });
  res.json({ prize, winners, remaining: remainingPrizeCount(store, prize) });
});

app.get('/api/winners', (req, res) => {
  res.json(loadStore().winners);
});

app.delete('/api/winners/:id', (req, res) => {
  const store = loadStore();
  store.winners = store.winners.filter((winner) => winner.id !== req.params.id);
  saveStore(store);
  emitState(req, 'winner:delete', { id: req.params.id });
  res.json({ ok: true });
});

app.post('/api/reset', (req, res) => {
  const store = loadStore();
  const scope = req.body.scope;
  if (scope === 'attendees') {
    store.attendees = [];
    store.winners = [];
  } else if (scope === 'winners') {
    store.winners = [];
  } else if (scope === 'all') {
    const fresh = normalizeStore({});
    store.config = { ...fresh.config, adminPassword: store.config.adminPassword, screenPassword: store.config.screenPassword };
    store.attendees = [];
    store.prizes = fresh.prizes;
    store.winners = [];
  } else {
    res.status(400).json({ message: '未知重置范围' });
    return;
  }
  saveStore(store);
  emitState(req, 'state:reset', { scope });
  res.json({ ok: true });
});

app.get('/api/export/checkins.xlsx', async (req, res, next) => {
  try {
    const rows = loadStore().attendees.map((item, index) => ({ index: index + 1, ...item }));
    await sendWorkbook(res, `签到数据-${dateStamp()}.xlsx`, rows, [
      { header: excelHeader('序号'), cell: (row) => ({ value: row.index, type: Number }), width: 8 },
      { header: excelHeader('姓名'), cell: (row) => ({ value: row.name }), width: 16 },
      { header: excelHeader('微信昵称'), cell: (row) => ({ value: row.nickname }), width: 18 },
      { header: excelHeader('所在单位'), cell: (row) => ({ value: row.company }), width: 24 },
      { header: excelHeader('手机号'), cell: (row) => ({ value: row.phone }), width: 18 },
      { header: excelHeader('签到时间'), cell: (row) => ({ value: formatDate(row.checkedInAt) }), width: 22 },
      { header: excelHeader('来源'), cell: (row) => ({ value: row.source }), width: 14 },
      { header: excelHeader('OpenID/访客ID'), cell: (row) => ({ value: row.openid }), width: 28 }
    ]);
  } catch (error) {
    next(error);
  }
});

app.get('/api/export/winners.xlsx', async (req, res, next) => {
  try {
    const rows = loadStore().winners.map((item, index) => ({ index: index + 1, ...item }));
    await sendWorkbook(res, `中奖名单-${dateStamp()}.xlsx`, rows, [
      { header: excelHeader('序号'), cell: (row) => ({ value: row.index, type: Number }), width: 8 },
      { header: excelHeader('奖项'), cell: (row) => ({ value: row.prizeName }), width: 18 },
      { header: excelHeader('姓名'), cell: (row) => ({ value: row.name }), width: 16 },
      { header: excelHeader('微信昵称'), cell: (row) => ({ value: row.nickname }), width: 18 },
      { header: excelHeader('所在单位'), cell: (row) => ({ value: row.company }), width: 24 },
      { header: excelHeader('手机号'), cell: (row) => ({ value: row.phone }), width: 18 },
      { header: excelHeader('是否内定'), cell: (row) => ({ value: row.fixed ? '是' : '否' }), width: 12 },
      { header: excelHeader('中奖时间'), cell: (row) => ({ value: formatDate(row.drawnAt) }), width: 22 }
    ]);
  } catch (error) {
    next(error);
  }
});

function dateStamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (item) => String(item).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

io.on('connection', (socket) => {
  socket.emit('state', publicState({
    protocol: 'http',
    get: () => `localhost:${PORT}`
  }));
});

app.get(/.*/, (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).json({ message: error.message || '服务异常' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`微信签到抽奖服务已启动：http://localhost:${PORT}`);
  for (const address of lanUrls(PORT)) {
    console.log(`局域网访问：${address}`);
  }
});

function lanUrls(port) {
  const urls = [];
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const item of interfaces || []) {
      if (item.family === 'IPv4' && !item.internal) {
        urls.push(`http://${item.address}:${port}`);
      }
    }
  }
  return urls;
}
