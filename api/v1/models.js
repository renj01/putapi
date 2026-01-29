let cache = { ts: 0, data: null };
const CACHE_MS = 10 * 60 * 1000; // 10 minutes
const PUTER_MODELS_URL = 'https://puter.com/puterai/chat/models/details';

function normalizeToOpenAI(models) {
  const created = Math.floor(Date.now() / 1000);

  // OpenAI /v1/models expects: {object:"list", data:[{id,object,created,owned_by}, ...]}
  // We map Puter `provider` to `owned_by`. We also expose both forms of ids:
  // - If Puter returns provider-prefixed aliases, keep exact `id` so it works when passed back to Puter.
  return models.map((m) => ({
    id: m.id,
    object: 'model',
    created,
    owned_by: m.provider || 'puter',
    // Non-standard extras (harmless for most clients)
    ...(m.name ? { name: m.name } : {}),
    ...(m.context ? { context_length: m.context } : {}),
    ...(m.max_tokens ? { max_output_tokens: m.max_tokens } : {}),
    ...(m.aliases ? { aliases: m.aliases } : {})
  }));
}

export default async function handler(req, res) {
  // CORS preflight
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // Optional: protect this endpoint too
  // const incomingKey = req.headers['authorization']?.replace('Bearer ', '');
  // if (process.env.PROXY_API_KEY && incomingKey !== process.env.PROXY_API_KEY) {
  //   return res.status(401).json({ error: 'Invalid Proxy API Key' });
  // }

  try {
    const now = Date.now();
    if (cache.data && (now - cache.ts) < CACHE_MS) {
      return res.status(200).json({ object: 'list', data: cache.data });
    }

    // Public endpoint described in Puter docs:
    // "pulled from the same source as the public /puterai/chat/models/details endpoint"
    const r = await fetch(PUTER_MODELS_URL, {
      headers: {
        'Accept': 'application/json',
        // Some Puter endpoints behave better with an Origin header
        'Origin': 'https://puter.com'
      }
    });

    if (!r.ok) {
      const txt = await r.text();
      throw new Error(`Failed to fetch models: ${r.status} - ${txt}`);
    }

    const raw = await r.json();

    // The endpoint typically returns an array of model objects
    if (!Array.isArray(raw)) {
      throw new Error('Models endpoint returned unexpected shape (expected array).');
    }

    const openaiModels = normalizeToOpenAI(raw);

    cache = { ts: now, data: openaiModels };

    return res.status(200).json({
      object: 'list',
      data: openaiModels
    });
  } catch (error) {
    console.error('Models Error:', error);

    // Safe fallback (minimal) so clients still work if upstream is down
    const created = Math.floor(Date.now() / 1000);
    return res.status(200).json({
      object: 'list',
      data: [
        { id: 'gpt-5-nano', object: 'model', created, owned_by: 'puter' },
        { id: 'gpt-4o', object: 'model', created, owned_by: 'openai' }
      ],
      warning: 'Upstream model list unavailable; returned fallback list.'
    });
  }
}
