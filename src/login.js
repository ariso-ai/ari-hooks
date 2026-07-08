import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  loadConfig,
  saveConfig,
  getWebUrl,
  getApiUrl,
  clearConfig,
} from './config.js';

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

const SUCCESS_HTML = `<!doctype html>
<html><head><title>Ari Hooks</title></head>
<body style="font-family: sans-serif; text-align: center; padding-top: 4rem;">
<h2>✓ Logged in</h2>
<p>The Ari Hooks CLI received your token. You can close this window.</p>
</body></html>`;

function openBrowser(url) {
  const cmd =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'start'
        : 'xdg-open';
  const child = spawn(cmd, [url], {
    stdio: 'ignore',
    detached: true,
    shell: process.platform === 'win32',
  });
  child.on('error', () => {});
  child.unref();
}

/**
 * Browser login: start a one-shot loopback HTTP server, send the user to
 * the web app's /cli-auth page with our callback URL, and wait for the
 * page to redirect back with a freshly minted API token.
 */
export async function login({ webUrl, apiUrl } = {}) {
  const config = loadConfig();
  if (webUrl) config.webUrl = webUrl;
  if (apiUrl) config.apiUrl = apiUrl;

  const state = randomBytes(16).toString('hex');

  const token = await new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      if (url.searchParams.get('state') !== state) {
        res.writeHead(400).end('State mismatch — please retry `ari-hooks login`.');
        return;
      }
      const received = url.searchParams.get('token');
      if (!received) {
        res.writeHead(400).end('Missing token.');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' }).end(SUCCESS_HTML);
      // Let the response flush before tearing the server down.
      setTimeout(() => server.close(), 100);
      resolve(received);
    });

    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const authUrl = new URL('/cli-auth', getWebUrl(config));
      authUrl.searchParams.set(
        'callback',
        `http://127.0.0.1:${port}/callback`
      );
      authUrl.searchParams.set('state', state);

      console.log('Opening your browser to log in to Ari...');
      console.log(`If it does not open, visit:\n\n  ${authUrl}\n`);
      openBrowser(authUrl.toString());
    });

    setTimeout(() => {
      server.close();
      reject(new Error('Login timed out after 5 minutes. Please retry `ari-hooks login`.'));
    }, LOGIN_TIMEOUT_MS).unref();
  });

  config.token = token;
  config.loggedInAt = new Date().toISOString();
  saveConfig(config);
  console.log('✓ Logged in. Token saved to ~/.ari-hooks/config.json');
  return token;
}

export function logout() {
  clearConfig();
  console.log('Logged out — local token removed.');
}

export function status() {
  const config = loadConfig();
  if (!config.token) {
    console.log('Not logged in. Run `ari-hooks login`.');
    return;
  }
  console.log(`Logged in (since ${config.loggedInAt ?? 'unknown'})`);
  console.log(`API: ${getApiUrl(config)}`);
}
