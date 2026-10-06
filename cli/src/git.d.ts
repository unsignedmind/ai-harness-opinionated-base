// Types of git.js for the spec-ui dev server (TypeScript), which asks git about runs (/__runs).
export const REPO_ENV: readonly string[];
export const NO_PROMPT_ENV: Readonly<Record<string, string>>;
export type GitResult = { code: number; stdout: string; stderr: string; timedOut: boolean };
export function gitEnv(env?: Record<string, string | undefined>): Record<string, string | undefined>;
/** runs git and never throws; code -1 when git could not be started or timed out */
export function git(
  args: string[],
  options?: { cwd?: string; timeout?: number; env?: Record<string, string | undefined> },
): GitResult;
/** trimmed stdout of a git command that must succeed, else throws a NosError */
export function gitOut(args: string[], options?: { cwd?: string }): string;
export function gitAvailable(): boolean;
