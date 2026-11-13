import test from 'node:test';
import assert from 'node:assert/strict';

import { applyResponsePolicies, setSecurityHeaders } from './httpPolicy.ts';

const request = (url: string, method = 'GET'): Request => new Request(url, { method });

test('adds the baseline security headers without overwriting HSTS', () => {
  const headers = new Headers();
  setSecurityHeaders(headers);
  assert.equal(headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(headers.get('X-Frame-Options'), 'DENY');
  assert.equal(headers.get('Referrer-Policy'), 'strict-origin-when-cross-origin');
  assert.equal(headers.get('Permissions-Policy'), 'camera=(), microphone=(self), geolocation=()');
  assert.equal(headers.get('X-XSS-Protection'), '1; mode=block');
  assert.ok(headers.get('Strict-Transport-Security')?.includes('preload'));

  const preset = new Headers({ 'Strict-Transport-Security': 'max-age=60' });
  setSecurityHeaders(preset);
  assert.equal(preset.get('Strict-Transport-Security'), 'max-age=60');
});

test('marks hashed assets immutable and html no-cache', () => {
  const asset = applyResponsePolicies(request('https://drop.example/assets/app-a1b2.js'), new Response('x'));
  assert.equal(asset.headers.get('Cache-Control'), 'public, max-age=31536000, immutable');

  const html = applyResponsePolicies(request('https://drop.example/index.html'), new Response('x'));
  assert.equal(html.headers.get('Cache-Control'), 'no-cache');

  const serviceWorker = applyResponsePolicies(request('https://drop.example/sw.js'), new Response('x'));
  assert.equal(serviceWorker.headers.get('Cache-Control'), 'no-cache');

  const manifest = applyResponsePolicies(request('https://drop.example/manifest.json'), new Response('x'));
  assert.equal(manifest.headers.get('Cache-Control'), 'no-cache');
});

test('only applies cache policy to safe methods', () => {
  const posted = applyResponsePolicies(request('https://drop.example/assets/app.js', 'POST'), new Response('x'));
  assert.equal(posted.headers.get('Cache-Control'), null);
  assert.equal(posted.headers.get('X-Frame-Options'), 'DENY', 'security headers still apply');
});

test('marks share links noindex so they are not crawled', () => {
  const fileShare = applyResponsePolicies(request('https://drop.example/?code=123456'), new Response('x'));
  assert.equal(fileShare.headers.get('X-Robots-Tag'), 'noindex');

  const screenShare = applyResponsePolicies(request('https://drop.example/?view=peer-abc'), new Response('x'));
  assert.equal(screenShare.headers.get('X-Robots-Tag'), 'noindex');

  const ordinary = applyResponsePolicies(request('https://drop.example/'), new Response('x'));
  assert.equal(ordinary.headers.get('X-Robots-Tag'), null);
});

test('preserves status and body', async () => {
  const original = new Response('hello', { status: 404, statusText: 'Not Found' });
  const filtered = applyResponsePolicies(request('https://drop.example/index.html'), original);
  assert.equal(filtered.status, 404);
  assert.equal(filtered.statusText, 'Not Found');
  assert.equal(await filtered.text(), 'hello');
});
