import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const {
  DEFAULT_GRVT_EGRESS_COUNTRY,
  DEFAULT_GRVT_VERCEL_REGION,
  grvtEgressCountry,
  grvtProxyUrlFromExplicit,
  resolveGrvtProxyMeta,
} = require(join(ROOT, 'lib', 'grvt-proxy.js'));

assert.equal(DEFAULT_GRVT_EGRESS_COUNTRY, 'de');
assert.equal(DEFAULT_GRVT_VERCEL_REGION, 'fra1');

delete process.env.GRVT_EGRESS_COUNTRY;
delete process.env.GRVT_PROXY_COUNTRY;
assert.equal(grvtEgressCountry(), 'de');

process.env.GRVT_EGRESS_COUNTRY = 'SG';
assert.equal(grvtEgressCountry(), 'sg');

delete process.env.GRVT_PROXY_URL;
delete process.env.HTTPS_PROXY;
assert.equal(grvtProxyUrlFromExplicit(), null);

const direct = await resolveGrvtProxyMeta();
assert.equal(direct.source, 'direct');
assert.equal(direct.country, 'sg');
assert.equal(direct.url, null);

process.env.GRVT_PROXY_URL = 'http://user:pass@proxy.example:8080';
const proxied = await resolveGrvtProxyMeta();
assert.equal(proxied.source, 'env');
assert.equal(proxied.url, 'http://user:pass@proxy.example:8080');
delete process.env.GRVT_PROXY_URL;
delete process.env.GRVT_EGRESS_COUNTRY;

console.log('PASS: grvt-proxy defaults to direct Germany egress');
