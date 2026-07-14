import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ari-hooks.js');

// install/init detect Codex by the presence of ~/.codex (overridable via
// CODEX_HOME). The Claude/Cursor tests pin it at a path that does not exist so
// they behave the same whether or not the test machine has Codex installed —
// and, crucially, so a 'user'-scope run never writes into the real ~/.codex.
const NO_CODEX = { CODEX_HOME: join(tmpdir(), 'ari-hooks-codex-absent', 'nope') };

function runHook(event, input, home, env = {}, agent) {
  const args = [BIN, 'hook', event];
  if (agent) args.push('--agent', agent);
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      args,
      { env: { ...process.env, ARI_HOOKS_HOME: home, ...env } },
      (err, stdout, stderr) => (err ? reject(err) : resolve({ stdout, stderr }))
    );
    child.stdin.end(JSON.stringify(input));
  });
}

test('init merges hooks into .claude/settings.json and is idempotent', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ari-hooks-init-'));
  mkdirSync(join(cwd, '.claude'));
  writeFileSync(
    join(cwd, '.claude', 'settings.json'),
    JSON.stringify({
      permissions: { allow: ['Bash(ls:*)'] },
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }] },
    })
  );

  const env = { ...process.env, ...NO_CODEX };
  await execFileAsync(process.execPath, [BIN, 'init'], { cwd, env });
  const settings = JSON.parse(readFileSync(join(cwd, '.claude', 'settings.json'), 'utf8'));

  // Pre-existing settings and hooks survive.
  assert.deepEqual(settings.permissions, { allow: ['Bash(ls:*)'] });
  assert.equal(settings.hooks.Stop.length, 2);
  assert.equal(settings.hooks.Stop[0].hooks[0].command, 'echo done');
  assert.match(settings.hooks.Stop[1].hooks[0].command, /ari-hooks hook stop/);
  assert.match(settings.hooks.UserPromptSubmit[0].hooks[0].command, /ari-hooks hook user-prompt-submit/);
  assert.match(settings.hooks.SessionStart[0].hooks[0].command, /ari-hooks hook session-start/);

  // Second run adds nothing.
  await execFileAsync(process.execPath, [BIN, 'init'], { cwd, env });
  const again = JSON.parse(readFileSync(join(cwd, '.claude', 'settings.json'), 'utf8'));
  assert.equal(again.hooks.Stop.length, 2);
  assert.equal(again.hooks.UserPromptSubmit.length, 1);
  assert.equal(again.hooks.SessionStart.length, 1);
});

test('init inside Cursor also writes .cursor/hooks.json and is idempotent', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ari-hooks-cursor-init-'));
  // Pre-existing Cursor hooks must survive the merge.
  mkdirSync(join(cwd, '.cursor'));
  writeFileSync(
    join(cwd, '.cursor', 'hooks.json'),
    JSON.stringify({
      version: 1,
      hooks: { stop: [{ command: 'echo done' }] },
    })
  );

  const env = { ...process.env, ...NO_CODEX, CURSOR_TRACE_ID: 'trace-abc' };
  await execFileAsync(process.execPath, [BIN, 'init'], { cwd, env });

  // Claude Code settings are still written alongside the Cursor hooks.
  assert.ok(existsSync(join(cwd, '.claude', 'settings.json')));

  const config = JSON.parse(readFileSync(join(cwd, '.cursor', 'hooks.json'), 'utf8'));
  assert.equal(config.version, 1);
  assert.equal(config.hooks.stop[0].command, 'echo done');
  assert.match(config.hooks.stop[1].command, /ari-hooks hook stop/);
  assert.match(config.hooks.sessionStart[0].command, /ari-hooks hook session-start/);
  assert.match(config.hooks.beforeSubmitPrompt[0].command, /ari-hooks hook user-prompt-submit/);
  assert.match(config.hooks.afterAgentResponse[0].command, /ari-hooks hook agent-response/);

  // Second run adds nothing.
  await execFileAsync(process.execPath, [BIN, 'init'], { cwd, env });
  const again = JSON.parse(readFileSync(join(cwd, '.cursor', 'hooks.json'), 'utf8'));
  assert.equal(again.hooks.stop.length, 2);
  assert.equal(again.hooks.beforeSubmitPrompt.length, 1);

  // Uninstall strips only the ari-hooks entries from both files.
  await execFileAsync(process.execPath, [BIN, 'uninstall'], { cwd, env });
  const cleaned = JSON.parse(readFileSync(join(cwd, '.cursor', 'hooks.json'), 'utf8'));
  assert.deepEqual(cleaned, { version: 1, hooks: { stop: [{ command: 'echo done' }] } });
  assert.deepEqual(
    JSON.parse(readFileSync(join(cwd, '.claude', 'settings.json'), 'utf8')),
    {}
  );
});

