// Opens the default browser. Never throws: the printed URL is the fallback.
import { spawn } from 'node:child_process';

const CHAT_URL = /^http:\/\/127\.0\.0\.1:\d{1,5}\/chat\/[a-f0-9]{12}$/;

export function launchBrowser(url, platform = process.platform, run = spawn) {
  if (!CHAT_URL.test(url)) return false;
  const [cmd, args] =
    platform === 'darwin'
      ? ['open', [url]]
      : platform === 'win32'
        ? ['cmd', ['/c', 'start', '""', url]]
        : ['xdg-open', [url]];
  try {
    // verbatim on Windows, so the empty title "" reaches start as is (the url is checked above)
    const child = run(cmd, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      windowsVerbatimArguments: platform === 'win32',
    });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
