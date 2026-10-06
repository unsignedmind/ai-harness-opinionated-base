#!/usr/bin/env node
import { run } from '../src/cli.js';

const argv = process.argv.slice(2);
if (argv[0] === 'chat') {
  // async: talks to the local chat server (src/chat/)
  const { runChat } = await import('../src/chat/commands.js');
  process.exitCode = await runChat(argv.slice(1));
} else {
  process.exitCode = await run(argv);
}
