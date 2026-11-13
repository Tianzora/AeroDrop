import test from 'node:test';
import assert from 'node:assert/strict';

import { assessNetworkRisk, getClientNetworkHints } from './networkRisk.ts';

const request = (query: string, cf?: IncomingRequestCfProperties): Request => {
  const req = new Request(`https://drop.example/api/ice-config${query}`);
  if (cf) {
    Object.defineProperty(req, 'cf', { value: cf });
  }
  return req;
};

const cf = (overrides: Partial<IncomingRequestCfProperties>): IncomingRequestCfProperties =>
  ({ asOrganization: 'China Mobile', country: 'CN', threatScore: 0, ...overrides }) as IncomingRequestCfProperties;

test('reads network hints from query parameters', () => {
  assert.deepEqual(getClientNetworkHints(request('?networkType=Cellular&saveData=1&mobileDevice=true&rtt=300&downlink=1.5')), {
    isMobileDevice: true,
    networkType: 'cellular',
    effectiveType: 'unknown',
    saveData: true,
    rtt: 300,
    downlink: 1.5,
  });
});

test('treats missing cf as local development and only honours client hints', () => {
  assert.deepEqual(assessNetworkRisk(request('')), {
    isRisk: false,
    reason: null,
    details: 'Local development or CF object missing',
    isp: 'Local Dev',
    country: 'CN',
  });
  // 本地开发也没有 cf 时，客户端自报的蜂窝网络仍然可以触发 relay。
  const cellular = assessNetworkRisk(request('?networkType=cellular'));
  assert.equal(cellular.isRisk, true);
  assert.equal(cellular.reason, 'network');
});

test('flags constrained mobile networks and hosting-provider ISPs', () => {
  const mobile = assessNetworkRisk(request('?networkType=cellular&mobileDevice=1', cf({})));
  assert.equal(mobile.isRisk, true);
  assert.equal(mobile.reason, 'network');
  assert.ok(mobile.details.includes('China Mobile'));

  const datacenter = assessNetworkRisk(request('', cf({ asOrganization: 'Amazon.com, Inc.' })));
  assert.equal(datacenter.isRisk, true);
  assert.equal(datacenter.reason, 'isp');

  const cloudflare = assessNetworkRisk(request('', cf({ asOrganization: 'Cloudflare, Inc.' })));
  assert.equal(cloudflare.reason, 'isp');
});

test('flags high threat scores and non-CN locations', () => {
  const noisy = assessNetworkRisk(request('', cf({ threatScore: 42, asOrganization: 'Beijing Broadband Ltd' })));
  assert.equal(noisy.isRisk, true);
  assert.equal(noisy.reason, 'score');
  assert.ok(noisy.details.includes('42'));

  const abroad = assessNetworkRisk(request('', cf({ country: 'US', asOrganization: 'Comcast' })));
  assert.equal(abroad.isRisk, false);
  assert.equal(abroad.reason, 'location');
  assert.ok(abroad.details.includes('US'));
});

test('leaves ordinary domestic residential traffic alone', () => {
  const residential = assessNetworkRisk(
    request('', cf({ asOrganization: 'Beijing Broadband Ltd', country: 'CN' }))
  );
  assert.deepEqual(residential, {
    isRisk: false,
    reason: null,
    details: '',
    isp: 'Beijing Broadband Ltd',
    country: 'CN',
  });
});
