// OpenAI-compatible Embeddings -> Puter Drivers API + token rotation
import { getToken, hasAnyToken, reportTokenResult } from '../_lib/tokenPool.js';

const DRIVER_PATH = '/drivers/call';
const HOSTS = ['https://api.puter.com', 'https://puter.com'];

async function callDriverWithToken({ token, body }) {
  let last = null;
  for (const host of HOSTS) {
    try {
      const r = await fetch(host + DRIVER_PATH, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Origin': 'https://puter.com'
        },
        body: JSON.stringify(body)
      });

      const ct = (r.headers.get('content-type') || '').toLowerCase();
      const json = ct.includes('application/json') ? await r.json() : null;
      const text = ct.includes('application/json') ? null : await r.text();
      return { ok: r.ok, status: r.status, json, text, host };
    } catch (e) {
      last = e;
    }
  }
  throw last || new Error('All upstream hosts failed');
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const incomingKey = req.headers['authorization']?.replace('Bearer ', '');
  if (process.env.PROXY_API_KEY && incomingKey !== process.env.PROXY_API_KEY) {
    return res.status(401).json({ error: 'Invalid Proxy API Key' });
  }

  if (!hasAnyToken()) {
    return res.status(500).json({ error: 'Server misconfiguration: Missing PUTER_TOKEN(S)' });
  }

  const { input, model } = req.body || {};
  const selectedModel = model || 'text-embedding-3-small';

  if (typeof input !== 'string' && !Array.isArray(input)) {
    return res.status(400).json({ error: 'Invalid request: input must be a string or array of strings' });
  }

  const driverBody = {
    interface: 'puter-embeddings',
    service: 'openai',
    method: 'embed',
    args: { input, model: selectedModel }
  };

  const maxAttempts = Math.max(1, Number(process.env.PUTER_TOKEN_MAX_ATTEMPTS || 3));
  let lastErr = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const token = getToken();
    if (!token) break;

    try {
      const upstream = await callDriverWithToken({ token, body: driverBody });

      if (upstream.json && typeof upstream.json === 'object' && upstream.json.success === false) {
        const msg = upstream.json?.error?.message || JSON.stringify(upstream.json.error || upstream.json);
        reportTokenResult(token, { ok: false, status: 502, errorText: msg });
        lastErr = { status: 502, msg };
        continue;
      }

      if (!upstream.ok) {
        const msg = upstream.text || JSON.stringify(upstream.json || {});
        reportTokenResult(token, { ok: false, status: upstream.status, errorText: msg });
        lastErr = { status: upstream.status, msg };
        if (upstream.status === 429 || (upstream.status >= 500 && upstream.status <= 599) || upstream.status === 401 || upstream.status === 403) continue;
        return res.status(upstream.status).json({ error: { message: msg, type: 'upstream_error' } });
      }

      reportTokenResult(token, { ok: true, status: 200 });

      const result = upstream.json?.result ?? upstream.json ?? upstream.text;

      // Normalize embeddings to OpenAI list
      if (result && Array.isArray(result.data)) {
        return res.status(200).json({ ...result, model: result.model || selectedModel });
      }

      if (Array.isArray(result)) {
        return res.status(200).json({
          object: 'list',
          data: [{ object: 'embedding', index: 0, embedding: result }],
          model: selectedModel,
          usage: { prompt_tokens: 0, total_tokens: 0 }
        });
      }

      if (Array.isArray(result?.embedding)) {
        return res.status(200).json({
          object: 'list',
          data: [{ object: 'embedding', index: 0, embedding: result.embedding }],
          model: selectedModel,
          usage: { prompt_tokens: 0, total_tokens: 0 }
        });
      }

      return res.status(502).json({ error: { message: 'Unrecognized upstream embeddings response shape', type: 'upstream_error', details: result } });

    } catch (e) {
      lastErr = { status: 500, msg: String(e?.message || e) };
      reportTokenResult(token, { ok: false, status: 599, errorText: lastErr.msg });
      continue;
    }
  }

  return res.status(502).json({ error: { message: lastErr?.msg || 'All tokens failed', type: 'upstream_error' } });
}
