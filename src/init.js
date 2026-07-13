import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';

// Each command carries an --agent flag so the Stop hook can report which coding
// agent produced the activity (agent_name) without having to guess from the
// payload — the config file it lives in is the reliable source of that fact.
const HOOK_EVENTS = {
  SessionStart: 'ari-hooks hook session-start --agent claude',
  UserPromptSubmit: 'ari-hooks hook user-prompt-submit --agent claude',
  Stop: 'ari-hooks hook stop --agent claude',
};

// Codex copied Claude Code's hooks design: the same { hooks: { Event: [{ hooks:
// [{ type, command }] }] } } shape and the same event names, read from
// .codex/hooks.json (or ~/.codex/hooks.json). We only wire up the
// activity-sharing pair: UserPromptSubmit remembers the prompt and Stop ships
// the outcome (Codex hands us the final text on the Stop payload as
// last_assistant_message — no transcript to parse; see onStop). We skip
// SessionStart because Codex has no user-visible channel to render the
// suggested-task list, so there is nothing to show.
const CODEX_HOOK_EVENTS = {
  UserPromptSubmit: 'ari-hooks hook user-prompt-submit --agent codex',
  Stop: 'ari-hooks hook stop --agent codex',
};

// Cursor's agent doesn't read .claude/settings.json — it has its own hooks
// system in .cursor/hooks.json with different event names and a flat entry
// format. Cursor's transcript is not the Claude Code JSONL our stop handler
// parses, so afterAgentResponse captures the final assistant text instead.
const CURSOR_HOOK_EVENTS = {
  sessionStart: 'ari-hooks hook session-start --agent cursor',
  beforeSubmitPrompt: 'ari-hooks hook user-prompt-submit --agent cursor',
  afterAgentResponse: 'ari-hooks hook agent-response --agent cursor',
  stop: 'ari-hooks hook stop --agent cursor',
};

// Cursor's app install shows up in the env vars its integrated terminal
// inherits: the git-askpass helpers point into Cursor.app (macOS),
// AppData\Local\Programs\cursor (Windows), or a cursor install dir (Linux).
const CURSOR_PATH_VARS = [
  'GIT_ASKPASS',
  'VSCODE_GIT_ASKPASS_NODE',
  'VSCODE_GIT_ASKPASS_MAIN',
];

// Cursor ships via ToDesktop, so its macOS bundle id is this opaque token
// rather than anything containing "cursor".
const CURSOR_BUNDLE_ID = 'com.todesktop.230313mzl4w4u92';

/**
 * Cursor's agent terminals export CURSOR_TRACE_ID and its CLI agent exports
 * CURSOR_AGENT, but a regular integrated terminal in Cursor sets neither —
 * it looks like VS Code (TERM_PROGRAM=vscode). There, the tells are the
 * app's bundle id and the helper paths pointing into the Cursor install;
 * plain VS Code and a bare shell match none of these.
 */
export const isCursor = (env = process.env) =>
  Boolean(
    env.CURSOR_TRACE_ID ||
      env.CURSOR_AGENT ||
      env.__CFBundleIdentifier === CURSOR_BUNDLE_ID ||
      CURSOR_PATH_VARS.some((key) => /cursor/i.test(env[key] ?? ''))
  );

const dirExists = (path) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

// Each agent keeps its config under a home directory whose presence is the
// tell that the user runs that agent; both honor the same env overrides the
// agents themselves do (CLAUDE_CONFIG_DIR, CODEX_HOME), which also lets tests
// point them at a scratch dir.
const claudeHome = (env) => env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
const codexHome = (env) => env.CODEX_HOME || join(homedir(), '.codex');

/**
 * Which coding agents does this user run? Claude Code and Codex are detected by
 * their config directory; Cursor by the marks it leaves in an integrated
 * terminal (see isCursor). Returns a Set so install can branch to one config
 * path per detected agent. Falls back to Claude Code when nothing is found so a
 * fresh machine (or CI) still gets the primary target wired up.
 */
export function detectAgents(env = process.env) {
  const agents = new Set();
  if (dirExists(claudeHome(env))) agents.add('claude');
  if (dirExists(codexHome(env))) agents.add('codex');
  if (isCursor(env)) agents.add('cursor');
  if (agents.size === 0) agents.add('claude');
  return agents;
}

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

/**
 * Where the Claude Code hooks land, by scope:
 *   project — ./.claude/settings.json        (shared with everyone on the repo)
 *   local   — ./.claude/settings.local.json  (just this user; Claude Code
 *             gitignores it)
 *   user    — ~/.claude/settings.json        (every repo on this machine;
 *             honors CLAUDE_CONFIG_DIR like Claude Code does)
 */
function claudeSettingsPath(scope, cwd, env) {
  if (scope === 'user') {
    return join(claudeHome(env), 'settings.json');
  }
  const file = scope === 'local' ? 'settings.local.json' : 'settings.json';
  return join(cwd, '.claude', file);
}

