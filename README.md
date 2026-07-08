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
ari-hooks
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
| `ari-hooks` | Login (if needed) + set up hooks in the current folder |
| `ari-hooks login` | Browser login, stores the API token |
| `ari-hooks init` | Just add the hooks to `./.claude/settings.json` |
| `ari-hooks status` | Show login state |
| `ari-hooks logout` | Delete the stored token |

### Configuration

Environment variables (all optional):

- `ARI_HOOKS_API_URL` — override the API base URL (default `https://api.ari.ariso.ai`)
- `ARI_HOOKS_WEB_URL` — override the web app URL used for login (default `https://web.ari.ariso.ai`)
- `ARI_HOOKS_HOME` — override the config directory (default `~/.ari-hooks`)

`--api-url` / `--web-url` flags on `login` persist the override into the config.

## Notes

- Hooks never break your Claude Code session: every failure is swallowed and
  logged to `~/.ari-hooks/error.log`.
- Only the request text and the final assistant message are sent — no tool
  calls, diffs, or intermediate steps.
