// Host and Origin checks of the chat server: only loopback names, so a web page elsewhere (or a
// DNS rebinding) cannot reach it. A missing Origin is fine (CLI, plain page loads).
export const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

// "127.0.0.1:4611" -> "127.0.0.1", "[::1]:4611" -> "[::1]"
export function hostOf(header) {
  const m = /^(\[[^\]]+\]|[^:]+)(?::\d{1,5})?$/.exec(String(header || '').trim());
  return m ? m[1].toLowerCase() : null;
}

export function allowed(req) {
  if (!LOOPBACK.has(hostOf(req.headers.host))) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return LOOPBACK.has(new URL(origin).hostname.toLowerCase());
  } catch {
    return false;
  }
}
