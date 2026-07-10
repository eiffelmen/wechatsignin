import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

test('initial store has required sections', () => {
  const store = JSON.parse(fs.readFileSync(path.join(root, 'data', 'store.example.json'), 'utf8'));
  assert.ok(store.config.eventTitle);
  assert.ok(Array.isArray(store.attendees));
  assert.ok(Array.isArray(store.prizes));
  assert.ok(Array.isArray(store.winners));
  assert.ok(store.prizes.length >= 1);
});

test('browser entry files exist', () => {
  for (const file of ['index.html', 'styles.css', 'app.js']) {
    assert.ok(fs.existsSync(path.join(root, 'src', 'public', file)));
  }
});
