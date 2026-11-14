/**
 * 采集流的生命周期收尾。
 *
 * 停轨之前必须先摘掉 videoTrack 上的 onended：ScreenShare 把「分享者关掉采集窗口」
 * 绑成 stopScreenShare，如果旧轨只 stop 不摘绑定，旧轨迟到的 ended 事件会把刚刚
 * 重新开始/切换后的新分享一起停掉。这类错误只在「过期后重启」和「切换窗口」两条
 * 路径上出现，人工点一遍很容易漏。
 */
export function releaseCapturedStream(stream: MediaStream | null): void {
  if (!stream) return;
  stream.getVideoTracks().forEach((track) => {
    track.onended = null;
  });
  stream.getTracks().forEach((track) => {
    track.stop();
  });
}
