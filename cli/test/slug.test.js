import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertSlug } from '../src/slug.js';

test('accepts lowercase kebab-case slugs', () => {
  for (const slug of ['auth', 'user-auth', 'v2-api', '42']) {
    assert.equal(assertSlug(slug, 'slug'), slug);
  }
});

test('rejects a missing slug as missing input', () => {
  for (const slug of [undefined, null, '', '   ']) {
    assert.throws(() => assertSlug(slug, 'domain slug'), /missing input: domain slug/i);
  }
});

test('rejects slugs that are not lowercase kebab-case instead of rewriting them', () => {
  for (const slug of ['User-Auth', 'user auth', 'user_auth', '-auth', 'auth-', 'user--auth', '../x', 'café']) {
    assert.throws(() => assertSlug(slug, 'slug'), /invalid slug/i, slug);
  }
});
