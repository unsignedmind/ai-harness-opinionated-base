import { spawn } from 'node:child_process';
import { gitEnv } from './git.js';

// Never handed to a project tool: NODE_ENV of the calling session flips build tools into another mode (a
// vite-plugin-pwa service worker built with NODE_ENV=development is unminified and fails a precache check),
// NOS_SLOT is set per lease, the run token stays with its session.
export const TOOL_ENV_DROPPED = Object.freeze(['NODE_ENV', 'NOS_SLOT', 'NOS_RUN_TOKEN']);

// The env of a project tool (nos gate, nos exec): the caller's env without REPO_ENV and TOOL_ENV_DROPPED,
// plus NOS_HOME.
export function toolEnv(home, env = process.env) {
  const clean = { ...gitEnv(env), NOS_HOME: home };
  for (const name of TOOL_ENV_DROPPED) delete clean[name];
  return clean;
}

// Kills a child and everything it started: taskkill /T /F on Windows (a shell child keeps its own
// children otherwise), the process group elsewhere (the child must be spawned detached to lead one).
export function killTree(child, platform = process.platform) {
  if (!child.pid || child.exitCode !== null) return;
  try {
    if (platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }).on('error', () => {});
    } else process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill();
  }
}

// The process with this pid exists (EPERM: it exists, owned by someone else).
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// Blocks the thread for ms (sync retry loops: locks, index.lock).
export function sleepSync(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
