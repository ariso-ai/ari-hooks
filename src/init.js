import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const HOOK_EVENTS = {
  SessionStart: 'ari-hooks hook session-start',
  UserPromptSubmit: 'ari-hooks hook user-prompt-submit',
  Stop: 'ari-hooks hook stop',
};

// Cursor's agent doesn't read .claude/settings.json — it has its own hooks
// system in .cursor/hooks.json with different event names and a flat entry
// format. Cursor's transcript is not the Claude Code JSONL our stop handler
// parses, so afterAgentResponse captures the final assistant text instead.
const CURSOR_HOOK_EVENTS = {
  sessionStart: 'ari-hooks hook session-start',
  beforeSubmitPrompt: 'ari-hooks hook user-prompt-submit',
  afterAgentResponse: 'ari-hooks hook agent-response',
  stop: 'ari-hooks hook stop',
};

/**
 * Cursor's integrated terminal exports CURSOR_TRACE_ID and its CLI agent
 * exports CURSOR_AGENT; neither is set by plain VS Code or a bare shell.
 */
export const isCursor = (env = process.env) =>
  Boolean(env.CURSOR_TRACE_ID || env.CURSOR_AGENT);

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(
      `${path} exists but is not valid JSON — fix or remove it, then re-run.`
    );
  }
}

const writeJson = (path, value) =>
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');

function initClaude(cwd) {
  const claudeDir = join(cwd, '.claude');
  const settingsPath = join(claudeDir, 'settings.json');
  const settings = readJson(settingsPath) ?? {};

  settings.hooks ??= {};
  let changed = false;

  for (const [event, command] of Object.entries(HOOK_EVENTS)) {
    settings.hooks[event] ??= [];
    const already = settings.hooks[event].some((matcher) =>
      (matcher.hooks ?? []).some((h) => h.command?.includes('ari-hooks hook'))
    );
    if (already) continue;
    settings.hooks[event].push({
      hooks: [{ type: 'command', command, timeout: 30 }],
    });
    changed = true;
  }

  if (!changed) {
    console.log(`Ari hooks already configured in ${settingsPath}`);
    return false;
  }

  mkdirSync(claudeDir, { recursive: true });
  writeJson(settingsPath, settings);
  console.log(`✓ Ari hooks added to ${settingsPath}`);
  return true;
}

function initCursor(cwd) {
  const cursorDir = join(cwd, '.cursor');
  const hooksPath = join(cursorDir, 'hooks.json');
  const config = readJson(hooksPath) ?? {};

  config.version ??= 1;
  config.hooks ??= {};
  let changed = false;

  for (const [event, command] of Object.entries(CURSOR_HOOK_EVENTS)) {
    config.hooks[event] ??= [];
    const already = config.hooks[event].some((h) =>
      h.command?.includes('ari-hooks hook')
    );
    if (already) continue;
    config.hooks[event].push({ command, timeout: 30 });
    changed = true;
  }

  if (!changed) {
    console.log(`Ari hooks already configured in ${hooksPath}`);
    return false;
  }

  mkdirSync(cursorDir, { recursive: true });
  writeJson(hooksPath, config);
  console.log(`✓ Ari hooks added to ${hooksPath} (Cursor detected)`);
  return true;
}

/**
 * Merge the ari-hooks hook commands into the project's Claude Code
 * settings (.claude/settings.json in cwd) — and, when running inside
 * Cursor, into .cursor/hooks.json as well. Idempotent: existing ari-hooks
 * entries are left alone, and unrelated hooks/settings are preserved.
 */
export function init(cwd = process.cwd(), env = process.env) {
  const changedClaude = initClaude(cwd);
  const changedCursor = isCursor(env) ? initCursor(cwd) : false;

  if (!changedClaude && !changedCursor) return;
  console.log(
    'Agent sessions in this folder will now share each request and its outcome with Ari,'
  );
  console.log('and show suggested Ari tasks when a session starts.');
}

function uninstallClaude(cwd) {
  const settingsPath = join(cwd, '.claude', 'settings.json');
  if (!existsSync(settingsPath)) return false;
  const settings = readJson(settingsPath);

  const isOurs = (h) => h.command?.includes('ari-hooks hook');
  let changed = false;

  for (const [event, matchers] of Object.entries(settings.hooks ?? {})) {
    if (!Array.isArray(matchers)) continue;
    const kept = matchers
      .map((matcher) => {
        if (!(matcher.hooks ?? []).some(isOurs)) return matcher;
        changed = true;
        const rest = matcher.hooks.filter((h) => !isOurs(h));
        return rest.length > 0 ? { ...matcher, hooks: rest } : null;
      })
      .filter(Boolean);
    if (kept.length > 0) settings.hooks[event] = kept;
    else delete settings.hooks[event];
  }

  if (!changed) return false;

  if (settings.hooks && Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }

  writeJson(settingsPath, settings);
  console.log(`✓ Ari hooks removed from ${settingsPath}`);
  return true;
}

function uninstallCursor(cwd) {
  const hooksPath = join(cwd, '.cursor', 'hooks.json');
  if (!existsSync(hooksPath)) return false;
  const config = readJson(hooksPath);

  const isOurs = (h) => h.command?.includes('ari-hooks hook');
  let changed = false;

  for (const [event, entries] of Object.entries(config.hooks ?? {})) {
    if (!Array.isArray(entries)) continue;
    const kept = entries.filter((h) => !isOurs(h));
    if (kept.length === entries.length) continue;
    changed = true;
    if (kept.length > 0) config.hooks[event] = kept;
    else delete config.hooks[event];
  }

  if (!changed) return false;

  writeJson(hooksPath, config);
  console.log(`✓ Ari hooks removed from ${hooksPath}`);
  return true;
}

/**
 * Remove the ari-hooks hook commands that init/install added to the
 * project's Claude Code settings and Cursor hooks file. The inverse of
 * init: only ari-hooks entries are touched, everything else in the files
 * is preserved. Cleans both files regardless of where it runs, so hooks
 * installed from inside Cursor don't linger.
 */
export function uninstall(cwd = process.cwd()) {
  const removedClaude = uninstallClaude(cwd);
  const removedCursor = uninstallCursor(cwd);

  if (!removedClaude && !removedCursor) {
    console.log('No Ari hooks found in this folder — nothing to remove.');
    return;
  }
  console.log(
    'Agent sessions in this folder will no longer share activity with Ari.'
  );
}
