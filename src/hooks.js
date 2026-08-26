import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

// Claude Code identifies the session as session_id; Cursor hooks send
// conversation_id (their sessionStart also has a session_id, but the other
// events do not, so the conversation is our stable per-turn key).
const sessionIdOf = (input) => input.session_id ?? input.conversation_id;

// Every Cursor hook payload carries cursor_version; Claude Code's never do.
const isCursorInput = (input) => typeof input.cursor_version === 'string';

// agent_type values, keyed by the --agent slug the hook command passes (init
// bakes it into each agent's config file).
const AGENT_TYPES = { claude: 'claude-code', codex: 'codex', cursor: 'cursor' };

// Which coding agent produced this turn. The --agent flag from the hook command
// is the reliable source; fall back to sniffing the payload for installs that
// predate the flag — Cursor stamps cursor_version, Claude Code sends a
// transcript_path, and Codex has neither (it hands us last_assistant_message).
function agentTypeOf(input, agent) {
  if (AGENT_TYPES[agent]) return AGENT_TYPES[agent];
  if (isCursorInput(input)) return 'cursor';
  if (input.transcript_path) return 'claude-code';
  return 'codex';
}

// Claude Code auto-delivers a background task's completion as a synthetic
// UserPromptSubmit turn — the entire prompt is a <task-notification> block,
// not something the user typed. Recording it verbatim as a "request"
// pollutes the activity feed with agent-internal bookkeeping, so swap it for
// a short human-readable stand-in built from the notification's <summary>.
const TASK_NOTIFICATION_RE = /^<task-notification>[\s\S]*<\/task-notification>$/;
const SUMMARY_RE = /<summary>([\s\S]*?)<\/summary>/;
const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decodeXmlEntities = (text) =>
  text.replace(/&(amp|lt|gt|quot|apos);/g, (_, name) => XML_ENTITIES[name]);

function taskNotificationStandIn(prompt) {
  const trimmed = prompt.trim();
  if (!TASK_NOTIFICATION_RE.test(trimmed)) return null;
  const summary = trimmed.match(SUMMARY_RE)?.[1]?.trim();
  return summary
    ? `The coding agent ran a background task: ${decodeXmlEntities(summary)}`
    : 'The coding agent ran a background task.';
}

// The IDE integration injects the user's current editor selection into the
// prompt as an <ide_selection> block — host-added context, not text the user
// typed. Strip it before recording so the activity feed shows only what the
// user actually said.
const IDE_SELECTION_RE = /<ide_selection>[\s\S]*?<\/ide_selection>/g;
const stripIdeSelection = (prompt) => prompt.replace(IDE_SELECTION_RE, '').trim();

/**
 * UserPromptSubmit (Claude Code) / beforeSubmitPrompt (Cursor): remember the
 * prompt so the Stop hook can pair it with the turn's outcome. Both hosts
 * put the text in `prompt`.
 */
async function onUserPromptSubmit(input) {
  const sessionId = sessionIdOf(input);
  if (!sessionId || typeof input.prompt !== 'string') return;
  const prompt = stripIdeSelection(input.prompt);
  if (!prompt) return;
  const session = loadSession(sessionId);
  session.prompts.push(taskNotificationStandIn(prompt) ?? prompt);
  saveSession(sessionId, session);
}

// A model name from a hook payload, or null — hosts that include one send a
// plain non-empty string.
const modelOf = (value) =>
  typeof value === 'string' && value.trim() ? value : null;

/**
 * afterAgentResponse (Cursor only): Cursor's transcript is not the Claude
 * Code JSONL that extractOutcome can parse, so capture the final assistant
 * text as Cursor hands it to us. Fires once per assistant message; the last
 * one before stop is the turn's outcome.
 */
