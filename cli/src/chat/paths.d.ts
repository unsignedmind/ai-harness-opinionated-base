// Types of paths.js for the spec-ui dev server (TypeScript), which shares the chat's state folder and keys.
import type { Roots } from '../roots.js';

export const DEFAULT_PORT: number;
export const SPEC_UI_PORT: number;
export const KEY: RegExp;

/** resolveRoots + the not-set-up check (throws "nos is not set up: … Run nos init"); the chat works with roots.main */
export function chatRoots(options?: { root?: string; cwd?: string; env?: Record<string, string | undefined> }): Roots;
/** realpathSync.native, else path.resolve */
export function realDir(dir: string): string;
/** session key: sha256 of realDir(main) (plus NUL and the name when given), first 12 hex chars */
export function keyOf(main: string, name?: string): string;
/** NOS_CHAT_STATE_DIR, else <roots.specs>/.chat */
export function stateDirOf(roots: Pick<Roots, 'specs'>, env?: Record<string, string | undefined>): string;
/** creates the folder with a `*` .gitignore, returns it */
export function ensureStateDir(dir: string): string;
/** NOS_CHAT_PORT, else "chat.port" of <roots.specs>/config.json, else DEFAULT_PORT */
export function portOf(roots: Pick<Roots, 'specs'>, env?: Record<string, string | undefined>): number;
/** "chat" of <roots.specs>/config.json with defaults */
export function chatConfig(roots: Pick<Roots, 'specs'>): {
  runner: boolean;
  permissionMode: string;
  model: string | undefined;
  claude: string;
};
export function files(dir: string): { sessions: string; server: string; log: string };