// Blanks every Cursor marker: simulates a terminal that is not inside
// Cursor even when the test runner itself is.
const NOT_CURSOR_ENV = {
  CURSOR_TRACE_ID: '',
  CURSOR_AGENT: '',
  __CFBundleIdentifier: '',
  GIT_ASKPASS: '',
  VSCODE_GIT_ASKPASS_NODE: '',
  VSCODE_GIT_ASKPASS_MAIN: '',
};

test('init outside Cursor leaves .cursor alone', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ari-hooks-nocursor-init-'));
  const env = { ...process.env, ...NOT_CURSOR_ENV, ...NO_CODEX };
  await execFileAsync(process.execPath, [BIN, 'init'], { cwd, env });
  assert.ok(existsSync(join(cwd, '.claude', 'settings.json')));
  assert.ok(!existsSync(join(cwd, '.cursor')));
  assert.ok(!existsSync(join(cwd, '.codex')));
});

test('init detects Codex (~/.codex) and writes .codex/hooks.json without SessionStart', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ari-hooks-codex-init-'));
  const codexHome = mkdtempSync(join(tmpdir(), 'ari-hooks-codex-home-'));
  // A Codex user who is not inside Cursor: detection is by the ~/.codex dir.
  const env = { ...process.env, ...NOT_CURSOR_ENV, CODEX_HOME: codexHome };

  // Pre-existing Codex hooks must survive the merge.
  mkdirSync(join(cwd, '.codex'));
  writeFileSync(
    join(cwd, '.codex', 'hooks.json'),
    JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }] } })
  );

  await execFileAsync(process.execPath, [BIN, 'init'], { cwd, env });

  // Claude Code settings are still written alongside the Codex hooks.
  assert.ok(existsSync(join(cwd, '.claude', 'settings.json')));

  const config = JSON.parse(readFileSync(join(cwd, '.codex', 'hooks.json'), 'utf8'));
  assert.equal(config.hooks.Stop[0].hooks[0].command, 'echo done');
  assert.match(config.hooks.Stop[1].hooks[0].command, /ari-hooks hook stop/);
  assert.match(config.hooks.UserPromptSubmit[0].hooks[0].command, /ari-hooks hook user-prompt-submit/);
  // Codex has no channel to render the task list, so SessionStart is skipped.
  assert.equal(config.hooks.SessionStart, undefined);

  // Second run adds nothing.
  await execFileAsync(process.execPath, [BIN, 'init'], { cwd, env });
  const again = JSON.parse(readFileSync(join(cwd, '.codex', 'hooks.json'), 'utf8'));
  assert.equal(again.hooks.Stop.length, 2);
  assert.equal(again.hooks.UserPromptSubmit.length, 1);

  // Uninstall strips only the ari-hooks entries from the Codex file.
  await execFileAsync(process.execPath, [BIN, 'uninstall'], { cwd, env });
  const cleaned = JSON.parse(readFileSync(join(cwd, '.codex', 'hooks.json'), 'utf8'));
  assert.deepEqual(cleaned, {
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }] },
  });
});

