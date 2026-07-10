---
name: verify
description: How to verify ari-hooks changes end-to-end against a real Claude Code session
---

# Verifying ari-hooks

The surface is a Claude Code session in a folder where the hooks are
installed. Unit tests (`npm test`) exercise the hook binary against a stub
HTTP server, but real verification means booting `claude` and watching the
hooks fire.

## Recipe

1. **Stub the Ari API** — a small node `http.createServer` on
   `127.0.0.1:<port>` serving the endpoints the hooks call
   (`/agent-activities` POST, `/agent-tasks` GET). Log method/url/auth.
2. **Isolated config** — point `ARI_HOOKS_HOME` at a temp dir containing
   `config.json`: `{ "token": "test", "apiUrl": "http://127.0.0.1:<port>" }`.
3. **Demo project** — temp dir with `.claude/settings.json` whose hook
   commands use the absolute local bin:
   `node /Users/maxheckel/Sites/ari-hooks/bin/ari-hooks.js hook <event>`.
4. **Headless (context checks)** — `cd demo && ARI_HOOKS_HOME=... claude -p
   "..."`. Hooks run in `-p` mode; ask Claude about injected context to
   confirm additionalContext landed.
5. **TUI (display checks)** — `expect` stalls (claude waits on terminal
   capability queries a dumb pty never answers). Use tmux:
   `tmux -L verify new-session -d -x 100 -y 40 -c <demo> "env ARI_HOOKS_HOME=... claude"`,
   sleep ~6-8s, `tmux -L verify capture-pane -p`. Drive with `send-keys`.
   First boot in a new folder shows a trust dialog (send Enter).
6. **Failure probes** — API down / garbage 200 response: session must boot
   clean; failures land in `$ARI_HOOKS_HOME/error.log`.

Clean up: `tmux -L verify kill-server`, kill stub server pids.
