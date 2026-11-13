/**
 * 屏幕录制失败的中文说明。
 *
 * 浏览器抛出的 `message`（如 "Permission denied by system"）是英文实现细节，
 * 直接拼进中文提示会得到「浏览器拒绝了屏幕录制：Permission denied by system，请检查…」
 * 这种半英文句子。这里只按 `name` + 环境做映射，原始 name/message 仍然带出去供日志使用。
 */

export type ScreenCaptureFailure = {
  name: string;
  message: string;
  isCancel: boolean;
  description: string;
};

export type ScreenCaptureEnvironment = {
  /** 页面是否嵌在 iframe/预览框里：浏览器默认禁止在那里录制屏幕。 */
  embedded: boolean;
  /** 这次调用是否被识别为用户手势（脚本/自动化触发时不是）。 */
  userActivation: boolean;
};

const UNKNOWN_DESCRIPTION = '屏幕共享启动失败，请检查浏览器的屏幕录制权限与系统隐私设置后重试';

export const describeScreenCaptureFailure = (
  error: unknown,
  environment: ScreenCaptureEnvironment,
): ScreenCaptureFailure => {
  const name =
    error instanceof DOMException || error instanceof Error
      ? error.name
      : '';
  const message = error instanceof Error ? error.message : String(error ?? '');
  const { embedded, userActivation } = environment;

  if (name === 'AbortError') {
    return { name, message, isCancel: true, description: '用户取消了屏幕共享' };
  }

  if (name === 'NotSupportedError') {
    return {
      name,
      message,
      isCancel: false,
      description: '当前环境不支持屏幕录制（无桌面会话、无头浏览器或嵌入式预览框）',
    };
  }

  if (name === 'NotReadableError') {
    return {
      name,
      message,
      isCancel: false,
      description: '系统拒绝了屏幕录制（可能被安全软件、录屏或会议软件占用），请关闭后重试',
    };
  }

  if (name === 'NotFoundError') {
    return {
      name,
      message,
      isCancel: false,
      description: '没有找到可共享的屏幕或窗口，请确认系统允许屏幕捕获后再试',
    };
  }

  if (name === 'SecurityError') {
    return {
      name,
      message,
      isCancel: false,
      description: '当前页面的安全策略禁止共享屏幕，请在独立标签页中打开后重试',
    };
  }

  if (name === 'NotAllowedError') {
    // Chrome 对「用户取消」「策略拒绝」「缺少用户手势」都给 NotAllowedError，
    // 只有 message 恰好是 "Permission denied" 且页面不在 iframe 里时才可能是取消。
    const looksLikeCancel = /^permission denied\.?$/i.test(message.trim());
    if (looksLikeCancel && !embedded && userActivation) {
      return { name, message, isCancel: true, description: '用户取消了屏幕共享' };
    }
    if (embedded) {
      return {
        name,
        message,
        isCancel: false,
        description:
          '浏览器拒绝了屏幕录制：当前页面嵌在预览框/iframe 中，浏览器默认禁止在这里录制屏幕，请在新标签页直接打开后重试',
      };
    }
    if (!userActivation) {
      return {
        name,
        message,
        isCancel: false,
        description:
          '浏览器没有把这次点击识别为用户手势（可能是脚本或自动化触发），请在页面上手动点击「开始共享屏幕」后重试',
      };
    }
    return {
      name,
      message,
      isCancel: false,
      description:
        '浏览器拒绝了屏幕录制：请检查站点的屏幕录制权限、企业策略或系统隐私设置，或在独立标签页中重试',
    };
  }

  return { name, message, isCancel: false, description: UNKNOWN_DESCRIPTION };
};
