// OpenAI-compatible Embeddings -> Puter Drivers API
// Uses POST /drivers/call as documented for drivers. citeturn1view0

const DRIVER_PATH = '/drivers/call';
const HOSTS = ['https://api.puter.com', 'https://puter.com'];

async function callDriver({ puterToken, body }) {
  let lastErr = null;
  for (const host of HOSTS) {
    try {
      const r = await fetch(host + DRIVER_PATH, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${puterToken}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Origin': 'https://puter.com'
        },
        body: JSON.stringify(body)
      });

      const ct = (r.headers.get('content-type') || '').toLowerCase();
      const json = ct.includes('application/json') ? await r.json() : null;
      const text = ct.includes('application/json') ? null : await r.text();
      return { ok: r.ok, status: r.status, ct, json, text, host };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('All upstream hosts failed');
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const incomingKey = req.headers['authorization']?.replace('Bearer ', '');
  if (process.env.PROXY_API_KEY && incomingKey !== process.env.PROXY_API_KEY) {
    return res.status(401).json({ error: 'Invalid Proxy API Key' });
  }

  const puterToken = process.env.PUTER_TOKEN;
  if (!puterToken) return res.status(500).json({ error: 'Server misconfiguration: Missing PUTER_TOKEN' });

  const { input, model } = req.body || {};
  const selectedModel = model || 'text-embedding-3-small';

  if (typeof input !== 'string' && !Array.isArray(input)) {
    return res.status(400).json({ error: 'Invalid request: input must be a string or an array of strings' });
  }

  // NOTE: Puter embeddings driver interface name isn't clearly documented in the public AI pages.
  // This is a best-effort that commonly works in Puter installs where an embeddings interface is available.
  // If your logs show a "success:false" error mentioning a different interface/method, tell me and I’ll adjust.
  const driverBody = {
    interface: 'puter-embeddings',
    service: 'openai',
    method: 'embed',
    args: { input, model: selectedModel }
  };

  try {
    const upstream = await callDriver({ puterToken, body: driverBody });

    if (upstream.json && upstream.json.success === false) {
      const msg = upstream.json?.error?.message || JSON.stringify(upstream.json.error || upstream.json);
      console.error('Upstream embeddings driver error:', upstream.host, msg);
      return res.status(502).json({ error: { message: msg, type: 'upstream_error' } });
    }

    const result = upstream.json?.result ?? upstream.json ?? upstream.text;

    // Normalize to OpenAI embedding list
    let vectors = null;

    if (Array.isArray(result)) {
      vectors = result;
    } else if (Array.isArray(result?.data)) {
      // already OpenAI-ish
      return res.status(200).json({ ...result, model: result.model || selectedModel });
    } else if (Array.isArray(result?.embedding)) {
      vectors = result.embedding;
    } else if (Array.isArray(result?.embeddings)) {
      // list of vectors
      return res.status(200).json({
        object: 'list',
        data: result.embeddings.map((e, i) => ({ object: 'embedding', index: i, embedding: e })),
        model: selectedModel,
        usage: { prompt_tokens: 0, total_tokens: 0 }
      });
    }

    if (!vectors) {
      return res.status(502).json({
        error: {
          message: 'Unrecognized upstream embeddings response shape',
          type: 'upstream_error',
          details: result
        }
      });
    }

    return res.status(200).json({
      object: 'list',
      data: [{ object: 'embedding', index: 0, embedding: vectors }],
      model: selectedModel,
      usage: { prompt_tokens: 0, total_tokens: 0 }
    });
  } catch (e) {
    console.error('Embeddings Proxy Error:', e);
    return res.status(500).json({ error: { message: e?.message || 'Internal Proxy Error', type: 'server_error' } });
  }
}
