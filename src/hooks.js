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
// Claude Code can fire Stop while the final assistant message is still being
// flushed to the transcript; poll until the tail settles (or give up).
const OUTCOME_POLL_INTERVAL_MS = 150;
const OUTCOME_SETTLE_TIMEOUT_MS = Number(
  process.env.ARI_HOOKS_SETTLE_TIMEOUT_MS ?? 5_000
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

function assistantText(entry) {
  if (entry.type !== 'assistant' || !Array.isArray(entry.message?.content)) {
    return '';
  }
  return entry.message.content
    .filter((block) => block.type === 'text' && block.text)
    .map((block) => block.text)
    .join('\n')
    .trim();
}

/**
 * Pull the final assistant text out of the transcript (JSONL). This is the
 * "outcome" — we deliberately skip the intermediate steps/tool calls.
 *
 * `settled` reports whether the exchange actually ends in assistant text.
 * When the transcript instead ends at a tool call/result or a half-written
 * line, the final message hasn't been flushed yet and `text` is only the
 * last narration before a tool ran — the caller should re-read rather than
 * ship that as the outcome.
 */
function extractOutcome(transcriptPath) {
  const entries = [];
  let tailPartial = false;
  for (const line of readFileSync(transcriptPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
      tailPartial = false;
    } catch {
      tailPartial = true; // a line still being written
    }
  }

  let settled = tailPartial ? false : null;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    // Bookkeeping entries (system, attachment, last-prompt, …) may trail
    // the exchange; they say nothing about whether it is complete.
    if (entry.type !== 'assistant' && entry.type !== 'user') continue;
    let text = assistantText(entry);
    if (!text) {
      // A tool call/result with nothing after it: mid-turn.
      settled ??= false;
      continue;
    }
    // The message may span several JSONL entries (one per content block);
    // stitch earlier blocks of the same message back on.
    const id = entry.message?.id;
    for (let j = i - 1; id && j >= 0 && entries[j].message?.id === id; j--) {
      const earlier = assistantText(entries[j]);
      if (earlier) text = `${earlier}\n${text}`;
    }
    return { text, settled: settled ?? true };
  }
  return { text: null, settled: false };
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

  // Wait for the final assistant message to land in the transcript; on
  // timeout fall back to the last text we did find (best effort).
  const deadline = Date.now() + OUTCOME_SETTLE_TIMEOUT_MS;
  let outcome;
  for (;;) {
    const { text, settled } = extractOutcome(input.transcript_path);
    outcome = text;
    if (settled || Date.now() >= deadline) break;
    await sleep(OUTCOME_POLL_INTERVAL_MS);
  }
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
