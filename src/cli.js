import { login, logout, status } from './login.js';
import { init } from './init.js';
import { runHook } from './hooks.js';
import { loadConfig } from './config.js';

const USAGE = `ari-hooks — share your Claude Code activity with Ari

Usage:
  ari-hooks              Log in (if needed) and set up hooks in the current folder
  ari-hooks login        Log in via the browser and store an API token
  ari-hooks init         Add the hooks to ./.claude/settings.json
  ari-hooks status       Show login state
  ari-hooks logout       Remove the stored token

Options:
  --web-url <url>        Override the Ari web app URL (login)
  --api-url <url>        Override the Ari API URL (login)
  -h, --help             Show this help
`;

function parseFlags(args) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--web-url') flags.webUrl = args[++i];
    else if (args[i] === '--api-url') flags.apiUrl = args[++i];
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

  switch (command) {
    case 'login':
      await login(flags);
      return;
    case 'logout':
      logout();
      return;
    case 'status':
      status();
      return;
    case 'init':
      init();
      return;
    case 'hook':
      await runHook(rest[1]);
      return;
    case undefined: {
      // Bare invocation: make "npx/global install → run once in a folder"
      // the whole setup story.
      if (!loadConfig().token) {
        await login(flags);
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