test('init --user scope for Codex writes to CODEX_HOME/hooks.json', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ari-hooks-codex-user-'));
  const codexHome = mkdtempSync(join(tmpdir(), 'ari-hooks-codex-home-'));
  const env = {
    CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'ari-hooks-user-claude-')),
    CODEX_HOME: codexHome,
    CURSOR_TRACE_ID: '',
    CURSOR_AGENT: '',
  };

  const { init, uninstall } = await import('../src/init.js');
  const restore = console.log;
  console.log = () => {};
  try {
    init(cwd, env, 'user');
    const user = JSON.parse(readFileSync(join(codexHome, 'hooks.json'), 'utf8'));
    assert.match(user.hooks.Stop[0].hooks[0].command, /ari-hooks hook stop/);
    // Project-level file untouched at user scope.
    assert.ok(!existsSync(join(cwd, '.codex', 'hooks.json')));

    uninstall(cwd, env);
    assert.deepEqual(JSON.parse(readFileSync(join(codexHome, 'hooks.json'), 'utf8')), {});
  } finally {
    console.log = restore;
  }
});

test('detectAgents finds claude, codex, and cursor by their tells', async () => {
  const { detectAgents } = await import('../src/init.js');
  const claudeHome = mkdtempSync(join(tmpdir(), 'ari-hooks-det-claude-'));
  const codexHome = mkdtempSync(join(tmpdir(), 'ari-hooks-det-codex-'));
  const absent = join(tmpdir(), 'ari-hooks-det-absent', 'nope');

  // Nothing present → falls back to Claude Code so a fresh machine still works.
  assert.deepEqual(
    [...detectAgents({ ...NOT_CURSOR_ENV, CLAUDE_CONFIG_DIR: absent, CODEX_HOME: absent })],
    ['claude']
  );

  // Each agent detected by its own signal.
  const all = detectAgents({
    CLAUDE_CONFIG_DIR: claudeHome,
    CODEX_HOME: codexHome,
    CURSOR_TRACE_ID: 'trace-abc',
  });
  assert.ok(all.has('claude'));
  assert.ok(all.has('codex'));
  assert.ok(all.has('cursor'));

  // Codex-only machine: no Claude config, not in Cursor.
  const codexOnly = detectAgents({
    ...NOT_CURSOR_ENV,
    CLAUDE_CONFIG_DIR: absent,
    CODEX_HOME: codexHome,
  });
  assert.deepEqual([...codexOnly], ['codex']);
});

test('isCursor spots agent vars, the bundle id, and Cursor install paths', async () => {
  const { isCursor } = await import('../src/init.js');

  assert.equal(isCursor({}), false);
  // Plain VS Code: TERM_PROGRAM matches but the install paths do not.
  assert.equal(
    isCursor({
      TERM_PROGRAM: 'vscode',
      GIT_ASKPASS:
        '/Applications/Visual Studio Code.app/Contents/Resources/app/extensions/git/dist/askpass.sh',
      __CFBundleIdentifier: 'com.microsoft.VSCode',
    }),
    false
  );

  assert.equal(isCursor({ CURSOR_TRACE_ID: 'trace-abc' }), true);
  assert.equal(isCursor({ CURSOR_AGENT: '1' }), true);
  // Regular Cursor integrated terminal on macOS: ToDesktop bundle id.
  assert.equal(isCursor({ __CFBundleIdentifier: 'com.todesktop.230313mzl4w4u92' }), true);
  // Helper paths point into the Cursor install (any platform).
  assert.equal(
    isCursor({
      GIT_ASKPASS:
        '/Applications/Cursor.app/Contents/Resources/app/extensions/git/dist/askpass.sh',
    }),
    true
  );
  assert.equal(
    isCursor({
      VSCODE_GIT_ASKPASS_NODE:
        'C:\\Users\\max\\AppData\\Local\\Programs\\cursor\\Cursor.exe',
    }),
    true
  );
});

test('uninstall removes only the ari-hooks entries and is safe to re-run', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ari-hooks-uninstall-'));
  mkdirSync(join(cwd, '.claude'));
  writeFileSync(
    join(cwd, '.claude', 'settings.json'),
    JSON.stringify({
      permissions: { allow: ['Bash(ls:*)'] },
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }] },
    })
  );

  await execFileAsync(process.execPath, [BIN, 'init'], { cwd });
  const { stdout } = await execFileAsync(process.execPath, [BIN, 'uninstall'], { cwd });
  assert.match(stdout, /removed/);

  const settings = JSON.parse(readFileSync(join(cwd, '.claude', 'settings.json'), 'utf8'));
  // Unrelated settings and hooks survive; ari-hooks entries are gone.
  assert.deepEqual(settings.permissions, { allow: ['Bash(ls:*)'] });
  assert.deepEqual(settings.hooks, {
    Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }],
  });

  // Second run finds nothing to remove and leaves the file untouched.
  const { stdout: again } = await execFileAsync(process.execPath, [BIN, 'uninstall'], { cwd });
  assert.match(again, /nothing to remove/);
  assert.deepEqual(
    JSON.parse(readFileSync(join(cwd, '.claude', 'settings.json'), 'utf8')),
    settings
  );

  // A folder that was never installed is a friendly no-op too.
  const bare = mkdtempSync(join(tmpdir(), 'ari-hooks-uninstall-bare-'));
  const { stdout: none } = await execFileAsync(process.execPath, [BIN, 'uninstall'], { cwd: bare });
  assert.match(none, /nothing to remove/);
});