// Codex has one project file and one user file — no committed/private split
// like Claude Code's settings.local.json — so 'local' collapses onto the
// project file.
function codexHooksPath(scope, cwd, env) {
  if (scope === 'user') {
    return join(codexHome(env), 'hooks.json');
  }
  return join(cwd, '.codex', 'hooks.json');
}

/**
 * Merge the ari-hooks commands into a settings file that uses the shared
 * Claude Code / Codex nested hook shape ({ hooks: { Event: [{ hooks: [...] }] }
 * }). Idempotent: an event that already has an ari-hooks command is left alone,
 * everything else in the file is preserved. `label` tags the success line so
 * the user can tell which agent a file belongs to.
 */
function initNestedHooks(settingsPath, events, label) {
  const settings = readJson(settingsPath) ?? {};

  settings.hooks ??= {};
  let changed = false;

  for (const [event, command] of Object.entries(events)) {
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

  mkdirSync(dirname(settingsPath), { recursive: true });
  writeJson(settingsPath, settings);
  console.log(`✓ Ari hooks added to ${settingsPath}${label ? ` (${label})` : ''}`);
  return true;
}

const initClaude = (settingsPath) => initNestedHooks(settingsPath, HOOK_EVENTS);

const initCodex = (hooksPath) =>
  initNestedHooks(hooksPath, CODEX_HOOK_EVENTS, 'Codex detected');

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

async function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim().toLowerCase();
  } catch {
    // Ctrl+D / closed stdin — fall through to the question's default.
    return '';
  } finally {
    rl.close();
  }
}

/**
 * Interactive scope picker for the Claude Code hooks: repo-only or
 * machine-wide, and — when repo-only — private (settings.local.json) or
 * shared with everyone on the repo (settings.json).
 */
async function chooseClaudeScope() {
  const repoOnly = await ask('Install hooks just for this repo? [Y/n] ');
  if (repoOnly === 'n' || repoOnly === 'no') return 'user';

  const who = await ask(
    'Install just for yourself, or for everyone who works on this repo?\n' +
      '  1) Just me   (.claude/settings.local.json, not committed)\n' +
      '  2) Everyone  (.claude/settings.json, committed with the repo)\n' +
      'Choose [1/2] (default 1): '
  );
  return who === '2' || who === 'everyone' ? 'project' : 'local';
}

/**
 * Merge the ari-hooks hook commands into the config of every coding agent this
 * user runs (see detectAgents): Claude Code settings, Codex hooks.json, and —
 * inside Cursor — .cursor/hooks.json. Idempotent: existing ari-hooks entries
 * are left alone, and unrelated hooks/settings are preserved. `scope` picks the
 * Claude Code and Codex file (see claudeSettingsPath / codexHooksPath); the
 * Cursor hooks file is always project-level.
 */
export function init(cwd = process.cwd(), env = process.env, scope = 'project') {
  const agents = detectAgents(env);
  const changed = [
    agents.has('claude') && initClaude(claudeSettingsPath(scope, cwd, env)),
    agents.has('codex') && initCodex(codexHooksPath(scope, cwd, env)),
    agents.has('cursor') && initCursor(cwd),
  ];

  if (!changed.some(Boolean)) return;
  const where = scope === 'user' ? 'on this machine' : 'in this folder';
  console.log(
    `Agent sessions ${where} will now share each request and its outcome with Ari,`
  );
  console.log('and show suggested Ari tasks when a session starts.');
}

/**
 * The `install` flavor of init: report which agents were detected, and — when
 * attached to a terminal — ask where the hooks should live before writing them.
 * Non-interactive runs (CI, piped stdin) keep the old default of the
 * project-level files.
 */
export async function install(cwd = process.cwd(), env = process.env) {
  const agents = detectAgents(env);
  console.log(`Detected coding agent(s): ${[...agents].join(', ')}`);
  const scope =
    process.stdin.isTTY && process.stdout.isTTY
      ? await chooseClaudeScope()
      : 'project';
  init(cwd, env, scope);
}

function uninstallNestedHooks(settingsPath) {
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
 * Remove the ari-hooks hook commands that init/install added to the Claude
 * Code settings, Codex hooks.json, and Cursor hooks file. The inverse of init:
 * only ari-hooks entries are touched, everything else in the files is
 * preserved. Cleans every location install can write to — regardless of which
 * agents are currently detected — so hooks don't linger wherever they were put:
 * the project/local/user Claude settings, the project and user Codex hooks, and
 * the Cursor hooks file.
 */
export function uninstall(cwd = process.cwd(), env = process.env) {
  const removedClaude = ['project', 'local', 'user']
    .map((scope) => uninstallNestedHooks(claudeSettingsPath(scope, cwd, env)))
    .some(Boolean);
  const removedCodex = ['project', 'user']
    .map((scope) => uninstallNestedHooks(codexHooksPath(scope, cwd, env)))
    .some(Boolean);
  const removedCursor = uninstallCursor(cwd);

  if (!removedClaude && !removedCodex && !removedCursor) {
    console.log('No Ari hooks found in this folder — nothing to remove.');
    return;
  }
  console.log(
    'Agent sessions in this folder will no longer share activity with Ari.'
  );
}
