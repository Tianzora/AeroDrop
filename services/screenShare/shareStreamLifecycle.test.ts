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

test('释放之后旧轨迟到的 ended 不会再跑原回调：以后改成 stop+ended 也打不回 stopScreenShare', () => {
  let endedCalls = 0;
  type FakeTrack = { onended: (() => void) | null; stop(): void };
  const track: FakeTrack = {
    onended: () => {
      endedCalls += 1;
    },
    stop() {},
  };
  const stream = {
    getVideoTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream;

  releaseCapturedStream(stream);

  assert.equal(track.onended, null);
  // 模拟一个迟到的 ended：assert.equal 会把类型收窄成 null，这里 cast 回来只为调一次。
  const simulateLateEnded = track.onended as unknown as (() => void) | null;
  // 浏览器的 stop() 现在不派发 ended；万一哪天有人手动派发或改实现，也不能命中旧回调。
  simulateLateEnded?.();
  assert.equal(endedCalls, 0);
});
