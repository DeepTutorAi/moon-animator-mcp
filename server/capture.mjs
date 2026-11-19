// Window capture and contact-sheet composition through a long-running
// PowerShell helper (tools/capture-host.ps1). Keeping the helper alive avoids
// paying PowerShell startup on every shot.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../tools/capture-host.ps1', import.meta.url));
const SHELLS = ['pwsh', 'powershell'];
const READY_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 30_000;

let hostPromise = null;
let nextId = 1;

function startHost(shell) {
  return new Promise((resolve, reject) => {
    const child = spawn(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const pending = new Map();
    const host = { child, pending };
    let ready = false;
    let stderr = '';

    const fail = (error) => {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(error);
      }
      pending.clear();
      reject(error);
    };

    const readyTimer = setTimeout(() => {
      child.kill();
      fail(new Error('capture helper did not become ready'));
    }, READY_TIMEOUT_MS);

    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-2000);
    });
    child.once('error', (error) => {
      clearTimeout(readyTimer);
      fail(error);
    });
    child.once('exit', () => {
      clearTimeout(readyTimer);
      // A helper that died after becoming ready is replaced on the next request.
      if (ready) hostPromise = null;
      fail(new Error(`capture helper exited${stderr ? `: ${stderr.trim()}` : ''}`));
    });

    createInterface({ input: child.stdout }).on('line', (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.ready) {
        ready = true;
        clearTimeout(readyTimer);
        resolve(host);
        return;
      }
      const entry = pending.get(message.id);
      if (entry) {
        clearTimeout(entry.timer);
        pending.delete(message.id);
        entry.resolve(message);
      }
    });
  });
}

async function getHost() {
  if (process.platform !== 'win32') {
    throw new Error('window capture is only implemented for Windows');
  }
  if (!hostPromise) {
    hostPromise = (async () => {
      for (const shell of SHELLS) {
        try {
          return await startHost(shell);
        } catch (error) {
          if (error.code !== 'ENOENT' || shell === SHELLS.at(-1)) throw error;
        }
      }
      throw new Error('no PowerShell executable found');
    })();
    hostPromise.catch(() => {
      hostPromise = null;
    });
  }
  return hostPromise;
}

async function request(payload) {
  const host = await getHost();
  const id = nextId++;
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      host.pending.delete(id);
      reject(new Error(`capture helper did not answer "${payload.cmd}" in time`));
    }, REQUEST_TIMEOUT_MS);
    host.pending.set(id, { resolve, reject, timer });
    host.child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`);
  });
  if (!result.ok) {
    const error = new Error(`capture failed: ${result.error}`);
    error.kind = result.kind;
    throw error;
  }
  return result;
}

// Captures the Studio window. Options: outFile, crop {x,y,width,height},
// expectWindow "WxH", findColor [r,g,b], maxWidth, restoreIfMinimized.
// Rejects with an Error carrying `kind` (e.g. "minimized", "window_changed").
export function captureWindow(options = {}) {
  return request({ cmd: 'capture', ...options });
}

// Composes image files into one labeled contact sheet.
// Options: cells [{file, label}], columns, outFile.
export function composeSheet(options) {
  return request({ cmd: 'sheet', ...options });
}

// Draws shapes over an image file in place. Options: file, shapes, each
// { type: 'polyline', points, color, width } | { type: 'dot', x, y, radius, color }
// | { type: 'text', x, y, text, color }.
export function annotateImage(options) {
  return request({ cmd: 'annotate', ...options });
}

export async function closeCaptureHost() {
  if (!hostPromise) return;
  const host = await hostPromise.catch(() => null);
  hostPromise = null;
  if (host) host.child.stdin.end();
}
