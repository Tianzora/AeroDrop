// 同源门：Worker 入口所有浏览器可直达的写入口（WS 升级、/api/share-code、/api/ice-config）
// 都先过这里做 CSRF 判定。
//
// 从 worker.ts 抽出来是为了能直接单测：入口层 fetch 一旦写反，只有真正驱动默认导出
// fetch 的测试才看得见，而这里把「哪些请求算同源」变成可枚举的纯函数。

/**
 * CSRF-only gate. Browsers send Origin/Referer/Sec-Fetch-Site, but every one of
 * those headers is client-controlled, so a non-browser client can always forge
 * one. This is not authentication and must not be relied on as such.
 *
 * 判定顺序（任一条成立即放行）：
 * 1. Origin 与请求 URL 的 origin 完全相等；
 * 2. 没有 Origin，但 Referer 的 origin 相等；
 * 3. 既没有 Origin 也没有可用 Referer，但 Sec-Fetch-Site 是 same-origin / same-site。
 *
 * 注意：这里不看 method —— OPTIONS 预检与其他方法走同一套判定，唯一依据是 Origin/Referer。
 */
export const isAllowedSameOriginRequest = (request: Request): boolean => {
  const requestOrigin = request.headers.get('Origin');
  const requestReferer = request.headers.get('Referer');
  const secFetchSite = request.headers.get('Sec-Fetch-Site');
  const requestUrl = new URL(request.url);
  const allowedOrigin = requestUrl.origin;
  let refererOrigin: string | null = null;

  if (requestReferer) {
    try {
      refererOrigin = new URL(requestReferer).origin;
    } catch {
      refererOrigin = null;
    }
  }

  return (
    requestOrigin === allowedOrigin ||
    (!requestOrigin && refererOrigin === allowedOrigin) ||
    (!requestOrigin &&
      !refererOrigin &&
      (secFetchSite === 'same-origin' || secFetchSite === 'same-site'))
  );
};
