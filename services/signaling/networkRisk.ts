// 网络风险判定（/api/network-check 与 /api/ice-config 共用）。
//
// 从 worker.ts 抽出来以便 node:test 直接覆盖：这里只依赖 Request 的 cf 对象与
// 查询参数，不碰 DurableObject / TURN 凭证。

import { parseBooleanFlag, parseNullableNumber } from './requestContext';

export type NetworkRiskReason = 'isp' | 'score' | 'location' | 'network' | null;

export type ClientNetworkHints = {
  isMobileDevice: boolean;
  networkType: string;
  effectiveType: string;
  saveData: boolean;
  rtt: number | null;
  downlink: number | null;
};

export type NetworkRiskAssessment = {
  isRisk: boolean;
  reason: NetworkRiskReason;
  details: string;
  isp: string;
  country: string;
};

export const getClientNetworkHints = (request: Request): ClientNetworkHints => {
  const url = new URL(request.url);
  return {
    isMobileDevice: parseBooleanFlag(url.searchParams.get('mobileDevice')),
    networkType: url.searchParams.get('networkType')?.trim().toLowerCase() || 'unknown',
    effectiveType: url.searchParams.get('effectiveType')?.trim().toLowerCase() || 'unknown',
    saveData: parseBooleanFlag(url.searchParams.get('saveData')),
    rtt: parseNullableNumber(url.searchParams.get('rtt')),
    downlink: parseNullableNumber(url.searchParams.get('downlink')),
  };
};

const RISK_KEYWORDS = [
  'google',
  'amazon',
  'aws',
  'microsoft',
  'azure',
  'digitalocean',
  'linode',
  'vultr',
  'alibaba',
  'tencent',
  'oracle',
  'cloudflare',
  'cdn',
  'server',
];

const MOBILE_CARRIER_KEYWORDS = [
  'mobile',
  'wireless',
  'cellular',
  'telecom',
  'unicom',
  'cmcc',
  'verizon',
  'vodafone',
  't-mobile',
  'sprint',
  'telefonica',
];

export const assessNetworkRisk = (request: Request): NetworkRiskAssessment => {
  const cf = request.cf;
  const clientNetwork = getClientNetworkHints(request);

  if (!cf) {
    const constrained = clientNetwork.networkType === 'cellular' || clientNetwork.saveData;
    return {
      isRisk: constrained,
      reason: constrained ? 'network' : null,
      details: 'Local development or CF object missing',
      isp: 'Local Dev',
      country: 'CN',
    };
  }

  const originalIsp = (cf.asOrganization as string) || 'Unknown';
  const isp = originalIsp.toLowerCase();
  const country = (cf.country as string) || 'Unknown';
  const threatScore = (cf.threatScore as number) || 0;
  const isLikelyMobileNetwork =
    clientNetwork.networkType === 'cellular' ||
    MOBILE_CARRIER_KEYWORDS.some((keyword) => isp.includes(keyword));
  const clientLooksConstrained =
    clientNetwork.saveData ||
    clientNetwork.effectiveType === 'slow-2g' ||
    clientNetwork.effectiveType === '2g' ||
    clientNetwork.effectiveType === '3g' ||
    (clientNetwork.rtt !== null && clientNetwork.rtt >= 180) ||
    (clientNetwork.downlink !== null && clientNetwork.downlink > 0 && clientNetwork.downlink < 5);

  let isRisk = false;
  let reason: NetworkRiskReason = null;
  let details = '';

  if (isLikelyMobileNetwork && (clientLooksConstrained || clientNetwork.isMobileDevice)) {
    isRisk = true;
    reason = 'network';
    details = `${originalIsp} / ${clientNetwork.networkType} / ${clientNetwork.effectiveType}`;
  } else if (RISK_KEYWORDS.some((keyword) => isp.includes(keyword))) {
    isRisk = true;
    reason = 'isp';
    details = originalIsp;
  } else if (isLikelyMobileNetwork) {
    isRisk = true;
    reason = 'network';
    details = `${originalIsp} / ${clientNetwork.networkType}`;
  } else if (threatScore > 10) {
    isRisk = true;
    reason = 'score';
    details = `Threat Score: ${threatScore}`;
  } else if (country !== 'CN') {
    reason = 'location';
    details = `Location: ${country}`;
  }

  return {
    isRisk,
    reason,
    details,
    isp: originalIsp,
    country,
  };
};
