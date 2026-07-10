# ari-hooks

Shares your Claude Code activity with [Ari](https://ariso.ai): after every
Claude Code turn, the hooks send your request and the final outcome (not the
intermediate steps) to Ari.

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
2. Adds two hooks to `./.claude/settings.json`:
   - `UserPromptSubmit` — records what you asked for
   - `Stop` — reads the final assistant message from the transcript and sends
     the request/outcome pair to the Ari API

Existing settings and hooks are preserved; running it again is a no-op.

### Commands

| Command | What it does |
|---|---|
| `ari-hooks install` | Login (if needed) + set up hooks in the current folder |
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
