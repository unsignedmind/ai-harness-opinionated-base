// Types of roots.js for the spec-ui dev server (TypeScript) and other consumers of the resolver.
export type Roots = {
  /** the nos folder the code runs from */
  home: string;
  /** the checkout the caller sits in (main or a worktree) */
  work: string;
  /** the main checkout of the project */
  main: string;
  /** the specs root (main + specs.dir, default .specs) */
  specs: string;
  /** work is a linked git worktree of main */
  inWorktree: boolean;
  /** work is inside a git repo */
  git: boolean;
};

export const SPECS_DIR: string;
export const PROJECT_CONFIG_FILE: string;
export const NOS_HOME: string;

export function slash(p: string): string;
export function findWorkRoot(start: string): string | null;
export function resolveRoots(options?: {
  root?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  home?: string;
}): Roots;
export function homeGuard(roots: Roots, stderr?: { write(text: string): unknown }): string[];
export function specFileOf(entry: unknown): string;
export function specPath(roots: Roots, specFile: string): string;
