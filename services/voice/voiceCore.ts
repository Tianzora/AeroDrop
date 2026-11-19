import { VOICE_CONFIG } from '../../constants/voice';

export const VOICE_VOLUME_MIN = 0;
export const VOICE_VOLUME_MAX = VOICE_CONFIG.MAX_VOLUME;
export const VOICE_VOLUME_DEFAULT = VOICE_CONFIG.DEFAULT_VOLUME;

/** 把任意输入收敛到 0–200 的整数音量（百分比）。 */
export function clampVolume(value: number): number {
  if (!Number.isFinite(value)) return VOICE_VOLUME_DEFAULT;
  return Math.min(VOICE_VOLUME_MAX, Math.max(VOICE_VOLUME_MIN, Math.round(value)));
}

/** 百分比音量转 HTMLAudioElement.volume 的 0–2 增益。 */
export function volumeToGain(volume: number): number {
  return clampVolume(volume) / 100;
}

/** 只有房间里已挂上连接、且本人尚未加入语音时才允许加入。 */
export function canJoinVoice(hasRoomConnection: boolean, joined: boolean): boolean {
  return hasRoomConnection && !joined;
}

export interface VoiceStatusInput {
  joined: boolean;
  muted: boolean;
  remoteMemberCount: number;
  error: string | null;
}

/** 语音 tab 的状态文案，保持简短且不伪造“已接通”。 */
export function describeVoiceStatus(input: VoiceStatusInput): string {
  if (input.error) return `语音不可用：${input.error}`;
  if (!input.joined) return '未加入语音，加入后才会打开麦克风';
  if (input.muted) {
    return input.remoteMemberCount > 0
      ? `已静音 · 正在收听 ${input.remoteMemberCount} 位成员`
      : '已静音 · 等待其他成员加入';
  }
  return input.remoteMemberCount > 0
    ? `麦克风已开启 · 正在和 ${input.remoteMemberCount} 位成员通话`
    : '麦克风已开启 · 等待其他成员加入';
}

export function describeMicrophoneError(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') return '麦克风权限被拒绝，请在浏览器设置中允许后重试';
    if (error.name === 'NotFoundError') return '没有检测到可用麦克风';
    if (error.name === 'NotReadableError') return '麦克风被其他应用占用';
  }
  return error instanceof Error && error.message ? error.message : '无法打开麦克风';
}
