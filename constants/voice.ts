/** 房间语音的固定参数：加入不自动开麦，音量与码率都在这里统一。 */
export const VOICE_CONFIG = {
  /** 每人对端音量百分比上限；默认 100%。 */
  MAX_VOLUME: 200,
  DEFAULT_VOLUME: 100,
  /** 每人音频码率，架构附录要求 64kbps（32–128kbps 可调）。 */
  BITRATE_BPS: 64_000,
  MIN_BITRATE_BPS: 32_000,
  MAX_BITRATE_BPS: 128_000,
  /** 只用麦克风，且做基本回声消除，避免观看端外放回声。 */
  MIC_CONSTRAINTS: {
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    video: false,
  } as MediaStreamConstraints,
} as const;
