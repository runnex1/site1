import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const {
  DEFAULT_GRVT_PROXY_COUNTRY,
  grvtProxyCountry,
  buildIproyalProxyUrl,
  buildBrightDataProxyUrl,
  buildComponentProxyUrl,
  webshareProxyToUrl,
  grvtProxyUrlFromExplicit,
} = require(join(ROOT, 'lib', 'grvt-proxy.js'));

assert.equal(DEFAULT_GRVT_PROXY_COUNTRY, 'ro');

delete process.env.GRVT_PROXY_COUNTRY;
assert.equal(grvtProxyCountry(), 'ro');

process.env.GRVT_PROXY_COUNTRY = 'RO';
assert.equal(grvtProxyCountry(), 'ro');

delete process.env.GRVT_PROXY_URL;
delete process.env.HTTPS_PROXY;
assert.equal(grvtProxyUrlFromExplicit(), null);

process.env.GRVT_PROXY_URL = 'http://user:pass@proxy.example:8080';
assert.equal(grvtProxyUrlFromExplicit(), 'http://user:pass@proxy.example:8080');
delete process.env.GRVT_PROXY_URL;

process.env.IPROYAL_PROXY_USER = 'iproyal-user';
process.env.IPROYAL_PROXY_PASS = 'secret';
delete process.env.GRVT_PROXY_SESSION;
const iproyal = buildIproyalProxyUrl();
assert.match(iproyal, /^http:\/\/iproyal-user:secret_country-ro_session-grvt\d+@geo\.iproyal\.com:12321$/);
delete process.env.IPROYAL_PROXY_USER;
delete process.env.IPROYAL_PROXY_PASS;

process.env.BRIGHTDATA_PROXY_USER = 'brd-customer-zone-residential';
process.env.BRIGHTDATA_PROXY_PASS = 'pass';
const bright = buildBrightDataProxyUrl();
assert.equal(bright, 'http://brd-customer-zone-residential-country-ro:pass@brd.superproxy.io:22225');
delete process.env.BRIGHTDATA_PROXY_USER;
delete process.env.BRIGHTDATA_PROXY_PASS;

process.env.GRVT_PROXY_HOST = 'ro.proxy.local';
process.env.GRVT_PROXY_USER = 'u';
process.env.GRVT_PROXY_PASS = 'p';
process.env.GRVT_PROXY_PORT = '3128';
assert.equal(buildComponentProxyUrl(), 'http://u:p@ro.proxy.local:3128');
delete process.env.GRVT_PROXY_HOST;
delete process.env.GRVT_PROXY_USER;
delete process.env.GRVT_PROXY_PASS;
delete process.env.GRVT_PROXY_PORT;

const direct = webshareProxyToUrl({
  username: 'ws-user',
  password: 'ws-pass',
  proxy_address: '1.2.3.4',
  port: 9999,
}, 'direct');
assert.equal(direct, 'http://ws-user:ws-pass@1.2.3.4:9999');

const backbone = webshareProxyToUrl({
  username: 'ws-user',
  password: 'ws-pass',
  port: 80,
}, 'backbone');
assert.equal(backbone, 'http://ws-user:ws-pass@p.webshare.io:80');

console.log('PASS: grvt-proxy URL builders default to Romania');