async function onAgentResponse(input) {
  const sessionId = sessionIdOf(input);
  if (!sessionId || typeof input.text !== 'string' || !input.text.trim()) return;
  const session = loadSession(sessionId);
  session.outcome = input.text;
  const model = modelOf(input.model);
  if (model) session.model = model;
  saveSession(sessionId, session);
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

function parseTranscript(transcriptPath) {
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
  return { entries, tailPartial };
}

/**
 * Pull the final assistant text out of the transcript entries. This is the
 * "outcome" — we deliberately skip the intermediate steps/tool calls.
 *
 * `settled` reports whether the exchange actually ends in assistant text.
 * When the transcript instead ends at a tool call/result or a half-written
 * line, the final message hasn't been flushed yet and `text` is only the
 * last narration before a tool ran — the caller should re-read rather than
 * ship that as the outcome.
 */
function extractOutcome(entries, tailPartial) {
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

// A user entry that is an actual typed prompt — not a tool result, not host
// bookkeeping (isMeta), not a subagent's inner conversation (isSidechain).
function isUserPrompt(entry) {
  if (entry.type !== 'user' || entry.isSidechain || entry.isMeta) return false;
  const content = entry.message?.content;
  if (typeof content === 'string') return content.trim().length > 0;
  return (
    Array.isArray(content) &&
    content.some((block) => block.type === 'text') &&
    !content.some((block) => block.type === 'tool_result')
  );
}

/**
 * Model and token usage for the turn being reported. The transcript holds
 * the whole session, so walk back past `promptCount` user prompts (this
 * send covers that many queued prompts) and only count assistant entries
 * after that point. Usage is keyed by message id — a message split across
 * several JSONL entries (one per content block) repeats the same usage on
 * each, and the last entry wins — then totalled over everything the API
 * metered: input, cache writes/reads, and output. The model is named by
 * the turn's last top-level assistant message; sidechain (subagent)
 * entries still count toward tokens.
 */
function extractTurnStats(entries, promptCount) {
  let boundary = -1;
  let remaining = Math.max(1, promptCount);
  for (let i = entries.length - 1; i >= 0 && remaining > 0; i--) {
    if (isUserPrompt(entries[i])) {
      boundary = i;
      remaining--;
    }
  }

  let model = null;
  const usageById = new Map();
  for (let i = boundary + 1; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.type !== 'assistant') continue;
    const message = entry.message ?? {};
    // '<synthetic>' marks host-injected error messages, not a real model.
    if (!entry.isSidechain && modelOf(message.model) && message.model !== '<synthetic>') {
      model = message.model;
    }
    if (message.usage) usageById.set(message.id ?? `entry-${i}`, message.usage);
  }

  let tokens = null;
  for (const usage of usageById.values()) {
    tokens =
      (tokens ?? 0) +
      (usage.input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0) +
      (usage.output_tokens ?? 0);
  }
  return { model, tokens };
}

const clamp = (text) =>
  text.length > MAX_TEXT_LENGTH ? text.slice(0, MAX_TEXT_LENGTH) : text;

/**
 * Stop: the turn is over — send the accumulated request(s) plus the final
 * assistant message (and, when the host exposes them, the model used and
 * the turn's token count) to Ari, then clear the per-session state.
 */
async function onStop(input, agent) {
  // stop_hook_active means a stop hook already forced Claude to continue;
  // the real end of the turn will fire another Stop event.
  if (input.stop_hook_active) return;
  const sessionId = sessionIdOf(input);
  if (!sessionId) return;

  const session = loadSession(sessionId);
  if (session.prompts.length === 0) return;

  // Cursor sessions get the outcome pushed to us via afterAgentResponse; Codex
  // hands us the final text directly on the Stop payload as
  // last_assistant_message; Claude Code sessions read it from the transcript,
  // waiting for the final assistant message to land there (on timeout, fall
  // back to the last text we did find — best effort).
  const payloadOutcome = session.outcome ?? input.last_assistant_message ?? null;
  let outcome = payloadOutcome;
  // Hosts that hand us the outcome directly may also name the model on their
  // payloads; Claude Code's model and token usage live only in the
  // transcript. Token counts are transcript-only — the other hosts don't
  // report usage. Recent Claude Code also sends last_assistant_message, so
  // the transcript is read for stats even when the outcome is already in
  // hand — but a stats failure must never cost us the activity itself.
  let model = modelOf(input.model) ?? session.model ?? null;
  let tokens = null;
  if (input.transcript_path) {
    const deadline = Date.now() + OUTCOME_SETTLE_TIMEOUT_MS;
    for (;;) {
      let entries, tailPartial;
      try {
        ({ entries, tailPartial } = parseTranscript(input.transcript_path));
      } catch (err) {
        logError(err);
        break;
      }
      const { text, settled } = extractOutcome(entries, tailPartial);
      outcome = payloadOutcome ?? text;
      // Even with the outcome in hand, wait for the final message to flush
      // so its usage makes it into the token count.
      if (settled || Date.now() >= deadline) {
        const stats = extractTurnStats(entries, session.prompts.length);
        model = stats.model ?? model;
        tokens = stats.tokens;
        break;
      }
      await sleep(OUTCOME_POLL_INTERVAL_MS);
    }
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
      session_id: sessionId,
      agent_type: agentTypeOf(input, agent),
      // Cursor sends workspace_roots instead of cwd.
      cwd: input.cwd ?? input.workspace_roots?.[0] ?? process.cwd(),
      // Only sent when known — the API treats absent and unknown alike.
      ...(model && { model }),
      ...(tokens != null && { token_count: tokens }),
    }),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`POST /agent-activities failed: ${response.status}`);
  }

  rmSync(sessionPath(sessionId), { force: true });
}

const MAX_TASKS = 3;
const MAX_TASK_NAME_LENGTH = 200;

const oneLine = (text) =>
  text.replace(/\s+/g, ' ').trim().slice(0, MAX_TASK_NAME_LENGTH);

async function fetchTasks(config) {
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
  return list
    .filter(
      (t) =>
        t &&
        typeof t.taskName === 'string' &&
        t.taskName.trim() &&
        typeof t.prompt === 'string' &&
        t.prompt.trim()
    )
    .slice(0, MAX_TASKS);
}

