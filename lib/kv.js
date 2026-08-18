/**
 * KV store using Upstash Redis REST API with in-memory fallback.
 * Works with the env vars automatically set when you connect
 * Upstash: KV_REST_API_URL + KV_REST_API_TOKEN or REDIS_URL
 * Defaults to in-memory store in sandbox/local environment.
 */

const inMemoryStore = new Map();

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
    return null;
  }

  // POST body avoids 431 errors when SET values are large (loop snapshot history).
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
  });
  if (!res.ok) throw new Error(`Upstash error: ${res.status}`);
  const json = await res.json();
  return json.result;
}

async function kvGet(key) {
  const url = getUrl();
  const token = getReadToken();
  if (!url || !token) {
    return inMemoryStore.get(key) ?? null;
  }
  try {
    const result = await upstashRequest(['GET', key]);
    return result !== null ? result : (inMemoryStore.get(key) ?? null);
  } catch (e) {
    console.error('[kv] GET error:', e.message);
    return inMemoryStore.get(key) ?? null;
  }
}

async function kvSet(key, value) {
  const payload = typeof value === 'string' ? value : JSON.stringify(value);
  inMemoryStore.set(key, payload);
  const url = getUrl();
  const token = getWriteToken();
  if (!url || !token) {
    return true;
  }
  try {
    await upstashRequest(['SET', key, payload], { write: true });
    return true;
  } catch (e) {
    console.error('[kv] SET remote error:', key, e.message);
    return true;
  }
}

async function kvDel(key) {
  inMemoryStore.delete(key);
  const url = getUrl();
  const token = getWriteToken();
  if (!url || !token) return;
  try {
    await upstashRequest(['DEL', key], { write: true });
  } catch (e) {
    console.error('[kv] DEL error:', e.message);
  }
}

module.exports = { kvGet, kvSet, kvDel };
