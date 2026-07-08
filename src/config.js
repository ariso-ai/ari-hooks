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
