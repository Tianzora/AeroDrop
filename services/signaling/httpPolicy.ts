// 响应策略：安全头 + 静态资源缓存策略 + 分享链接 noindex。
//
// 从 worker.ts 抽出来以便 node:test 直接覆盖（纯 Request/Response 变换）。

const IMMUTABLE_ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';
const HTML_CACHE_CONTROL = 'no-cache';
const SW_CACHE_CONTROL = 'no-cache';
const MANIFEST_CACHE_CONTROL = 'no-cache';

export const setSecurityHeaders = (headers: Headers): void => {
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('Permissions-Policy', 'camera=(), microphone=(self), geolocation=()');
  headers.set('X-XSS-Protection', '1; mode=block');
  if (!headers.has('Strict-Transport-Security')) {
    headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  }
};

export const applyResponsePolicies = (request: Request, response: Response): Response => {
  const headers = new Headers(response.headers);
  setSecurityHeaders(headers);

  const method = request.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD') {
    const pathname = new URL(request.url).pathname.toLowerCase();

    if (pathname === '/sw.js') {
      headers.set('Cache-Control', SW_CACHE_CONTROL);
    } else if (pathname === '/manifest.json') {
      headers.set('Cache-Control', MANIFEST_CACHE_CONTROL);
    } else if (pathname.endsWith('.js') || pathname.endsWith('.css')) {
      headers.set('Cache-Control', IMMUTABLE_ASSET_CACHE_CONTROL);
    } else if (pathname === '/' || pathname.endsWith('/index.html') || pathname.endsWith('.html')) {
      headers.set('Cache-Control', HTML_CACHE_CONTROL);

      // 分享链接（文件 ?code=、屏幕共享 ?view=）只对持链接的人有效，不该被搜索引擎收录。
      // 响应头对不执行 JS 的爬虫同样生效，静态 meta 做不到这一点。
      const url = new URL(request.url);
      if (url.searchParams.has('code') || url.searchParams.has('view')) {
        headers.set('X-Robots-Tag', 'noindex');
      }
    }
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};
