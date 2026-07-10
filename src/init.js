import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

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
