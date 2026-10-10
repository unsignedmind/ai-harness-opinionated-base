import { FAILED, NOT_CONFIGURED, NosError } from '../exit-codes.js';
import { deployConfig, projectCommands } from '../project-config.js';
import { CommandProvider } from './command.js';
import { FirebaseHostingProvider } from './firebase-hosting.js';

// Deploy providers by deploy.provider of nos.config.json. A new target = a DeployProvider subclass added here.
export const PROVIDERS = Object.freeze({
  [FirebaseHostingProvider.id]: FirebaseHostingProvider,
  [CommandProvider.id]: CommandProvider,
});

const isSet = (cmd) => typeof cmd === 'string' && cmd.trim() !== '';
const isObject = (value) => value != null && typeof value === 'object' && !Array.isArray(value);

// { provider, build } of work's nos.config.json. deploy.provider null -> the legacy project-commands.deploy-test
// as a command provider. Neither -> NosError NOT_CONFIGURED.
export function deployProvider(roots) {
  const config = deployConfig(roots);
  const build = isSet(config.build) ? config.build : null;
  if (config.provider == null) {
    const legacy = projectCommands(roots)['deploy-test'];
    if (isSet(legacy)) return { provider: new CommandProvider({ command: legacy }), build };
    throw new NosError(NOT_CONFIGURED, 'deploy is not configured in nos.config.json. Run setup');
  }
  const Provider = PROVIDERS[config.provider];
  if (!Provider) {
    throw new NosError(
      FAILED,
      `Unknown deploy.provider "${config.provider}". Use one of: ${Object.keys(PROVIDERS).join(', ')}`,
    );
  }
  return { provider: new Provider(isObject(config.options) ? config.options : {}), build };
}