test('uninstall drops the hooks key entirely when ari-hooks was the only hook', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ari-hooks-uninstall-only-'));
  await execFileAsync(process.execPath, [BIN, 'init'], { cwd });
  await execFileAsync(process.execPath, [BIN, 'uninstall'], { cwd });

  const settings = JSON.parse(readFileSync(join(cwd, '.claude', 'settings.json'), 'utf8'));
  assert.deepEqual(settings, {});
});

test('user-prompt-submit + stop sends request/outcome to the API', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ari-hooks-home-'));

  const received = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({
        url: req.url,
        auth: req.headers.authorization,
        body: JSON.parse(body),
      });
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'evt_1' }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const apiUrl = `http://127.0.0.1:${server.address().port}`;

  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify({ token: 'ari_testtoken', apiUrl })
  );

  const transcriptPath = join(home, 'transcript.jsonl');
  writeFileSync(
    transcriptPath,
    [
      JSON.stringify({ type: 'user', message: { content: 'Fix the login bug' } }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Bash' }] },
      }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Fixed the login bug by patching auth.ts.' }] },
      }),
      '',
    ].join('\n')
  );

  const sessionId = 'sess-123';
  await runHook('user-prompt-submit', { session_id: sessionId, prompt: 'Fix the login bug' }, home);
  assert.ok(existsSync(join(home, 'sessions', 'sess-123.json')));

  await runHook(
    'stop',
    { session_id: sessionId, transcript_path: transcriptPath, cwd: '/tmp/project', stop_hook_active: false },
    home,
    {},
    'claude'
  );
  server.close();

  assert.equal(received.length, 1);
  assert.equal(received[0].url, '/agent-activities');
  assert.equal(received[0].auth, 'Bearer ari_testtoken');
  assert.equal(received[0].body.request, 'Fix the login bug');
  assert.equal(received[0].body.outcome, 'Fixed the login bug by patching auth.ts.');
  assert.equal(received[0].body.session_id, sessionId);
  assert.equal(received[0].body.agent_type, 'claude-code');
  assert.equal(received[0].body.cwd, '/tmp/project');

  // Session state is cleared after a successful send.
  assert.ok(!existsSync(join(home, 'sessions', 'sess-123.json')));
});

// Claude Code delivers a background task's completion as a synthetic
// UserPromptSubmit turn whose entire prompt is a <task-notification> block —
// not something the user typed. It gets swapped for a short summary instead
// of recorded verbatim.
test('user-prompt-submit swaps synthetic task-notification prompts for a summary', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ari-hooks-home-'));
  const sessionId = 'sess-notif';

  const notification =
    '<task-notification>\n<task-id>abc123</task-id>\n<status>completed</status>\n' +
    '<summary>Background command "Run tests &amp; lint" completed (exit code 0)</summary>\n' +
    '</task-notification>';
  await runHook('user-prompt-submit', { session_id: sessionId, prompt: notification }, home);
  let session = JSON.parse(readFileSync(join(home, 'sessions', `${sessionId}.json`), 'utf8'));
  assert.deepEqual(session.prompts, [
    'The coding agent ran a background task: Background command "Run tests & lint" completed (exit code 0)',
  ]);

  // A genuine prompt in the same session is still recorded verbatim.
  await runHook('user-prompt-submit', { session_id: sessionId, prompt: 'Fix the login bug' }, home);
  session = JSON.parse(readFileSync(join(home, 'sessions', `${sessionId}.json`), 'utf8'));
  assert.equal(session.prompts[1], 'Fix the login bug');

  // No <summary> block: falls back to a generic stand-in rather than the raw XML.
  const noSummary = '<task-notification>\n<task-id>x</task-id>\n</task-notification>';
  await runHook('user-prompt-submit', { session_id: sessionId, prompt: noSummary }, home);
  session = JSON.parse(readFileSync(join(home, 'sessions', `${sessionId}.json`), 'utf8'));
  assert.equal(session.prompts[2], 'The coding agent ran a background task.');
});

