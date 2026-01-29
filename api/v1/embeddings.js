const PUTER_URL = 'https://api.puter.com/drivers/v1/call';

function unauthorized(res) {
  return res.status(401).json({ error: 'Invalid Proxy API Key' });
}

// OpenAI-compatible /v1/embeddings
// POST /api/v1/embeddings
// Body: { "model": "...", "input": "text" | ["text", ...] }
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const incomingKey = req.headers['authorization']?.replace('Bearer ', '');
  if (process.env.PROXY_API_KEY && incomingKey !== process.env.PROXY_API_KEY) {
    return unauthorized(res);
  }

  const puterToken = process.env.PUTER_TOKEN;
  if (!puterToken) {
    return res.status(500).json({ error: 'Server misconfiguration: Missing PUTER_TOKEN' });
  }

  const { input, model } = req.body || {};
  const selectedModel = model || 'text-embedding-3-small';

  if (typeof input !== 'string' && !Array.isArray(input)) {
    return res.status(400).json({ error: 'Invalid request: input must be a string or array of strings' });
  }

  // Puter embeddings interface is not documented the same way as chat in the snippet you provided.
  // This implementation calls a best-effort "puter.ai.embeddings" method.
  // If Puter uses a different method name in your environment, change `method` below accordingly.
  try {
    const upstream = await fetch(PUTER_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${puterToken}`,
        'Content-Type': 'application/json',
        'Origin': 'https://puter.com'
      },
      body: JSON.stringify({
        interface: 'puter.ai',
        method: 'embeddings',
        args: [input, { model: selectedModel }]
      })
    });

    if (!upstream.ok) {
      const txt = await upstream.text();
      return res.status(502).json({
        error: {
          message: `Puter API Error: ${upstream.status} - ${txt}`,
          type: 'upstream_error'
        }
      });
    }

    const data = await upstream.json();

    // Try to normalize to OpenAI Embeddings response shape.
    // If Puter returns a raw embedding array, wrap it.
    const created = Math.floor(Date.now() / 1000);

    let embeddings = null;

    if (Array.isArray(data)) {
      // Could be single embedding vector
      embeddings = [{ index: 0, object: 'embedding', embedding: data }];
    } else if (Array.isArray(data?.data)) {
      // Already looks OpenAI-ish
      embeddings = data.data.map((d, i) => ({
        index: d.index ?? i,
        object: 'embedding',
        embedding: d.embedding ?? d.vector ?? d
      }));
    } else if (Array.isArray(data?.embedding)) {
      embeddings = [{ index: 0, object: 'embedding', embedding: data.embedding }];
    } else if (Array.isArray(data?.embeddings)) {
      embeddings = data.embeddings.map((e, i) => ({ index: i, object: 'embedding', embedding: e }));
    } else {
      // Fallback: unknown shape
      return res.status(502).json({
        error: {
          message: 'Upstream embeddings response had an unrecognized shape',
          type: 'upstream_error',
          details: data
        }
      });
    }

    return res.status(200).json({
      object: 'list',
      data: embeddings,
      model: selectedModel,
      usage: {
        prompt_tokens: 0,
        total_tokens: 0
      }
    });

  } catch (error) {
    console.error('Embeddings Proxy Error:', error);
    return res.status(500).json({
      error: {
        message: error?.message || 'Internal Proxy Error',
        type: 'server_error'
      }
    });
  }
}
