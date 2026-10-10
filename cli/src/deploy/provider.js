import { FAILED, NosError } from '../exit-codes.js';

// Base of a deploy provider: one test environment per env id (default the run id), never production.
// A provider only builds shell commands and reads their output: nos ships no provider SDK, the project brings
// its CLI (e.g. firebase-tools). Subclasses set static id and defaults, and implement deployCmd and parse.
// options: deploy.options of nos.config.json, merged over static defaults, checked by validate().
export class DeployProvider {
  static id = 'provider';
  static defaults = Object.freeze({});
  static MAX_ENV = 63;

  constructor(options = {}) {
    this.options = { ...structuredClone(this.constructor.defaults), ...options };
    this.validate();
  }

  get id() {
    return this.constructor.id;
  }

  // Throws a NosError FAILED for a bad option. Override and call super.validate().
  validate() {}

  fail(message) {
    throw new NosError(FAILED, `deploy (${this.id}): ${message}`);
  }

  // The env id the provider deploys to: lowercase, [a-z0-9-], no leading/trailing dash, at most MAX_ENV chars.
  envId(raw) {
    const env = String(raw ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+/, '')
      .slice(0, this.constructor.MAX_ENV)
      .replace(/-+$/, '');
    if (!env) this.fail(`invalid env id "${raw}"`);
    return env;
  }

  // Shell command that deploys env. Its stdout goes to parse.
  deployCmd(env) {
    this.fail(`deployCmd(${env}) not implemented`);
  }

  // stdout of deployCmd -> { url, expires } (expires null when unknown). Throws when it reports a failure.
  parse(stdout) {
    this.fail(`parse(${stdout.length} chars) not implemented`);
  }

  // Shell command that deletes env, null = the provider cannot delete (expiry or the user cleans up).
  removeCmd() {
    return null;
  }

  // Shell command that checks the provider CLI is installed and logged in, null = nothing to check.
  checkCmd() {
    return null;
  }

  // Extra env vars of the deploy and remove commands.
  env(env) {
    return { NOS_DEPLOY_ENV: env };
  }
}

// Shell argument, quoted unless plain (option values come from nos.config.json, env ids are always plain).
export const quote = (value) => (/^[\w.:/@=-]+$/.test(value) ? value : `"${String(value).replace(/"/g, '\\"')}"`);