// Helper for the stop-hook race tests: a stub API plus a config pointing at it.
async function stopTestSetup() {
  const home = mkdtempSync(join(tmpdir(), 'ari-hooks-home-'));
  const received = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push(JSON.parse(body));
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'evt_1' }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify({ token: 'ari_testtoken', apiUrl: `http://127.0.0.1:${server.address().port}` })
  );
  return { home, received, server };
}

// Claude Code fires Stop while the final assistant message may still be
// mid-flush: the transcript ends at the tool result (plus a half-written
// line). The hook must wait for the real final message instead of shipping
// the pre-tool narration as the outcome.
test('stop waits for the final assistant message to finish flushing', async () => {
  const { home, received, server } = await stopTestSetup();
  const transcriptPath = join(home, 'transcript.jsonl');

  const midFlush =
    [
      JSON.stringify({ type: 'user', message: { content: 'Trace the LLM call' } }),
      JSON.stringify({
        type: 'assistant',
        message: { id: 'msg_1', content: [{ type: 'text', text: 'Now running verification as required.' }] },
      }),
      JSON.stringify({
        type: 'assistant',
        message: { id: 'msg_1', content: [{ type: 'tool_use', name: 'Bash' }] },
      }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result' }] } }),
      JSON.stringify({ type: 'attachment' }),
    ].join('\n') + '\n{"type":"assis'; // final message cut off mid-write

  const complete =
    midFlush.slice(0, midFlush.lastIndexOf('{')) +
    [
      // Final message split across two entries (one per content block).
      JSON.stringify({
        type: 'assistant',
        message: { id: 'msg_2', content: [{ type: 'text', text: 'Done. The LLM call now traces to Langfuse.' }] },
      }),
      JSON.stringify({
        type: 'assistant',
        message: { id: 'msg_2', content: [{ type: 'text', text: 'All 219 verification tasks passed.' }] },
      }),
      JSON.stringify({ type: 'system', subtype: 'turn_duration' }),
      '',
    ].join('\n');

  writeFileSync(transcriptPath, midFlush);
  await runHook('user-prompt-submit', { session_id: 'sess-race', prompt: 'Trace the LLM call' }, home);

  // Finish the flush ~300ms after the stop hook starts reading.
  const flush = setTimeout(() => writeFileSync(transcriptPath, complete), 300);
  await runHook('stop', { session_id: 'sess-race', transcript_path: transcriptPath }, home);
  clearTimeout(flush);
  server.close();

  assert.equal(received.length, 1);
  assert.equal(
    received[0].outcome,
    'Done. The LLM call now traces to Langfuse.\nAll 219 verification tasks passed.'
  );
});

// If the final message never lands, time out and fall back to the last
// assistant text we did find rather than dropping the activity.
test('stop falls back to the pre-tool narration when the flush never settles', async () => {
  const { home, received, server } = await stopTestSetup();
  const transcriptPath = join(home, 'transcript.jsonl');
  writeFileSync(
    transcriptPath,
    [
      JSON.stringify({ type: 'user', message: { content: 'Trace the LLM call' } }),
      JSON.stringify({
        type: 'assistant',
        message: { id: 'msg_1', content: [{ type: 'text', text: 'Now running verification as required.' }] },
      }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result' }] } }),
      '',
    ].join('\n')
  );

  await runHook('user-prompt-submit', { session_id: 'sess-stall', prompt: 'Trace the LLM call' }, home);
  await runHook(
    'stop',
    { session_id: 'sess-stall', transcript_path: transcriptPath },
    home,
    { ARI_HOOKS_SETTLE_TIMEOUT_MS: '400' }
  );
  server.close();

  assert.equal(received.length, 1);
  assert.equal(received[0].outcome, 'Now running verification as required.');
});

// Cursor hooks send conversation_id (not session_id) and no parseable
// transcript; afterAgentResponse hands us the assistant text instead.
test('cursor payloads: prompt + agent-response + stop send request/outcome', async () => {
  const { home, received, server } = await stopTestSetup();
  const base = {
    conversation_id: 'conv-42',
    cursor_version: '1.7.0',
    workspace_roots: ['/tmp/cursor-project'],
    transcript_path: null,
  };

  await runHook('user-prompt-submit', { ...base, prompt: 'Fix the login bug' }, home);
  assert.ok(existsSync(join(home, 'sessions', 'conv-42.json')));

  // Fires per assistant message; the last text wins as the outcome.
  await runHook('agent-response', { ...base, text: 'Looking into it.' }, home);
  await runHook('agent-response', { ...base, text: 'Fixed the login bug in auth.ts.' }, home);

  await runHook('stop', { ...base, status: 'completed', loop_count: 0 }, home, {}, 'cursor');
  server.close();

  assert.equal(received.length, 1);
  assert.equal(received[0].request, 'Fix the login bug');
  assert.equal(received[0].outcome, 'Fixed the login bug in auth.ts.');
  assert.equal(received[0].session_id, 'conv-42');
  assert.equal(received[0].agent_type, 'cursor');
  assert.equal(received[0].cwd, '/tmp/cursor-project');
  assert.ok(!existsSync(join(home, 'sessions', 'conv-42.json')));
});

// Codex hands the final assistant text to the Stop hook directly as
// last_assistant_message — there is no transcript to poll — so onStop pairs
// it with the stored prompt and ships it.
test('codex payload: stop uses last_assistant_message as the outcome', async () => {
  const { home, received, server } = await stopTestSetup();

  await runHook('user-prompt-submit', { session_id: 'codex-1', prompt: 'Fix the login bug' }, home);
  await runHook(
    'stop',
    {
      session_id: 'codex-1',
      cwd: '/tmp/codex-project',
      stop_hook_active: false,
      last_assistant_message: 'Fixed the login bug by patching auth.ts.',
    },
    home,
    {},
    'codex'
  );
  server.close();

  assert.equal(received.length, 1);
  assert.equal(received[0].request, 'Fix the login bug');
  assert.equal(received[0].outcome, 'Fixed the login bug by patching auth.ts.');
  assert.equal(received[0].session_id, 'codex-1');
  assert.equal(received[0].agent_type, 'codex');
  assert.equal(received[0].cwd, '/tmp/codex-project');
  assert.ok(!existsSync(join(home, 'sessions', 'codex-1.json')));
});

// Installs that predate the --agent flag send no flag; onStop falls back to
// sniffing the payload so their activities still carry an agent_type.
test('stop without --agent falls back to the payload to derive agent_type', async () => {
  const { home, received, server } = await stopTestSetup();

  // Cursor: cursor_version marks the payload even with no flag.
  await runHook('user-prompt-submit', { conversation_id: 'c1', cursor_version: '1.7.0', prompt: 'x' }, home);
  await runHook('agent-response', { conversation_id: 'c1', cursor_version: '1.7.0', text: 'done' }, home);
  await runHook('stop', { conversation_id: 'c1', cursor_version: '1.7.0' }, home);

  // Codex: neither cursor_version nor transcript_path.
  await runHook('user-prompt-submit', { session_id: 'x1', prompt: 'x' }, home);
  await runHook('stop', { session_id: 'x1', last_assistant_message: 'done' }, home);
  server.close();

  assert.deepEqual(
    received.map((r) => r.agent_type),
    ['cursor', 'codex']
  );
});

// The interactive scope prompts only fire on a TTY (covered by install's
// chooseClaudeScope); here we drive init with each scope directly.
test('init scopes: local writes settings.local.json, user writes to CLAUDE_CONFIG_DIR', async (t) => {
  const { init, uninstall } = await import('../src/init.js');
  const silence = () => {};
  t.mock.method(console, 'log', silence);

  const cwd = mkdtempSync(join(tmpdir(), 'ari-hooks-scope-'));
  const configDir = mkdtempSync(join(tmpdir(), 'ari-hooks-user-claude-'));
  const env = {
    CLAUDE_CONFIG_DIR: configDir,
    CURSOR_TRACE_ID: '',
    CURSOR_AGENT: '',
    ...NO_CODEX,
  };

  init(cwd, env, 'local');
  const local = JSON.parse(
    readFileSync(join(cwd, '.claude', 'settings.local.json'), 'utf8')
  );
  assert.match(local.hooks.Stop[0].hooks[0].command, /ari-hooks hook stop/);
  // The shared project file is untouched.
  assert.ok(!existsSync(join(cwd, '.claude', 'settings.json')));

  init(cwd, env, 'user');
  const user = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8'));
  assert.match(user.hooks.SessionStart[0].hooks[0].command, /ari-hooks hook session-start/);

  // Uninstall sweeps every scope install can write to.
  uninstall(cwd, env);
  assert.deepEqual(
    JSON.parse(readFileSync(join(cwd, '.claude', 'settings.local.json'), 'utf8')),
    {}
  );
  assert.deepEqual(
    JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8')),
    {}
  );
});

test('install sets up hooks (skipping login when a token exists); bare command just prints usage', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ari-hooks-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ari-hooks-install-'));
  const env = { ...process.env, ARI_HOOKS_HOME: home, ...NO_CODEX };

  // Already logged in → install must not start the browser login flow
  // (which would hang the test) and must write the hooks.
  writeFileSync(join(home, 'config.json'), JSON.stringify({ token: 'ari_testtoken' }));
  await execFileAsync(process.execPath, [BIN, 'install'], { cwd, env });
  const settings = JSON.parse(readFileSync(join(cwd, '.claude', 'settings.json'), 'utf8'));
  assert.match(settings.hooks.Stop[0].hooks[0].command, /ari-hooks hook stop/);
  assert.match(settings.hooks.UserPromptSubmit[0].hooks[0].command, /ari-hooks hook user-prompt-submit/);

  // Inside Cursor, install writes .cursor/hooks.json alongside the Claude
  // settings, exactly like init does.
  const cursorCwd = mkdtempSync(join(tmpdir(), 'ari-hooks-install-cursor-'));
  await execFileAsync(process.execPath, [BIN, 'install'], {
    cwd: cursorCwd,
    env: { ...env, CURSOR_TRACE_ID: 'trace-abc' },
  });
  assert.ok(existsSync(join(cursorCwd, '.claude', 'settings.json')));
  const cursorHooks = JSON.parse(
    readFileSync(join(cursorCwd, '.cursor', 'hooks.json'), 'utf8')
  );
  assert.match(cursorHooks.hooks.stop[0].command, /ari-hooks hook stop/);

  // Bare invocation is informational only — no hooks written.
  const bareCwd = mkdtempSync(join(tmpdir(), 'ari-hooks-bare-'));
  const { stdout } = await execFileAsync(process.execPath, [BIN], { cwd: bareCwd, env });
  assert.match(stdout, /Usage:/);
  assert.ok(!existsSync(join(bareCwd, '.claude')));
});

test('config --web-url/--api-url persists overrides; --reset-urls clears them', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ari-hooks-config-'));
  const env = { ...process.env, ARI_HOOKS_HOME: home };
  delete env.ARI_HOOKS_WEB_URL;
  delete env.ARI_HOOKS_API_URL;

  const { stdout } = await execFileAsync(
    process.execPath,
    [BIN, 'config', '--web-url', 'http://localhost:5173/', '--api-url', 'http://localhost:4000'],
    { env }
  );
  assert.match(stdout, /Web URL: http:\/\/localhost:5173/);
  assert.match(stdout, /API URL: http:\/\/localhost:4000/);

  // Trailing slash is normalized away and the values survive a reload.
  const saved = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
  assert.equal(saved.webUrl, 'http://localhost:5173');
  assert.equal(saved.apiUrl, 'http://localhost:4000');

  // An invalid URL is rejected without clobbering the config.
  await assert.rejects(
    execFileAsync(process.execPath, [BIN, 'config', '--api-url', 'not-a-url'], { env }),
    /not a valid URL/
  );

  const { stdout: reset } = await execFileAsync(
    process.execPath,
    [BIN, 'config', '--reset-urls'],
    { env }
  );
  assert.match(reset, /Web URL: https:\/\/web\.ari\.ariso\.ai/);
  assert.match(reset, /API URL: https:\/\/api\.ari\.ariso\.ai/);
});

