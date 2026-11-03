import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(path.resolve(import.meta.dirname, '../src/public/app.js'), 'utf8');

function browser(storage = new Map()) {
  const app = { innerHTML: '' };
  const selectors = new Map([
    ['#app', app],
    ['#editCheckin', { addEventListener() {} }],
    ['#checkinError', { textContent: '' }],
    ['#checkinName', { focus() {} }],
    ['#submitCheckin span', { textContent: '' }]
  ]);
  const events = new Map();
  const context = vm.createContext({
    document: {
      querySelector: (selector) => selectors.get(selector) || null,
      querySelectorAll: () => [], addEventListener() {}
    },
    window: { location: { pathname: '/checkin', search: '' }, addEventListener() {}, crypto: webcrypto },
    navigator: { userAgent: 'MicroMessenger/8.0' },
    location: { origin: 'http://example.test' },
    localStorage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    URLSearchParams, FormData,
    io: () => ({ on: (event, callback) => events.set(event, callback) }),
    btoa: (value) => Buffer.from(value, 'binary').toString('base64')
  });
  vm.runInContext(source, context);
  vm.runInContext(`state = { config: { checkinMode: 'local' }, attendees: [], wechat: { ready: true } };`, context);
  context.bindLocalCheckinForm = () => {};
  return { context, app, selectors, events, storage, run: (code) => vm.runInContext(code, context) };
}

test('local mode shows a name and optional avatar form even inside WeChat', () => {
  const ui = browser();
  ui.context.renderCheckin();
  assert.match(ui.app.innerHTML, /id="localCheckinForm"/);
  assert.match(ui.app.innerHTML, /name="name"/);
  assert.match(ui.app.innerHTML, /头像（选填）/);
  assert.doesNotMatch(ui.app.innerHTML, /name="phone"|微信授权未配置|打开微信授权/);
});

test('settings expose a labeled local and WeChat mode selector', () => {
  const ui = browser();
  const html = ui.context.renderSettingsPanel();
  assert.match(html, /name="checkinMode" aria-label="签到方式"/);
  assert.match(html, /value="local" selected/);
  assert.match(html, /value="wechat"/);
});

test('visitor identity is stable across page reloads', () => {
  const ui = browser();
  const id = ui.context.getVisitorId();
  assert.match(id, /^visitor-[a-f0-9]{24}$/);
  assert.equal(ui.context.getVisitorId(), id);
  assert.equal(browser(ui.storage).context.getVisitorId(), id);
});

test('blocked storage retains one identity for the current page session', () => {
  const ui = browser();
  ui.context.localStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  const id = ui.context.getVisitorId();
  assert.equal(ui.context.getVisitorId(), id);
});

test('an existing local visitor sees a success screen instead of a second form', () => {
  const ui = browser();
  ui.run(`state.attendees = [{id: 'saved', openid: getVisitorId(), name: '已签到来宾'}];`);
  ui.context.renderCheckin();
  assert.match(ui.app.innerHTML, /签到成功|已签到来宾|修改资料/);
  assert.doesNotMatch(ui.app.innerHTML, /id="localCheckinForm"/);
});

test('socket updates do not replace an in-progress local form', () => {
  const ui = browser();
  ui.selectors.set('#localCheckinForm', {});
  let renders = 0;
  ui.context.render = () => { renders += 1; };
  ui.context.connectSocket();
  ui.events.get('state')({ config: { checkinMode: 'local' }, attendees: [] });
  assert.equal(renders, 0);
  ui.events.get('state')({ config: { checkinMode: 'wechat' }, attendees: [] });
  assert.equal(renders, 1);
});

test('double submission sends only one name-only request and caches the saved attendee', async () => {
  const ui = browser();
  let finish;
  const calls = [];
  let renders = 0;
  ui.context.renderLocalCheckin = () => { renders += 1; };
  ui.context.api = (url, options) => {
    calls.push({ url, body: JSON.parse(JSON.stringify(options.body)) });
    return new Promise((resolve) => { finish = resolve; });
  };
  ui.run(`checkinUiState.name = '  王小明  ';`);
  const event = { preventDefault() {} };
  const first = ui.context.submitLocalCheckin(event);
  await ui.context.submitLocalCheckin(event);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.name, '王小明');
  assert.equal(calls[0].body.source, 'local-form');
  assert.equal(calls[0].body.phone, undefined);
  finish({ attendee: { id: 'saved', name: '王小明', openid: calls[0].body.visitorId } });
  await first;
  assert.equal(ui.run('state.attendees.length'), 1);
  assert.equal(ui.run('checkinUiState.submitting'), false);
  assert.equal(renders, 1);
});

test('a submission error keeps the draft and enables retry', async () => {
  const ui = browser();
  ui.run(`checkinUiState.name = '保留姓名';`);
  ui.context.api = async () => { throw new Error('网络连接失败，请重试'); };
  await ui.context.submitLocalCheckin({ preventDefault() {} });
  assert.equal(ui.run('checkinUiState.name'), '保留姓名');
  assert.equal(ui.run('checkinUiState.submitting'), false);
  assert.equal(ui.run('state.attendees.length'), 0);
  assert.equal(ui.selectors.get('#checkinError').textContent, '网络连接失败，请重试');
});

test('whitespace-only names never send a request', async () => {
  const ui = browser();
  ui.run(`checkinUiState.name = '   ';`);
  ui.context.api = () => { throw new Error('Should not submit'); };
  await ui.context.submitLocalCheckin({ preventDefault() {} });
  assert.equal(ui.selectors.get('#checkinError').textContent, '请填写姓名');
});
