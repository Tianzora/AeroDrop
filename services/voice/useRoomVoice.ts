import { useCallback, useEffect, useRef, useState } from 'react';
import type { DataConnection } from '../peerRuntime';
import { VOICE_CONFIG } from '../../constants/voice';
import { clampVolume, describeMicrophoneError, volumeToGain } from './voiceCore';

interface AttachedVoiceConnection {
  connection: DataConnection;
  onAudioStream: (stream: MediaStream) => void;
  onOpen: () => void;
}

export interface RoomVoiceApi {
  /** 是否已加入语音（已获取本地麦克风）。 */
  joined: boolean;
  /** 当前是否静音（静音只 replaceTrack(null)，不重协商）。 */
  muted: boolean;
  /** 对端播放音量，0–200 百分比。 */
  volume: number;
  /** 正在收听的远端成员数量。 */
  remoteMemberCount: number;
  error: string | null;
  joinVoice: () => Promise<void>;
  leaveVoice: () => void;
  toggleMute: () => Promise<void>;
  setVolume: (value: number) => void;
  /** 把一条 room DataConnection 接入语音；聊天/共享开关不影响它。 */
  attachConnection: (connection: DataConnection) => void;
  /** 房间结束时清理麦克风与所有远端播放器。 */
  reset: () => void;
}

/**
 * 房间语音：复用 M1 的 room DataConnection（PC 建好即预留 audio transceiver）。
 * 加入/开麦/静音只 addTrack/replaceTrack，不触发重协商；共享开停不会碰这里。
 */
export function useRoomVoice(): RoomVoiceApi {
  const [joined, setJoined] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolumeState] = useState<number>(VOICE_CONFIG.DEFAULT_VOLUME);
  const [remoteMemberCount, setRemoteMemberCount] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const connectionsRef = useRef<Map<DataConnection, AttachedVoiceConnection>>(new Map());
  const localStreamRef = useRef<MediaStream | null>(null);
  const audioElementsRef = useRef<Map<DataConnection, HTMLAudioElement>>(new Map());
  const joinedRef = useRef(false);
  const mutedRef = useRef(false);
  const volumeRef = useRef<number>(VOICE_CONFIG.DEFAULT_VOLUME);

  const syncRemoteCount = useCallback(() => {
    let count = 0;
    connectionsRef.current.forEach(({ connection }) => {
      if (connection.remoteAudioStream.getAudioTracks().length > 0) count += 1;
    });
    setRemoteMemberCount(count);
  }, []);

  const applyLocalTrack = useCallback(async (connection: DataConnection) => {
    const track = joinedRef.current ? localStreamRef.current?.getAudioTracks()[0] ?? null : null;
    try {
      await connection.attachAudioTrack(mutedRef.current ? null : track);
      await connection.setAudioBitrate(VOICE_CONFIG.BITRATE_BPS);
    } catch {
      // 通道刚建立时 replaceTrack 可能短暂失败；下次加入/开会话会再同步。
    }
  }, []);

  const attachConnection = useCallback(
    (connection: DataConnection) => {
      if (connectionsRef.current.has(connection)) {
        void applyLocalTrack(connection);
        return;
      }
      const onAudioStream = (stream: MediaStream) => {
        if (typeof document === 'undefined') return;
        let element = audioElementsRef.current.get(connection);
        if (!element) {
          element = document.createElement('audio');
          element.autoplay = true;
          element.setAttribute('playsinline', 'true');
          element.style.display = 'none';
          document.body.appendChild(element);
          audioElementsRef.current.set(connection, element);
        }
        if (element.srcObject !== stream) element.srcObject = stream;
        element.volume = volumeToGain(volumeRef.current);
        void element.play().catch(() => {
          // 浏览器可能要求一次用户手势后才能播放；用户点「加入语音」后重试。
        });
        syncRemoteCount();
      };
      const onOpen = () => {
        // room PC 的 answer 完成前 replaceTrack 可能被丢弃；通道 open 后再盖一次章。
        void applyLocalTrack(connection);
      };
      connection.on('audio-stream', onAudioStream);
      connection.on('open', onOpen);
      connectionsRef.current.set(connection, { connection, onAudioStream, onOpen });
      if (connection.remoteAudioStream.getAudioTracks().length > 0) {
        onAudioStream(connection.remoteAudioStream);
      }
      void applyLocalTrack(connection);
      if (connection.open) onOpen();
    },
    [applyLocalTrack, syncRemoteCount]
  );

  const joinVoice = useCallback(async () => {
    if (joinedRef.current) return;
    if (connectionsRef.current.size === 0) {
      setError('房间连接尚未建立，请稍后再加入语音');
      return;
    }
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia(VOICE_CONFIG.MIC_CONSTRAINTS);
      localStreamRef.current = stream;
      joinedRef.current = true;
      mutedRef.current = false;
      setJoined(true);
      setMuted(false);
      await Promise.all(
        Array.from(connectionsRef.current.values()).map(({ connection }) => applyLocalTrack(connection))
      );
    } catch (micError) {
      setError(describeMicrophoneError(micError));
    }
  }, [applyLocalTrack]);

  const leaveVoice = useCallback(() => {
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    joinedRef.current = false;
    mutedRef.current = false;
    setJoined(false);
    setMuted(false);
    audioElementsRef.current.forEach((element) => {
      element.srcObject = null;
      element.remove();
    });
    audioElementsRef.current.clear();
    setRemoteMemberCount(0);
    connectionsRef.current.forEach(({ connection }) => {
      void connection.attachAudioTrack(null).catch(() => undefined);
    });
  }, []);

  const toggleMute = useCallback(async () => {
    if (!joinedRef.current) return;
    const nextMuted = !mutedRef.current;
    mutedRef.current = nextMuted;
    setMuted(nextMuted);
    const track = localStreamRef.current?.getAudioTracks()[0] ?? null;
    if (track) track.enabled = !nextMuted;
    await Promise.all(
      Array.from(connectionsRef.current.values()).map(({ connection }) =>
        connection.attachAudioTrack(nextMuted ? null : track).catch(() => undefined)
      )
    );
  }, []);

  const setVolume = useCallback((value: number) => {
    const next = clampVolume(value);
    volumeRef.current = next;
    setVolumeState(next);
    audioElementsRef.current.forEach((element) => {
      element.volume = volumeToGain(next);
    });
  }, []);

  const reset = useCallback(() => {
    leaveVoice();
    connectionsRef.current.forEach(({ connection, onAudioStream, onOpen }) => {
      connection.off('audio-stream', onAudioStream);
      connection.off('open', onOpen);
    });
    connectionsRef.current.clear();
    setError(null);
  }, [leaveVoice]);

  useEffect(() => {
    return () => {
      localStreamRef.current?.getTracks().forEach((track) => track.stop());
      audioElementsRef.current.forEach((element) => {
        element.srcObject = null;
        element.remove();
      });
      audioElementsRef.current.clear();
      connectionsRef.current.forEach(({ connection, onAudioStream, onOpen }) => {
        connection.off('audio-stream', onAudioStream);
        connection.off('open', onOpen);
      });
      connectionsRef.current.clear();
    };
  }, []);

  return {
    joined,
    muted,
    volume,
    remoteMemberCount,
    error,
    joinVoice,
    leaveVoice,
    toggleMute,
    setVolume,
    attachConnection,
    reset,
  };
}
