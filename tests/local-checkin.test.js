import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { startTestServer } from './helpers/test-server.js';

let server;
before(async () => {
  server = await startTestServer({ env: {
    WECHAT_APP_ID: 'test-app-id', WECHAT_APP_SECRET: 'test-secret', PUBLIC_URL: 'https://event.example.test'
  } });
});
after(async () => { await server?.stop(); });

async function json(url, body, method = 'POST') {
  const response = await fetch(server.url + url, {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

async function state() {
  return (await fetch(server.url + '/api/state')).json();
}

test('local check-in stays on the form even with WeChat configured and a WeChat user agent', async () => {
  const current = await state();
  assert.equal(current.config.checkinMode, 'local');
  assert.equal(current.wechat.ready, true);
  const response = await fetch(server.url + '/checkin', {
    headers: { 'User-Agent': 'MicroMessenger/8.0' }, redirect: 'manual'
  });
  assert.equal(response.status, 200);
});

test('name-only check-in generates an escaped name avatar without requiring a phone', async () => {
  const result = await json('/api/checkin', { visitorId: 'name-only', name: '  嘉宾 <甲&>  ', source: 'local-form' });
  assert.equal(result.status, 200);
  assert.equal(result.body.attendee.name, '嘉宾 <甲&>');
  assert.equal(result.body.attendee.phone, '');
  assert.equal(result.body.attendee.nickname, '嘉宾 <甲&>');
  const svg = Buffer.from(result.body.attendee.avatar.split(',')[1], 'base64').toString();
  assert.match(svg, /&amp;&gt;/);
  assert.doesNotMatch(svg, /<甲/);
});

test('blank names are rejected without creating a record', async () => {
  const count = (await state()).attendees.length;
  const result = await json('/api/checkin', { visitorId: 'blank', name: '   ', source: 'local-form' });
  assert.equal(result.status, 400);
  assert.equal(result.body.message, '请填写姓名');
  assert.equal((await state()).attendees.length, count);
});

test('repeated submissions update the same attendee and preserve the check-in time', async () => {
  const first = await json('/api/checkin', { visitorId: 'repeat', name: '王小明', source: 'local-form' });
  const count = (await state()).attendees.length;
  const second = await json('/api/checkin', { visitorId: 'repeat', name: '李小华', avatar: '', source: 'local-form' });
  assert.equal(second.body.existing, true);
  assert.equal(second.body.attendee.id, first.body.attendee.id);
  assert.equal(second.body.attendee.checkedInAt, first.body.attendee.checkedInAt);
  assert.equal(second.body.attendee.name, '李小华');
  assert.notEqual(second.body.attendee.avatar, first.body.attendee.avatar);
  assert.equal((await state()).attendees.length, count);
});

test('two guests with the same name are not merged', async () => {
  const first = await json('/api/checkin', { visitorId: 'same-name-a', name: '张三', source: 'local-form' });
  const second = await json('/api/checkin', { visitorId: 'same-name-b', name: '张三', source: 'local-form' });
  assert.notEqual(first.body.attendee.id, second.body.attendee.id);
});

test('profile edits do not erase existing phone and company fields', async () => {
  await json('/api/checkin', { visitorId: 'legacy-guest', name: '历史来宾', phone: '00000000000', company: '测试单位' });
  const result = await json('/api/checkin', { visitorId: 'legacy-guest', name: '历史来宾新名', source: 'local-form' });
  assert.equal(result.body.attendee.phone, '00000000000');
  assert.equal(result.body.attendee.company, '测试单位');
});

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l3sAAAAASUVORK5CYII=', 'base64');

async function upload(buffer, name, type) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type }), name);
  const response = await fetch(server.url + '/api/checkin/avatar', { method: 'POST', body: form });
  return { status: response.status, body: await response.json() };
}

test('uploaded raster avatars are served locally and survive check-in', async () => {
  const image = await upload(png, 'photo.png', 'image/png');
  assert.equal(image.status, 200);
  assert.match(image.body.url, /^\/uploads\/avatar-[a-f0-9-]+\.png$/);
  const fetched = await fetch(server.url + image.body.url);
  assert.equal(fetched.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await fetched.arrayBuffer()), png);
  const result = await json('/api/checkin', { visitorId: 'photo-guest', name: '头像来宾', avatar: image.body.url, source: 'local-form' });
  assert.equal(result.status, 200);
  assert.equal(result.body.attendee.avatar, image.body.url);
  const reset = await json('/api/checkin', { visitorId: 'photo-guest', name: '头像来宾', avatar: '', source: 'local-form' });
  assert.equal(reset.body.attendee.id, result.body.attendee.id);
  assert.match(reset.body.attendee.avatar, /^data:image\/svg\+xml;base64,/);
});

test('SVG and disguised non-image uploads are rejected without leaving files', async () => {
  const directory = path.join(server.directory, 'assets/uploads');
  const count = fs.readdirSync(directory).length;
  for (const [name, type] of [['photo.svg', 'image/svg+xml'], ['fake.png', 'image/png']]) {
    const result = await upload(Buffer.from('<svg><script>alert(1)</script></svg>'), name, type);
    assert.equal(result.status, 400);
  }
  assert.equal(fs.readdirSync(directory).length, count);
});

test('oversized and missing avatar uploads return a useful error', async () => {
  const result = await upload(Buffer.alloc(2 * 1024 * 1024 + 1), 'large.png', 'image/png');
  assert.equal(result.status, 400);
  assert.match(result.body.message, /2 MB/);
  const empty = await fetch(server.url + '/api/checkin/avatar', { method: 'POST', body: new FormData() });
  assert.equal(empty.status, 400);
});

test('local sign-in rejects missing, external and executable avatar URLs', async () => {
  for (const avatar of ['/uploads/avatar-123.png', 'https://example.test/photo.png', 'data:image/svg+xml,<svg/>', '/uploads/../server.js']) {
    const result = await json('/api/checkin', { visitorId: 'bad-avatar', name: '头像测试', avatar, source: 'local-form' });
    assert.equal(result.status, 400);
  }
});

test('WeChat authorization is still available as an explicit mode', async () => {
  await json('/api/config', { checkinMode: 'wechat' }, 'PUT');
  const response = await fetch(server.url + '/checkin', { headers: { 'User-Agent': 'MicroMessenger/8.0' }, redirect: 'manual' });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/wechat/oauth/start');
  await json('/api/config', { checkinMode: 'local' }, 'PUT');
});

test('local attendees can enter the draw and be exported without a phone', async () => {
  const guest = await json('/api/checkin', { visitorId: 'draw-guest', name: '抽奖来宾', source: 'local-form' });
  const id = guest.body.attendee.id;
  await json('/api/prizes/grand-prize', { fixedWinnerIds: [id] }, 'PUT');
  const result = await json('/api/draw', { prizeId: 'grand-prize', count: 1 });
  assert.equal(result.status, 200);
  assert.equal(result.body.winners[0].attendeeId, id);
  assert.equal(result.body.winners[0].avatar, guest.body.attendee.avatar);
  const exported = await fetch(server.url + '/api/export/checkins.xlsx');
  assert.equal(exported.status, 200);
  assert.ok((await exported.arrayBuffer()).byteLength > 100);
});