const NPM_PACKAGE = '@ariso-ai/ari-hooks';
const VERSION_CHECK_TIMEOUT_MS = 3_000;

const installedVersion = () =>
  JSON.parse(
    readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'),
      'utf8'
    )
  ).version;

// Plain x.y.z releases only — no prerelease/build-metadata tags to worry about.
const isNewer = (latest, current) => {
  const a = latest.split('.').map(Number);
  const b = current.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
};

/**
 * Compare the installed version against what npm has published. A stale or
 * unreachable registry must never break session start, so any failure just
 * skips the check (returns null, same as "up to date").
 */
async function checkForUpdate() {
  try {
    const registryUrl = process.env.ARI_HOOKS_REGISTRY_URL || 'https://registry.npmjs.org';
    const response = await fetch(new URL(`/${NPM_PACKAGE}/latest`, registryUrl), {
      signal: AbortSignal.timeout(VERSION_CHECK_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const { version: latest } = await response.json();
    const current = installedVersion();
    return typeof latest === 'string' && isNewer(latest, current)
      ? { current, latest }
      : null;
  } catch {
    return null;
  }
}

/**
 * SessionStart: ask Ari for the top tasks Claude can take care of right now
 * and surface them at boot — a visible list for the user (systemMessage)
 * plus the full prompts for Claude (additionalContext) so it can run
 * whichever one the user picks. Also checks whether a newer ari-hooks is
 * published, since this is the one moment we know a user is watching.
 */
async function onSessionStart(input) {
  // Compaction restarts the session mid-conversation; the tasks were
  // already offered, so don't show (or inject) them again.
  if (input.source === 'compact') return;
  // Cursor also fires sessionStart for headless background agents — there is
  // no user watching who could pick a task.
  if (input.is_background_agent) return;

  const config = loadConfig();
  if (!config.token) return;

  const [tasks, update] = await Promise.all([fetchTasks(config), checkForUpdate()]);
  if (tasks.length === 0 && !update) return;

  const updateNotice = update
    ? `ari-hooks ${update.current} is out of date (latest: ${update.latest}). ` +
      `Update it: npm install -g ${NPM_PACKAGE}@latest`
    : null;

  const taskContext =
    tasks.length > 0
      ? `The user has Ari connected via ari-hooks. At session start the user was ` +
        `shown this list of suggested tasks:\n\n` +
        tasks
          .map(
            (t, i) =>
              `Task ${i + 1}: ${oneLine(t.taskName)}\nPrompt: ${clamp(t.prompt)}`
          )
          .join('\n\n') +
        `\n\nIf the user asks to run one of these tasks (by number or name), ` +
        `carry out that task's prompt as if the user had typed it. Do not start ` +
        `any of these tasks unless the user asks.`
      : null;

  const additionalContext = [
    updateNotice ? `Note for the user: ${updateNotice}` : null,
    taskContext,
  ]
    .filter(Boolean)
    .join('\n\n');

  // Cursor's sessionStart output is a flat { additional_context } and it has
  // no user-visible systemMessage channel, so the agent itself must surface
  // the list (and the update notice).
  if (isCursorInput(input)) {
    writeSync(
      1,
      JSON.stringify({
        additional_context:
          additionalContext +
          (tasks.length > 0
            ? `\n\nNote: unlike Claude Code, Cursor did NOT show the user this ` +
              `list — briefly offer these tasks by name at the start of your ` +
              `first reply.`
            : ''),
      }) + '\n'
    );
    return;
  }

  // Claude Code renders systemMessage with ANSI intact; the leading \n
  // pushes our block below the fixed "SessionStart:<source> says:" prefix.
  const BOLD = '\x1b[1m';
  const CYAN = '\x1b[36m';
  const YELLOW = '\x1b[33m';
  const GREY = '\x1b[37m';
  const RESET = '\x1b[0m';

  const messageBlocks = [];
  if (updateNotice) messageBlocks.push(`${YELLOW}⚠ ${updateNotice}${RESET}`);
  if (tasks.length > 0) {
    const visibleList = tasks
      .map((t, i) => `  ${BOLD}${i + 1}.${RESET} ${oneLine(t.taskName)}`)
      .join('\n');
    messageBlocks.push(
      `${BOLD}${CYAN}✻ Ari — things Claude can take care of for you right now${RESET}\n` +
        `${visibleList}\n` +
        `${GREY}Reply "run task 1" (or the task name) to start one.${RESET}`
    );
  }
  const systemMessage = `\n${messageBlocks.join('\n')}`;

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
export async function runHook(event, agent) {
  try {
    const raw = await readStdin();
    const input = raw ? JSON.parse(raw) : {};
    if (event === 'user-prompt-submit') {
      await onUserPromptSubmit(input);
    } else if (event === 'agent-response') {
      await onAgentResponse(input);
    } else if (event === 'stop') {
      await onStop(input, agent);
    } else if (event === 'session-start') {
      await onSessionStart(input);
    }
  } catch (err) {
    logError(err);
  }
  process.exit(0);
}
