/**
 * 观众侧收到信令错误时，该不该把它显示成红色终态条。
 *
 * 信令层抖动（服务器重启、出口网络短暂中断）时 peer 会抛 socket/network 类错误，
 * 但媒体连接往往还在跑、画面还在放。把这种错误落成红色终态条有两个后果：
 * 屏幕上是画面，条上写「连接失败」，界面自相矛盾；而且信令恢复后没人去清它，
 * 这条红条会一直挂到用户手动离开。
 *
 * 判据只有一条：媒体连接仍然健康时，信令错误是「背景噪音」，吞掉并记日志；
 * 媒体确实断了才让用户看到终态。
 */
export type ViewerErrorSurface = 'surface' | 'suppress';

export interface ViewerErrorSurfaceInput {
  /** 观众是否已经建立了媒体连接（call 还在）。 */
  hasMediaConnection: boolean;
  /** 媒体连接是否仍然健康（ICE/DTLS connected）。 */
  mediaHealthy: boolean;
}

export function planViewerErrorSurface(input: ViewerErrorSurfaceInput): ViewerErrorSurface {
  if (input.hasMediaConnection && input.mediaHealthy) return 'suppress';
  return 'surface';
}
