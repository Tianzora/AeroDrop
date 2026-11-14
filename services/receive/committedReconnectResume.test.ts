import test from 'node:test';
import assert from 'node:assert/strict';
import { TransferState } from '../../types/index.ts';
import {
  shouldAutoResumeCommittedReconnect,
  shouldPreserveCommittedReconnectResumeIntent,
} from './committedReconnectResume.ts';

test('shouldAutoResumeCommittedReconnect：两个条件都必须成立', () => {
  assert.equal(
    shouldAutoResumeCommittedReconnect({ pendingReconnectResume: true, isResumable: true }),
    true
  );
  assert.equal(
    shouldAutoResumeCommittedReconnect({ pendingReconnectResume: true, isResumable: false }),
    false
  );
  assert.equal(
    shouldAutoResumeCommittedReconnect({ pendingReconnectResume: false, isResumable: true }),
    false
  );
});

test('shouldPreserveCommittedReconnectResumeIntent：只有传输中且仍在活动时保留意图', () => {
  assert.equal(
    shouldPreserveCommittedReconnectResumeIntent({
      currentState: TransferState.TRANSFERRING,
      transferActive: true,
    }),
    true
  );
  assert.equal(
    shouldPreserveCommittedReconnectResumeIntent({
      currentState: TransferState.TRANSFERRING,
      transferActive: false,
    }),
    false
  );
  assert.equal(
    shouldPreserveCommittedReconnectResumeIntent({
      currentState: TransferState.COMPLETED,
      transferActive: true,
    }),
    false
  );
});
