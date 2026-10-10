import { DeployProvider } from './provider.js';

// Any other target: a shell command of the project that deploys the env in NOS_DEPLOY_ENV and prints the url.
// options: command (deploys), remove (deletes the env, null = no removal), check (null = nothing to check).
// url = the last http(s) url on stdout. Also the fallback for the legacy project-commands.deploy-test.
export class CommandProvider extends DeployProvider {
  static id = 'command';
  static defaults = Object.freeze({ command: null, remove: null, check: null });

  validate() {
    super.validate();
    const { command } = this.options;
    if (typeof command !== 'string' || !command.trim()) this.fail('options.command must be a command');
  }

  deployCmd() {
    return this.options.command;
  }

  parse(stdout) {
    const urls = stdout.match(/https?:\/\/[^\s"'<>]+/g);
    return { url: urls ? urls[urls.length - 1] : null, expires: null };
  }

  removeCmd() {
    return this.options.remove || null;
  }

  checkCmd() {
    return this.options.check || null;
  }
}
