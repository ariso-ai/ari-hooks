import { join } from 'node:path';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
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

  const response = await fetch(new URL('/claude-tasks', getApiUrl(config)), {
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
    throw new Error(`POST /claude-tasks failed: ${response.status}`);
  }

  rmSync(sessionPath(input.session_id), { force: true });
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
    }
  } catch (err) {
    logError(err);
  }
  process.exit(0);
}
