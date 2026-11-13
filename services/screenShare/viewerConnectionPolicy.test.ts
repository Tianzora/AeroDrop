import test from 'node:test';
import assert from 'node:assert/strict';

import { VIEWER_DISCONNECT_GRACE_MS, decideViewerConnection } from './viewerConnectionPolicy.ts';

test('treats a connected peer connection as healthy regardless of history', () => {
  assert.equal(decideViewerConnection({ state: 'connected' }), 'ok');
  assert.equal(decideViewerConnection({ state: 'connected', disconnectedForMs: 60_000 }), 'ok');
});

test('retries immediately on failed or closed, because ICE will not heal itself', () => {
  assert.equal(decideViewerConnection({ state: 'failed' }), 'retry');
  assert.equal(decideViewerConnection({ state: 'closed' }), 'retry');
});

test('waits out a short disconnect before spending a reconnect attempt', () => {
  assert.equal(decideViewerConnection({ state: 'disconnected', disconnectedForMs: 0 }), 'wait');
  assert.equal(
    decideViewerConnection({ state: 'disconnected', disconnectedForMs: VIEWER_DISCONNECT_GRACE_MS - 1 }),
    'wait',
  );
});

test('retries once the disconnect outlives the grace window', () => {
  assert.equal(
    decideViewerConnection({ state: 'disconnected', disconnectedForMs: VIEWER_DISCONNECT_GRACE_MS }),
    'retry',
  );
  assert.equal(decideViewerConnection({ state: 'disconnected', disconnectedForMs: 30_000 }), 'retry');
});

test('treats transitions still in progress as wait, not failure', () => {
  for (const state of ['new', 'connecting', 'unknown'] as const) {
    assert.equal(decideViewerConnection({ state }), 'wait');
  }
});

test('never retries early for garbage elapsed values', () => {
  assert.equal(decideViewerConnection({ state: 'disconnected', disconnectedForMs: Number.NaN }), 'wait');
  assert.equal(decideViewerConnection({ state: 'disconnected', disconnectedForMs: -5_000 }), 'wait');
});
