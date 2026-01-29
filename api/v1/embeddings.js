// Embeddings (CommonJS) + PUTER_TOKENS rotation (reuses chat/tokenPool.js)
// Works with your current setup where tokenPool is located at: api/v1/chat/tokenPool.js
//
// Env knobs (optional):
// - PUTER_EMBEDDINGS_SERVICE: override service name (default: "openai")
// - PUTER_EMBEDDINGS_INTERFACE: override interface name (default: "puter-embeddings")
// - PUTER_EMBEDDINGS_METHOD: override method name (default: "embed")
//
// Notes:
// - Retries next token on: 401/403/429/5xx and on driver "No implementation available" errors
// - Normalizes multiple upstream response shapes into OpenAI Embeddings format

const { hasAnyToken, getToken, reportTokenResult } = require('./chat/tokenPool');

const DRIVER_PATH = '/drivers/call';
const HOSTS = ['https://api.puter.com', 'https://puter.com'];

function normalizeInput(input) {
  if (typeof input === 'string') return input;
  if (Array.isArray(input)) {
    // Ensure it's an array of strings (OpenAI allows array of strings)
    return input.map(x => (typeof x === 'string' ? x : JSON.stringify(x)));
  }
  return null;
}

function isNoImplError(msg) {
  return typeof msg === 'string' && msg.includes('No implementation available for interface');
}

async function callDriverWithToken({ token, body }) {
  let lastErr = null;
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
      lastErr = e;
    }
  }
  throw lastErr || new Error('All upstream hosts failed');
}

function toOpenAIEmbeddings({ model, input, upstream }) {
  // Try a few common shapes:
  // 1) Already OpenAI-like: {object:"list", data:[{embedding: [...] }], model:"..."}
  if (upstream && typeof upstream === 'object' && upstream.object === 'list' && Array.isArray(upstream.data)) {
    return upstream;
  }

  // 2) Upstream returns { embedding: [...] } or { data: { embedding: [...] } }
  const directEmbedding = upstream?.embedding || upstream?.data?.embedding;
  if (Array.isArray(directEmbedding)) {
    return {
      object: 'list',
      data: [{ object: 'embedding', index: 0, embedding: directEmbedding }],
      model,
      usage: { prompt_tokens: 0, total_tokens: 0 }
    };
  }

  // 3) Upstream returns array of vectors (one per input)
  if (Array.isArray(upstream) && upstream.length && Array.isArray(upstream[0])) {
    return {
      object: 'list',
      data: upstream.map((vec, i) => ({ object: 'embedding', index: i, embedding: vec })),
      model,
      usage: { prompt_tokens: 0, total_tokens: 0 }
    };
  }

  // 4) Upstream returns { data: [ [..vec..], [..vec..] ] }
  if (Array.isArray(upstream?.data) && upstream.data.length && Array.isArray(upstream.data[0])) {
    return {
      object: 'list',
      data: upstream.data.map((vec, i) => ({ object: 'embedding', index: i, embedding: vec })),
      model,
      usage: { prompt_tokens: 0, total_tokens: 0 }
    };
  }

  // 5) If input was a single string and upstream is a single vector
  if (typeof input === 'string' && Array.isArray(upstream)) {
    return {
      object: 'list',
      data: [{ object: 'embedding', index: 0, embedding: upstream }],
      model,
      usage: { prompt_tokens: 0, total_tokens: 0 }
    };
  }

  return null;
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const incomingKey = req.headers['authorization']?.replace('Bearer ', '');
  if (process.env.PROXY_API_KEY && incomingKey !== process.env.PROXY_API_KEY) {
    return res.status(401).json({ error: 'Invalid Proxy API Key' });
  }

  if (!hasAnyToken()) {
    return res.status(500).json({ error: 'Server misconfiguration: Missing PUTER_TOKEN(S)' });
  }

  const body = req.body || {};
  const input = normalizeInput(body.input);
  const model = body.model || 'text-embedding-3-small';

  if (input == null) {
    return res.status(400).json({ error: 'Invalid request: input must be a string or array of strings' });
  }

  const iface = process.env.PUTER_EMBEDDINGS_INTERFACE || 'puter-embeddings';
  const method = process.env.PUTER_EMBEDDINGS_METHOD || 'embed';
  const service = process.env.PUTER_EMBEDDINGS_SERVICE || 'openai';

  const driverBody = {
    interface: iface,
    service,
    method,
    args: { input, model }
  };

  const maxAttempts = Math.max(1, Number(process.env.PUTER_TOKEN_MAX_ATTEMPTS || 3));
  let lastMsg = null;
  let lastStatus = 502;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const token = getToken();
    if (!token) break;

    try {
      const upstream = await callDriverWithToken({ token, body: driverBody });

      // Envelope error?
      if (upstream.json && typeof upstream.json === 'object' && upstream.json.success === false) {
        const msg = upstream.json?.error?.message || JSON.stringify(upstream.json.error || upstream.json);
        lastMsg = msg;
        lastStatus = 502;

        // Treat "no implementation" as retryable across tokens
        if (isNoImplError(msg)) {
          reportTokenResult(token, { ok: false, status: 502 });
          continue;
        }

        reportTokenResult(token, { ok: false, status: 502 });
        continue;
      }

      // HTTP error?
      if (!upstream.ok) {
        const msg = upstream.text || JSON.stringify(upstream.json || {});
        lastMsg = msg;
        lastStatus = upstream.status;
        reportTokenResult(token, { ok: false, status: upstream.status });

        if ([401,403,429].includes(upstream.status) || (upstream.status >= 500 && upstream.status <= 599)) continue;
        return res.status(upstream.status).json({ error: { message: msg, type: 'upstream_error' } });
      }

      reportTokenResult(token, { ok: true, status: 200 });

      const result = upstream.json?.result ?? upstream.json ?? upstream.text;
      const mapped = toOpenAIEmbeddings({ model, input, upstream: result });

      if (!mapped) {
        return res.status(502).json({
          error: {
            message: 'Unrecognized upstream embeddings response shape',
            type: 'upstream_error',
            details: result
          }
        });
      }

      // Ensure correct model field
      if (!mapped.model) mapped.model = model;
      return res.status(200).json(mapped);

    } catch (e) {
      lastMsg = String(e?.message || e);
      lastStatus = 502;
      reportTokenResult(token, { ok: false, status: 599 });
      continue;
    }
  }

  return res.status(lastStatus).json({ error: { message: lastMsg || 'All tokens failed', type: 'upstream_error' } });
};
