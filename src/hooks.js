import { join } from 'node:path';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  writeSync,
  rmSync,
  appendFileSync,
} from 'node:fs';
import { configDir, loadConfig, getApiUrl } from './config.js';

const MAX_TEXT_LENGTH = 100_000;
const SEND_TIMEOUT_MS = 15_000;

const sessionsDir = () => join(configDir(), 'sessions');
const sessionPath = (sessionId) =>
  join(sessionsDir(), `${sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
  });
}

function logError(err) {
  try {
    mkdirSync(configDir(), { recursive: true });
    appendFileSync(
      join(configDir(), 'error.log'),
      `${new Date().toISOString()} ${err?.stack ?? err}\n`
    );
  } catch {
    // Never let diagnostics break a hook.
  }
}

function loadSession(sessionId) {
  try {
    return JSON.parse(readFileSync(sessionPath(sessionId), 'utf8'));
  } catch {
    return { prompts: [] };
  }
}

function saveSession(sessionId, session) {
  mkdirSync(sessionsDir(), { recursive: true });
  writeFileSync(sessionPath(sessionId), JSON.stringify(session));
}

/**
 * UserPromptSubmit: remember the prompt so the Stop hook can pair it with
 * the turn's outcome.
 */
async function onUserPromptSubmit(input) {
  if (!input.session_id || typeof input.prompt !== 'string') return;
  const session = loadSession(input.session_id);
  session.prompts.push(input.prompt);
  saveSession(input.session_id, session);
}

/**
 * Pull the final assistant text out of the transcript (JSONL). This is the
 * "outcome" — we deliberately skip the intermediate steps/tool calls.
 */
function extractOutcome(transcriptPath) {
  const lines = readFileSync(transcriptPath, 'utf8').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].trim()) continue;
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (entry.type !== 'assistant' || !entry.message?.content) continue;
    const text = entry.message.content
      .filter((block) => block.type === 'text' && block.text)
      .map((block) => block.text)
      .join('\n')
      .trim();
    if (text) return text;
  }
  return null;
}

const clamp = (text) =>
  text.length > MAX_TEXT_LENGTH ? text.slice(0, MAX_TEXT_LENGTH) : text;

/**
 * Stop: the turn is over — send the accumulated request(s) plus the final
 * assistant message to Ari, then clear the per-session state.
 */
async function onStop(input) {
  // stop_hook_active means a stop hook already forced Claude to continue;
  // the real end of the turn will fire another Stop event.
  if (input.stop_hook_active) return;
  if (!input.session_id || !input.transcript_path) return;

  const session = loadSession(input.session_id);
  if (session.prompts.length === 0) return;

  const outcome = extractOutcome(input.transcript_path);
  if (!outcome) return;

  const config = loadConfig();
  if (!config.token) return;

  const response = await fetch(new URL('/agent-activities', getApiUrl(config)), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.token}`,
    },
    body: JSON.stringify({
      request: clamp(session.prompts.join('\n\n')),
      outcome: clamp(outcome),
      session_id: input.session_id,
      cwd: input.cwd ?? process.cwd(),
    }),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`POST /agent-activities failed: ${response.status}`);
  }

  rmSync(sessionPath(input.session_id), { force: true });
}

const MAX_TASKS = 3;
const MAX_TASK_NAME_LENGTH = 200;

const oneLine = (text) =>
  text.replace(/\s+/g, ' ').trim().slice(0, MAX_TASK_NAME_LENGTH);

/**
 * SessionStart: ask Ari for the top tasks Claude can take care of right now
 * and surface them at boot — a visible list for the user (systemMessage)
 * plus the full prompts for Claude (additionalContext) so it can run
 * whichever one the user picks.
 */
async function onSessionStart(input) {
  // Compaction restarts the session mid-conversation; the tasks were
  // already offered, so don't show (or inject) them again.
  if (input.source === 'compact') return;

  const config = loadConfig();
  if (!config.token) return;

  const response = await fetch(new URL('/agent-tasks', getApiUrl(config)), {
    headers: { Authorization: `Bearer ${config.token}` },
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`GET /agent-tasks failed: ${response.status}`);
  }

  const body = await response.json();
  // The API wraps the list ({ tasks: [...] }); accept a bare array too.
  const list = Array.isArray(body) ? body : Array.isArray(body?.tasks) ? body.tasks : [];
  const tasks = list
    .filter(
      (t) =>
        t &&
        typeof t.taskName === 'string' &&
        t.taskName.trim() &&
        typeof t.prompt === 'string' &&
        t.prompt.trim()
    )
    .slice(0, MAX_TASKS);
  if (tasks.length === 0) return;

  // Claude Code renders systemMessage with ANSI intact; the leading \n
  // pushes our block below the fixed "SessionStart:<source> says:" prefix.
  const BOLD = '\x1b[1m';
  const CYAN = '\x1b[36m';
  const GREY = '\x1b[37m';
  const RESET = '\x1b[0m';
  const visibleList = tasks
    .map((t, i) => `  ${BOLD}${i + 1}.${RESET} ${oneLine(t.taskName)}`)
    .join('\n');
  const systemMessage =
    `\n${BOLD}${CYAN}✻ Ari — things Claude can take care of for you right now${RESET}\n` +
    `${visibleList}\n` +
    `${GREY}Reply "run task 1" (or the task name) to start one.${RESET}`;

  const additionalContext =
    `The user has Ari connected via ari-hooks. At session start the user was ` +
    `shown this list of suggested tasks:\n\n` +
    tasks
      .map(
        (t, i) =>
          `Task ${i + 1}: ${oneLine(t.taskName)}\nPrompt: ${clamp(t.prompt)}`
      )
      .join('\n\n') +
    `\n\nIf the user asks to run one of these tasks (by number or name), ` +
    `carry out that task's prompt as if the user had typed it. Do not start ` +
    `any of these tasks unless the user asks.`;

  // writeSync: process.exit(0) in runHook would race an async stdout write.
  writeSync(
    1,
    JSON.stringify({
      systemMessage,
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext,
      },
    }) + '\n'
  );
}

/**
 * Entry point for `ari-hooks hook <event>`. Hooks must never break the
 * user's Claude Code session: all failures are swallowed (logged to
 * ~/.ari-hooks/error.log) and we always exit 0.
 */
export async function runHook(event) {
  try {
    const raw = await readStdin();
    const input = raw ? JSON.parse(raw) : {};
    if (event === 'user-prompt-submit') {
      await onUserPromptSubmit(input);
    } else if (event === 'stop') {
      await onStop(input);
    } else if (event === 'session-start') {
      await onSessionStart(input);
    }
  } catch (err) {
    logError(err);
  }
  process.exit(0);
}
