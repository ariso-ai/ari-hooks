import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const HOOK_EVENTS = {
  SessionStart: 'ari-hooks hook session-start',
  UserPromptSubmit: 'ari-hooks hook user-prompt-submit',
  Stop: 'ari-hooks hook stop',
};

/**
 * Merge the ari-hooks hook commands into the project's Claude Code
 * settings (.claude/settings.json in cwd). Idempotent: existing ari-hooks
 * entries are left alone, and unrelated hooks/settings are preserved.
 */
export function init(cwd = process.cwd()) {
  const claudeDir = join(cwd, '.claude');
  const settingsPath = join(claudeDir, 'settings.json');

  let settings = {};
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw new Error(
        `${settingsPath} exists but is not valid JSON — fix or remove it, then re-run.`
      );
    }
  }

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
    return;
  }

  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  console.log(`✓ Ari hooks added to ${settingsPath}`);
  console.log(
    'Claude Code sessions in this folder will now share each request and its outcome with Ari,'
  );
  console.log('and show suggested Ari tasks when a session starts.');
}

/**
 * Remove the ari-hooks hook commands that init/install added to the
 * project's Claude Code settings. The inverse of init: only ari-hooks
 * entries are touched, everything else in the file is preserved.
 */
export function uninstall(cwd = process.cwd()) {
  const settingsPath = join(cwd, '.claude', 'settings.json');

  if (!existsSync(settingsPath)) {
    console.log(`No Claude Code settings found at ${settingsPath} — nothing to remove.`);
    return;
  }

  let settings;
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  } catch {
    throw new Error(
      `${settingsPath} exists but is not valid JSON — fix or remove it, then re-run.`
    );
  }

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

  if (!changed) {
    console.log(`No Ari hooks found in ${settingsPath} — nothing to remove.`);
    return;
  }

  if (settings.hooks && Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  console.log(`✓ Ari hooks removed from ${settingsPath}`);
  console.log(
    'Claude Code sessions in this folder will no longer share activity with Ari.'
  );
}
