import { DeployProvider, quote } from './provider.js';

// Firebase Hosting preview channels: one channel per env, deployed with the project's firebase CLI
// ("firebase hosting:channel:deploy <env>"). Never the live channel: production deploys stay outside nos.
// options: cli (the firebase command, e.g. "npx firebase"), project (--project, null = .firebaserc default),
// site (--only <site> for a multi-site project), expires (channel lifetime, e.g. "7d", max "30d").
// The hosted url <site>--<env>-<hash>.web.app is one DNS label: the env id is kept to 40 chars.
export class FirebaseHostingProvider extends DeployProvider {
  static id = 'firebase-hosting';
  static defaults = Object.freeze({ cli: 'firebase', project: null, site: null, expires: '7d' });
  static MAX_ENV = 40;

  validate() {
    super.validate();
    const { cli, expires } = this.options;
    if (typeof cli !== 'string' || !cli.trim()) this.fail('options.cli must be a command, e.g. "firebase"');
    if (!/^\d+[hdw]$/.test(String(expires))) this.fail(`options.expires "${expires}" must look like 12h, 7d or 2w`);
  }

  envId(raw) {
    const env = super.envId(raw);
    if (env === 'live') this.fail('the live channel is production, nos never deploys it');
    return env;
  }

  #project() {
    return this.options.project ? ['--project', quote(this.options.project)] : [];
  }

  deployCmd(env) {
    const { cli, expires, site } = this.options;
    const only = site ? ['--only', quote(site)] : [];
    return [cli, 'hosting:channel:deploy', env, '--expires', expires, ...this.#project(), ...only, '--json'].join(' ');
  }

  // --json prints { status: "success", result: { <site>: { site, url, expireTime } } } or { status: "error", error }.
  parse(stdout) {
    let json;
    try {
      json = JSON.parse(stdout.slice(stdout.indexOf('{'), stdout.lastIndexOf('}') + 1));
    } catch {
      this.fail('no JSON result on stdout of firebase');
    }
    if (json.status !== 'success') this.fail(json.error ?? `firebase status ${json.status}`);
    const sites = Object.values(json.result ?? {});
    const hit = sites.find((s) => s.site === this.options.site) ?? sites[0];
    if (!hit?.url) this.fail('firebase reported no url');
    return { url: hit.url, expires: hit.expireTime ?? null };
  }

  removeCmd(env) {
    const { cli, site } = this.options;
    const scope = site ? ['--site', quote(site)] : [];
    return [cli, 'hosting:channel:delete', env, ...this.#project(), ...scope, '--force'].join(' ');
  }

  checkCmd() {
    return `${this.options.cli} login:list`;
  }
}
