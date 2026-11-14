import test from 'node:test';
import assert from 'node:assert/strict';

import { releaseCapturedStream } from './shareStreamLifecycle.ts';

type FakeTrack = {
  onended: (() => void) | null;
  stop: () => void;
  stopped: boolean;
};

function createStream() {
  const endedHandler = () => {};
  const video: FakeTrack = {
    onended: endedHandler,
    stopped: false,
    stop() {
      this.stopped = true;
    },
  };
  const audio: FakeTrack = {
    onended: null,
    stopped: false,
    stop() {
      this.stopped = true;
    },
  };
  const stream = {
    getVideoTracks: () => [video],
    getTracks: () => [video, audio],
  } as unknown as MediaStream;
  return { stream, video, audio, endedHandler };
}

test('停轨之前先摘掉旧轨的 onended：否则旧轨的 ended 会把新分享一起停掉', () => {
  const { stream, video, endedHandler } = createStream();
  assert.equal(video.onended, endedHandler);

  releaseCapturedStream(stream);

  assert.equal(video.onended, null);
  assert.equal(video.stopped, true);
});

test('所有轨道都停掉，不只是视频轨', () => {
  const { stream, video, audio } = createStream();

  releaseCapturedStream(stream);

  assert.equal(video.stopped, true);
  assert.equal(audio.stopped, true);
});

test('没有流时不炸（停止共享后再点一次停止）', () => {
  assert.doesNotThrow(() => releaseCapturedStream(null));
});
