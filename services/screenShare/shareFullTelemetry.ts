/**
 * share-full 送达计数。
 *
 * 分享端满员时给被拒的观众发 share-full 是 best-effort：deliverShareFull 返回 false
 * 就代表这条告知没送出去，观众只能等到 20s 超时、被报成网络/防火墙问题。旧实现把这个
 * 返回值直接丢掉，于是「多少人被满员静默误导」在线上完全没有数字。
 *
 * logDebug 在 node 测试里是 no-op（依赖 import.meta.env），所以计数与回报都走可注入的
 * sink：组件用默认 sink，测试注入自己的收集器。
 */

import { logDebug } from '../diagnostics.ts';
import type { ShareFullDelivery } from './viewerAdmission.ts';

export interface ShareFullDeliverySample {
  delivery: ShareFullDelivery;
  count: number;
}

export type ShareFullTelemetrySink = (sample: ShareFullDeliverySample) => void;

export interface ShareFullTelemetry {
  /** 记录一次送达结果：成功忽略，失败累加计数并回报。 */
  record(delivery: ShareFullDelivery, delivered: boolean): void;
  /** 本次会话累计失败次数。 */
  failures(): number;
}

export const SHARE_FULL_TELEMETRY_PREFIX = 'screen_share_metric';

export const createShareFullTelemetry = (
  sink: ShareFullTelemetrySink = () => {},
): ShareFullTelemetry => {
  let failures = 0;
  return {
    record(delivery, delivered) {
      if (delivered) return;
      failures += 1;
      const sample: ShareFullDeliverySample = { delivery, count: failures };
      logDebug('warn', SHARE_FULL_TELEMETRY_PREFIX, sample);
      sink(sample);
    },
    failures: () => failures,
  };
};
