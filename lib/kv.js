/**
 * KV store using Upstash Redis REST API directly.
 * Works with the env vars automatically set when you connect
 * Upstash to your Vercel project:
 *   KV_REST_API_URL + KV_REST_API_TOKEN
 * or
 *   REDIS_URL (Upstash REST URL)
 */

function getUrl()   { return process.env.KV_REST_API_URL  || process.env.REDIS_URL || ''; }
function getReadToken() {
  return process.env.KV_REST_API_TOKEN || process.env.KV_REST_API_READ_ONLY_TOKEN || '';
}
function getWriteToken() {
  return process.env.KV_REST_API_TOKEN || '';
}

async function upstashRequest(command, { write = false } = {}) {
  const url   = getUrl();
  const token = write ? getWriteToken() : getReadToken();

  if (!url || !token) {
    if (write) throw new Error('KV write token is not configured');
    return null;
  }

  const res = await fetch(`${url}/${command.map(encodeURIComponent).join('/')}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Upstash error: ${res.status}`);
  const json = await res.json();
  return json.result;
}

async function kvGet(key) {
  try {
    const result = await upstashRequest(['GET', key]);
    return result;
  } catch (e) {
    console.error('[kv] GET error:', e.message);
    return null;
  }
}

async function kvSet(key, value) {
  const payload = typeof value === 'string' ? value : JSON.stringify(value);
  if (!getUrl() || !getWriteToken()) {
    console.error('[kv] SET skipped: write token missing for key', key);
    throw new Error('KV write token is not configured');
  }
  try {
    await upstashRequest(['SET', key, payload], { write: true });
    return true;
  } catch (e) {
    console.error('[kv] SET error:', key, e.message);
    throw e;
  }
}

async function kvDel(key) {
  try {
    await upstashRequest(['DEL', key], { write: true });
  } catch (e) {
    console.error('[kv] DEL error:', e.message);
  }
}

module.exports = { kvGet, kvSet, kvDel };
