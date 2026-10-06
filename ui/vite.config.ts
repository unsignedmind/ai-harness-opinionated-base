// Dev server (`npm run dev`) and tests (`npm test`) of the specs viewer. Its own package, separate
// from the project it sits in. The project comes from the resolver (cli/src/roots.js): the walk from
// this folder up to the first nos.config.json lands on the project nos sits in; NOS_SPECS_ROOT
// overrides it. Not set up: the server still starts and the page says "run nos init".
// `npm run dev-to-lan` (mode "lan") serves HTTPS with the certificate in <specs>/.chat/tls
// (src/tls.ts), so phones on the network talk to it encrypted.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

import { stateDirOf } from '../cli/src/chat/paths.js';
import { serveSpecs, specsSetup } from './src/serve-specs.ts';
import { loadTls } from './src/tls.ts';

export default defineConfig(async ({ mode }) => {
  const setup = specsSetup({ cwd: resolve(dirname(fileURLToPath(import.meta.url))), env: process.env });
  const tls = mode === 'lan' && setup.roots ? await loadTls(stateDirOf(setup.roots)) : null;
  return {
    plugins: [serveSpecs(setup, { fingerprint: tls?.fingerprint ?? null })],
    server: {
      port: 5180,
      open: '/dev.html',
      ...(tls && { https: { key: tls.key, cert: tls.cert } }),
    },
    test: {
      environment: 'jsdom',
      include: ['tests/**/*.test.ts'],
    },
  };
});