test('session-start fetches /agent-tasks and emits a visible list plus context', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ari-hooks-home-'));

  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ url: req.url, auth: req.headers.authorization });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // The real API wraps the list in { tasks: [...] }.
    res.end(
      JSON.stringify({
        tasks: [
          { taskName: 'Triage new bug reports', prompt: 'Look at the open bug reports and triage them.' },
          { taskName: 'Update the changelog', prompt: 'Write changelog entries for unreleased commits.' },
          { taskName: 'Fix flaky tests', prompt: 'Find and fix the flaky tests in CI.' },
          { taskName: 'A fourth task that must be dropped', prompt: 'nope' },
        ],
      })
    );
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const apiUrl = `http://127.0.0.1:${server.address().port}`;

  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify({ token: 'ari_testtoken', apiUrl })
  );

  const { stdout } = await runHook(
    'session-start',
    { session_id: 'sess-1', source: 'startup', cwd: '/tmp/project' },
    home
  );
  server.close();

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/agent-tasks');
  assert.equal(requests[0].auth, 'Bearer ari_testtoken');

  const output = JSON.parse(stdout);
  // The user-visible list names the top 3 tasks, nothing more (ANSI styling
  // sits between the number and the name).
  assert.match(output.systemMessage, /1\..*Triage new bug reports/);
  assert.match(output.systemMessage, /3\..*Fix flaky tests/);
  assert.doesNotMatch(output.systemMessage, /fourth task/);
  // Claude's hidden context carries the prompts to run on request.
  assert.equal(output.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(
    output.hookSpecificOutput.additionalContext,
    /Look at the open bug reports and triage them\./
  );
});

