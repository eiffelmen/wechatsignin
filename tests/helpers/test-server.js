import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');

export async function startTestServer(options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-checkin-test-'));
  fs.cpSync(path.join(root, 'src'), path.join(directory, 'src'), { recursive: true });
  fs.copyFileSync(path.join(root, 'package.json'), path.join(directory, 'package.json'));
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(directory, 'node_modules'), 'dir');
  fs.mkdirSync(path.join(directory, 'data'));
  fs.copyFileSync(path.join(root, 'data/store.example.json'), path.join(directory, 'data/store.example.json'));

  let port = options.port;
  if (!port) {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
  }
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: directory,
    env: { ...process.env, WECHAT_APP_ID: '', WECHAT_APP_SECRET: '', PUBLIC_URL: '', ...options.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { output += data; });
  const url = `http://127.0.0.1:${port}`;

  async function stop() {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }

  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (child.exitCode !== null) throw new Error(`Test server exited: ${output}`);
      try {
        const response = await fetch(`${url}/api/state`, { signal: AbortSignal.timeout(300) });
        if (response.ok) return { url, directory, child, stop };
      } catch { /* Wait for the listener to be ready. */ }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Test server did not start: ${output}`);
  } catch (error) {
    await stop();
    throw error;
  }
}
