const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// Slugs are chosen by the caller; the CLI only validates, it never derives one.
export function assertSlug(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Missing input: ${label}`);
  }
  if (!SLUG_PATTERN.test(value)) {
    throw new Error(`Invalid slug for ${label}: "${value}". Use lowercase kebab-case (a-z, 0-9, single dashes)`);
  }
  return value;
}
