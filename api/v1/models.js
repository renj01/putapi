let cache = new Map(); // key -> {ts, data}
const CACHE_MS = 10 * 60 * 1000; // 10 minutes

const PUTER_MODELS_URL = 'https://puter.com/puterai/chat/models/details';

function toArray(raw) {
  // The public endpoint shape can vary. Normalize to an array of model objects.
  if (Array.isArray(raw)) return raw;

  if (raw && typeof raw === 'object') {
    if (Array.isArray(raw.models)) return raw.models;
    if (Array.isArray(raw.data)) return raw.data;
    if (Array.isArray(raw.results)) return raw.results;

    // Sometimes providers are grouped in an object
    // e.g. { providers: { openai: [...], anthropic: [...] } }
    if (raw.providers && typeof raw.providers === 'object') {
      const all = [];
      for (const v of Object.values(raw.providers)) {
        if (Array.isArray(v)) all.push(...v);
        else if (v && typeof v === 'object') {
          if (Array.isArray(v.models)) all.push(...v.models);
          else if (Array.isArray(v.data)) all.push(...v.data);
        }
      }
      if (all.length) return all;
    }

    // Or the root object is provider -> models array
    // e.g. { openai: [...], anthropic: [...] }
    const all = [];
    for (const [k, v] of Object.entries(raw)) {
      if (Array.isArray(v)) all.push(...v);
      else if (v && typeof v === 'object') {
        if (Array.isArray(v.models)) all.push(...v.models);
        else if (Array.isArray(v.data)) all.push(...v.data);
      }
    }
    if (all.length) return all;
  }

  return null;
}

function normalizeToOpenAI(models) {
  const created = Math.floor(Date.now() / 1000);

  return models
    .filter(Boolean)
    .map((m) => {
      // Try common field names from various model registries
      const id =
        m.id ||
        m.model ||
        m.slug ||
        m.name ||
        m.model_id;

      const provider =
        m.provider ||
        m.owned_by ||
        (typeof id === 'string' && id.includes('/') ? id.split('/')[0] : null) ||
        'puter';

      return {
        id,
        object: 'model',
        created,
        owned_by: provider
      };
    })
    // drop invalid
    .filter((m) => typeof m.id === 'string' && m.id.length > 0);
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // Optional: protect this endpoint too
  // const incomingKey = req.headers['authorization']?.replace('Bearer ', '');
  // if (process.env.PROXY_API_KEY && incomingKey !== process.env.PROXY_API_KEY) {
  //   return res.status(401).json({ error: 'Invalid Proxy API Key' });
  // }

  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const provider = url.searchParams.get('provider'); // matches puter.ai.listModels(provider)
    const cacheKey = provider || '__all__';

    const now = Date.now();
    const cached = cache.get(cacheKey);
    if (cached && (now - cached.ts) < CACHE_MS) {
      return res.status(200).json({ object: 'list', data: cached.data });
    }

    const upstreamUrl = provider
      ? `${PUTER_MODELS_URL}?provider=${encodeURIComponent(provider)}`
      : PUTER_MODELS_URL;

    const r = await fetch(upstreamUrl, {
      headers: {
        'Accept': 'application/json',
        'Origin': 'https://puter.com'
      }
    });

    // If we got HTML (cloudflare, WAF, etc.), this will fail in json() below
    const contentType = (r.headers.get('content-type') || '').toLowerCase();

    if (!r.ok) {
      const txt = await r.text();
      throw new Error(`Failed to fetch models: ${r.status} - ${txt}`);
    }

    let raw;
    if (contentType.includes('application/json')) {
      raw = await r.json();
    } else {
      // Best-effort: try parse as JSON anyway; otherwise error out
      const txt = await r.text();
      try {
        raw = JSON.parse(txt);
      } catch {
        throw new Error(`Models endpoint returned non-JSON content-type: ${contentType || 'unknown'}`);
      }
    }

    const arr = toArray(raw);
    if (!arr) {
      // Log a small hint to Vercel logs (won't leak huge payloads)
      const hint = typeof raw === 'object' ? Object.keys(raw).slice(0, 20).join(',') : String(raw).slice(0, 200);
      throw new Error(`Models endpoint returned unexpected shape. Keys/preview: ${hint}`);
    }

    const openaiModels = normalizeToOpenAI(arr);
    cache.set(cacheKey, { ts: now, data: openaiModels });

    return res.status(200).json({ object: 'list', data: openaiModels });
  } catch (error) {
    console.error('Models Error:', error);

    // Fallback minimal list so clients still work if upstream is down
    const created = Math.floor(Date.now() / 1000);
    return res.status(200).json({
      object: 'list',
      data: [
        { id: 'gpt-5-nano', object: 'model', created, owned_by: 'puter' },
        { id: 'openai/gpt-4o', object: 'model', created, owned_by: 'openai' }
      ],
      warning: 'Upstream model list unavailable; returned fallback list.'
    });
  }
}
