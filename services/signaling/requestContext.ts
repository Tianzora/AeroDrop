// 请求上下文里的标量解析：客户端身份键与环境变量的整数参数。
//
// 从 worker.ts 抽出来是为了能在 node:test 里直接覆盖（worker.ts 依赖 DurableObject
// 运行时，不能被测试 import）。

/**
 * 信令 / 口令限流用的客户端键。
 *
 * 只信任 Cloudflare 注入的 `CF-Connecting-IP`。`X-Forwarded-For` 是客户端可控的，
 * 非 CF 环境（或直连 origin 的请求）里回退到它等于把「换 IP 绕过限流」交给调用方，
 * 所以拿不到 CF 头时统一返回 `ip:unknown`（所有非 CF 流量并入同一个桶）。
 * 注意：本地 `wrangler dev` 与 E2E 都由 wrangler 注入该头，行为不变。
 */
export const resolveSignalingClientKey = (headers: Headers): string => {
  const cfConnectingIp = headers.get('CF-Connecting-IP')?.trim();
  if (cfConnectingIp) return `ip:${cfConnectingIp}`;

  return 'ip:unknown';
};

/** 解析正整数环境变量；缺失 / 非法 / <=0 一律回退。 */
export const parsePositiveInt = (value: string | undefined, fallback: number): number => {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const parseBooleanFlag = (value: string | null): boolean => value === '1' || value === 'true';

/** 解析非负有限数（网络提示参数）；缺失或非法返回 null。 */
export const parseNullableNumber = (value: string | null): number | null => {
  if (!value) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};
