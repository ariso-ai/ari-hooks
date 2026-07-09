import { login, logout, status } from './login.js';
import { init } from './init.js';
import { runHook } from './hooks.js';
import { loadConfig, setUrls, showConfig } from './config.js';

const USAGE = `ari-hooks — share your Claude Code activity with Ari

Usage:
  ari-hooks              Log in (if needed) and set up hooks in the current folder
  ari-hooks login        Log in via the browser and store an API token
  ari-hooks init         Add the hooks to ./.claude/settings.json
  ari-hooks config       Show the configured URLs and login state
  ari-hooks status       Show login state
  ari-hooks logout       Remove the stored token

Options (persisted to ~/.ari-hooks/config.json, work with any command):
  --web-url <url>        Set the Ari web app URL, e.g. http://localhost:5173
  --api-url <url>        Set the Ari API URL, e.g. http://localhost:4000
  --reset-urls           Go back to the default production URLs
  -h, --help             Show this help

The ARI_HOOKS_WEB_URL / ARI_HOOKS_API_URL environment variables take
precedence over the persisted config.
`;

function parseFlags(args) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--web-url') flags.webUrl = args[++i];
    else if (args[i] === '--api-url') flags.apiUrl = args[++i];
    else if (args[i] === '--reset-urls') flags.resetUrls = true;
    else rest.push(args[i]);
  }
  return { flags, rest };
}

export async function main(argv) {
  const { flags, rest } = parseFlags(argv);
  const command = rest[0];

  if (command === '-h' || command === '--help' || command === 'help') {
    console.log(USAGE);
    return;
  }

  // Persist URL overrides before dispatching so they apply to this run and
  // every later hook invocation, regardless of which command they rode in on.
  if (flags.webUrl || flags.apiUrl || flags.resetUrls) {
    setUrls(flags);
  }

  switch (command) {
    case 'login':
      await login();
      return;
    case 'logout':
      logout();
      return;
    case 'status':
      status();
      return;
    case 'config':
      showConfig();
      return;
    case 'init':
      init();
      return;
    case 'hook':
      await runHook(rest[1]);
      return;
    case undefined: {
      // Bare invocation: make "npx/global install → run once in a folder"
      // the whole setup story. URL-only invocations (e.g. `ari-hooks
      // --web-url ...`) still run the full setup with the new URLs.
      if (!loadConfig().token) {
        await login();
      }
      init();
      return;
    }
    default:
      console.error(`Unknown command: ${command}\n`);
      console.log(USAGE);
      process.exitCode = 1;
  }
}
