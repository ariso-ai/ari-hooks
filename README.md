# ari-hooks

Shares your Claude Code activity with [Ari](https://ariso.ai): after every
Claude Code turn, the hooks send your request and the final outcome (not the
intermediate steps) to Ari. When a session starts, Ari suggests the top
things Claude can take care of for you right now — pick one and Claude runs
it.

## Install

```bash
npm install -g ari-hooks
```

## Use

In any project folder where you use Claude Code:

```bash
ari-hooks install
```

That single command:

1. Opens your browser to log in to Ari and mint an API token (stored in
   `~/.ari-hooks/config.json`, `0600`). Only needed once per machine.
2. Detects which coding agents you use — Claude Code, Codex, and Cursor — and
   wires up the hooks for each one it finds (Claude Code by `~/.claude`, Codex
   by `~/.codex`, Cursor by the environment variables it sets in its terminal).
   If it can't tell, it defaults to Claude Code.
3. For Claude Code, adds three hooks to `./.claude/settings.json`:
   - `SessionStart` — fetches Ari's top suggested tasks and shows them when
     Claude Code boots; reply with a task number or name to run one
   - `UserPromptSubmit` — records what you asked for
   - `Stop` — reads the final assistant message from the transcript and sends
     the request/outcome pair to the Ari API

Existing settings and hooks are preserved; running it again is a no-op.

### Codex

Codex reads hooks from `.codex/hooks.json` (project) or `~/.codex/hooks.json`
(machine-wide), using the same nested shape as Claude Code. When `ari-hooks
install` (or `init`) detects Codex, it writes the two activity-sharing hooks
there:

- `UserPromptSubmit` — records what you asked for
- `Stop` — Codex hands the final assistant text to the hook directly (as
  `last_assistant_message`), and that request/outcome pair is sent to the Ari
  API

Codex has no user-visible channel to render Ari's suggested-task list, so the
`SessionStart` task prompt is skipped there.

### Cursor

Cursor's agent doesn't read `.claude/settings.json` — it has its own hooks
system in `.cursor/hooks.json`. When `ari-hooks install` (or `init`) runs
inside Cursor (detected via the `CURSOR_TRACE_ID` / `CURSOR_AGENT`
environment variables Cursor sets in its terminal and CLI agent), it also
writes the equivalent hooks there:

- `sessionStart` — injects Ari's suggested tasks as agent context
- `beforeSubmitPrompt` — records what you asked for
- `afterAgentResponse` — captures the final assistant text (Cursor's
  transcript isn't the Claude Code format, so the outcome is taken from
  this event instead)
- `stop` — sends the request/outcome pair to the Ari API

`ari-hooks uninstall` cleans up every file — Claude Code, Codex, and Cursor —
wherever it runs.

### Commands

| Command | What it does |
|---|---|
| `ari-hooks install` | Login (if needed) + detect your agents and set up their hooks in the current folder |
| `ari-hooks uninstall` | Remove the hooks from the Claude Code, Codex (`./.codex/hooks.json`, `~/.codex/hooks.json`), and Cursor files |
| `ari-hooks login` | Browser login, stores the API token |
| `ari-hooks init` | Just add the hooks to `./.claude/settings.json` (no login) |
| `ari-hooks config` | Show configured URLs and login state |
| `ari-hooks status` | Show login state |
| `ari-hooks logout` | Delete the stored token |

### Configuration

By default the CLI talks to production (`https://web.ari.ariso.ai` /
`https://api.ari.ariso.ai`). To test against a local Ari stack, persist
overrides with the URL flags (they work on any command):

```bash
ari-hooks config --web-url http://localhost:5173 --api-url http://localhost:4000
ari-hooks login                # browser flow now goes through localhost
ari-hooks config --reset-urls  # back to production
```

The overrides are stored in `~/.ari-hooks/config.json`, so the hooks
themselves also report to the configured API. Environment variables take
precedence over the stored config:

- `ARI_HOOKS_API_URL` — override the API base URL
- `ARI_HOOKS_WEB_URL` — override the web app URL used for login
- `ARI_HOOKS_HOME` — override the config directory (default `~/.ari-hooks`)

## Notes

- Hooks never break your Claude Code session: every failure is swallowed and
  logged to `~/.ari-hooks/error.log`.
- Only the request text and the final assistant message are sent — no tool
  calls, diffs, or intermediate steps.

## Author

Max Heckel
