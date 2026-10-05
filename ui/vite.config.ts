// Dev server (`npm run dev`) and tests (`npm test`) of the specs viewer. Its own package, separate
// from the project it sits in. `npm run dev-to-lan` (mode "lan") serves HTTPS with the certificate
// in specs/.chat/tls (src/tls.ts), so phones on the network talk to it encrypted.
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

import { stateDirOf } from './src/chat-proxy.ts';
import { serveSpecs } from './src/serve-specs.ts';
import { loadTls } from './src/tls.ts';

// specs/ sits at the repo root, outside the viewer's root
const specs = fileURLToPath(new URL('../../../../specs', import.meta.url));

export default defineConfig(async ({ mode }) => {
  const tls = mode === 'lan' ? await loadTls(stateDirOf(dirname(specs))) : null;
  return {
    plugins: [serveSpecs(specs, { fingerprint: tls?.fingerprint ?? null })],
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
