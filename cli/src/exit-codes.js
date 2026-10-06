// Exit codes of the nos CLI. 3-7 are states the orchestrator reacts to: run() prints them as JSON
// { action, error, exit, details } on stdout plus one line on stderr.
export const OK = 0;
export const FAILED = 1;
export const USAGE = 2;
export const CONFLICT = 3;
export const HELD = 4;
export const DIRTY = 5;
export const DOMAIN_RUNNING = 6;
export const SLOT_TIMEOUT = 7;

export const EXIT = Object.freeze({ OK, FAILED, USAGE, CONFLICT, HELD, DIRTY, DOMAIN_RUNNING, SLOT_TIMEOUT });

// An error with an exit code and machine readable details, e.g. new NosError(HELD, 'lock ids is held', { holder }).
export class NosError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'NosError';
    this.code = code;
    this.details = details;
  }
}