test('session-start from Cursor emits flat additional_context and skips background agents', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ari-hooks-home-'));

  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        tasks: [{ taskName: 'Triage new bug reports', prompt: 'Look at the open bug reports.' }],
      })
    );
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify({ token: 'ari_testtoken', apiUrl: `http://127.0.0.1:${server.address().port}` })
  );

  const cursorInput = {
    conversation_id: 'conv-1',
    session_id: 'sess-1',
    cursor_version: '1.7.0',
    composer_mode: 'agent',
    is_background_agent: false,
  };
  const { stdout } = await runHook('session-start', cursorInput, home);

  const output = JSON.parse(stdout);
  // Cursor's sessionStart output shape: no systemMessage/hookSpecificOutput.
  assert.equal(output.systemMessage, undefined);
  assert.equal(output.hookSpecificOutput, undefined);
  assert.match(output.additional_context, /Triage new bug reports/);
  assert.match(output.additional_context, /Look at the open bug reports\./);

  // Headless background agents get nothing — no user to pick a task.
  const bg = await runHook('session-start', { ...cursorInput, is_background_agent: true }, home);
  assert.equal(bg.stdout, '');
  server.close();
});

test('session-start is a silent no-op on compact, without a token, or with no tasks', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ari-hooks-home-'));

  // No token → no output, no network.
  let result = await runHook('session-start', { source: 'startup' }, home);
  assert.equal(result.stdout, '');

  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([]));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const apiUrl = `http://127.0.0.1:${server.address().port}`;
  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify({ token: 'ari_testtoken', apiUrl })
  );

  // Compact → skipped even when logged in.
  result = await runHook('session-start', { source: 'compact' }, home);
  assert.equal(result.stdout, '');

  // Empty task list → nothing shown.
  result = await runHook('session-start', { source: 'startup' }, home);
  assert.equal(result.stdout, '');
  server.close();
});

test('stop hook is a silent no-op without a stored prompt or token', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ari-hooks-home-'));
  // No config.json, no session state — must exit 0 without network access.
  const { stderr } = await runHook(
    'stop',
    { session_id: 'nope', transcript_path: join(home, 'missing.jsonl') },
    home
  );
  assert.equal(stderr, '');
});
