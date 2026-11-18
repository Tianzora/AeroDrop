import type { MediaConnection } from '../peerRuntime';
import {
  describeScreenCaptureFailure,
  type ScreenCaptureFailure,
} from './screenCaptureGuidance';

export const isEmbeddedFrame = () =>
  typeof window !== 'undefined' && window.self !== window.top;

export const hasUserActivation = (): boolean => {
  const activation = (navigator as Navigator & { userActivation?: { isActive: boolean } })
    .userActivation;
  return activation ? activation.isActive : true;
};

/**
 * 观众的媒体连接是否还在跑。信令错误要不要落红条看这一条（见 viewerErrorSurface）。
 */
export const viewerMediaIsHealthy = (connection: MediaConnection | null): boolean =>
  connection?.peerConnection?.connectionState === 'connected';

/**
 * 信令层把 Retry-After 挂在 error 上（`retryAfterMs`）。
 * 拿不到就返回 null，由调用方退回出口配额的静默期兜底——倒计时宁可偏长，
 * 也不能显示「立刻可重试」。
 */
export const readRetryAfterMs = (error: unknown): number | null => {
  const value = (error as { retryAfterMs?: unknown } | null)?.retryAfterMs;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
};

/**
 * 拒绝来自哪一层额度。
 *
 * 旧实现把所有 `rate-limited` 当成「请求太频繁」，于是每出口会话数被占满（12 个/IP，
 * 由别的标签页拿着）也会显示「60 秒后可重试」——而 60 秒后名额仍被占着，用户只会在
 * 同一个错误上反复点。服务端已经标了 `limit`，这里只做读取与兜底。
 */
export const readRateLimitLayer = (error: unknown): 'session' | 'offer' | null => {
  const limit = (error as { limit?: unknown } | null)?.limit;
  if (limit === 'session' || limit === 'offer') return limit;
  return null;
};

export const describeCaptureError = (error: unknown): ScreenCaptureFailure =>
  describeScreenCaptureFailure(error, {
    embedded: isEmbeddedFrame(),
    userActivation: hasUserActivation(),
  });

/**
 * 找到已经协商出来的音频 sender。不能看 sender.track：replaceTrack(null) 之后它会变成 null，
 * 但 transceiver 的 receiver 仍保留 audio 方向，之后换回带音频的源还能继续复用。
 */
export const findLiveAudioSender = (pc: RTCPeerConnection | undefined): RTCRtpSender | null => {
  const transceiver = pc
    ?.getTransceivers()
    .find((item) => item.receiver.track?.kind === 'audio' && item.direction !== 'stopped');
  return transceiver?.sender ?? null;
};

/**
 * 找到已经协商出来的视频 sender。和音频同理：停共享时 `replaceTrack(null)` 会把
 * `sender.track` 清空，只有 transceiver 的 receiver 还保留 video 方向。重新开始共享
 * 必须靠它把新画面挂回同一条媒体连接，否则复用房间时画面永远黑屏。
 */
export const findLiveVideoSender = (pc: RTCPeerConnection | undefined): RTCRtpSender | null => {
  const transceiver = pc
    ?.getTransceivers()
    .find((item) => item.receiver.track?.kind === 'video' && item.direction !== 'stopped');
  return transceiver?.sender ?? null;
};