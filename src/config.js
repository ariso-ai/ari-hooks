import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';

export const DEFAULT_WEB_URL = 'https://web.ari.ariso.ai';
export const DEFAULT_API_URL = 'https://api.ari.ariso.ai';

export const configDir = () =>
  process.env.ARI_HOOKS_HOME || join(homedir(), '.ari-hooks');

const configPath = () => join(configDir(), 'config.json');

export function loadConfig() {
  try {
    return JSON.parse(readFileSync(configPath(), 'utf8'));
  } catch {
    return {};
  }
}

export function saveConfig(config) {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  writeFileSync(configPath(), JSON.stringify(config, null, 2) + '\n', {
    mode: 0o600,
  });
}

export function clearConfig() {
  rmSync(configPath(), { force: true });
}

export function getApiUrl(config = loadConfig()) {
  return process.env.ARI_HOOKS_API_URL || config.apiUrl || DEFAULT_API_URL;
}

export function getWebUrl(config = loadConfig()) {
  return process.env.ARI_HOOKS_WEB_URL || config.webUrl || DEFAULT_WEB_URL;
}

function normalizeUrl(raw, label) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label} is not a valid URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${label} must be http(s): ${raw}`);
  }
  return url.toString().replace(/\/$/, '');
}

/** Persist base-URL overrides (e.g. point at localhost for testing). */
export function setUrls({ webUrl, apiUrl, resetUrls }) {
  const config = loadConfig();
  if (resetUrls) {
    delete config.webUrl;
    delete config.apiUrl;
  }
  if (webUrl) config.webUrl = normalizeUrl(webUrl, '--web-url');
  if (apiUrl) config.apiUrl = normalizeUrl(apiUrl, '--api-url');
  saveConfig(config);
  console.log(`Web URL: ${getWebUrl(config)}`);
  console.log(`API URL: ${getApiUrl(config)}`);
}

export function showConfig() {
  const config = loadConfig();
  const note = (key, envVar) =>
    process.env[envVar]
      ? ` (from ${envVar})`
      : config[key]
        ? ' (configured)'
        : ' (default)';
  console.log(`Web URL: ${getWebUrl(config)}${note('webUrl', 'ARI_HOOKS_WEB_URL')}`);
  console.log(`API URL: ${getApiUrl(config)}${note('apiUrl', 'ARI_HOOKS_API_URL')}`);
  console.log(config.token ? `Logged in (since ${config.loggedInAt ?? 'unknown'})` : 'Not logged in.');
}
