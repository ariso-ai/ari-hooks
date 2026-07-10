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

function runHook(event, input, home) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [BIN, 'hook', event],
      { env: { ...process.env, ARI_HOOKS_HOME: home } },
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

  await execFileAsync(process.execPath, [BIN, 'init'], { cwd });
  const settings = JSON.parse(readFileSync(join(cwd, '.claude', 'settings.json'), 'utf8'));

  // Pre-existing settings and hooks survive.
  assert.deepEqual(settings.permissions, { allow: ['Bash(ls:*)'] });
  assert.equal(settings.hooks.Stop.length, 2);
  assert.equal(settings.hooks.Stop[0].hooks[0].command, 'echo done');
  assert.match(settings.hooks.Stop[1].hooks[0].command, /ari-hooks hook stop/);
  assert.match(settings.hooks.UserPromptSubmit[0].hooks[0].command, /ari-hooks hook user-prompt-submit/);
  assert.match(settings.hooks.SessionStart[0].hooks[0].command, /ari-hooks hook session-start/);

  // Second run adds nothing.
  await execFileAsync(process.execPath, [BIN, 'init'], { cwd });
  const again = JSON.parse(readFileSync(join(cwd, '.claude', 'settings.json'), 'utf8'));
  assert.equal(again.hooks.Stop.length, 2);
  assert.equal(again.hooks.UserPromptSubmit.length, 1);
  assert.equal(again.hooks.SessionStart.length, 1);
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
    home
  );
  server.close();

  assert.equal(received.length, 1);
  assert.equal(received[0].url, '/agent-activities');
  assert.equal(received[0].auth, 'Bearer ari_testtoken');
  assert.equal(received[0].body.request, 'Fix the login bug');
  assert.equal(received[0].body.outcome, 'Fixed the login bug by patching auth.ts.');
  assert.equal(received[0].body.session_id, sessionId);
  assert.equal(received[0].body.cwd, '/tmp/project');

  // Session state is cleared after a successful send.
  assert.ok(!existsSync(join(home, 'sessions', 'sess-123.json')));
});

test('install sets up hooks (skipping login when a token exists); bare command just prints usage', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ari-hooks-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ari-hooks-install-'));
  const env = { ...process.env, ARI_HOOKS_HOME: home };

  // Already logged in → install must not start the browser login flow
  // (which would hang the test) and must write the hooks.
  writeFileSync(join(home, 'config.json'), JSON.stringify({ token: 'ari_testtoken' }));
  await execFileAsync(process.execPath, [BIN, 'install'], { cwd, env });
  const settings = JSON.parse(readFileSync(join(cwd, '.claude', 'settings.json'), 'utf8'));
  assert.match(settings.hooks.Stop[0].hooks[0].command, /ari-hooks hook stop/);
  assert.match(settings.hooks.UserPromptSubmit[0].hooks[0].command, /ari-hooks hook user-prompt-submit/);

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
