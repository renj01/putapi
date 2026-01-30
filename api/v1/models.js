let cache = new Map(); // key -> {ts, data}
const CACHE_MS = 10 * 60 * 1000; // 10 minutes

const PUTER_MODELS_URL = 'https://puter.com/puterai/chat/models/details';

// --- HTML Renderer for Browser Views ---
function renderHtml(models) {
  // 1. Group by provider
  const groups = {};
  for (const m of models) {
    const p = m.owned_by || 'other';
    if (!groups[p]) groups[p] = [];
    groups[p].push(m.id);
  }
  
  // Sort providers alphabetically, but maybe put 'puter' or 'openai' first if you want
  const sortedProviders = Object.keys(groups).sort();

  // 2. Build HTML
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Puter Proxy Models</title>
  <style>
    :root { --bg: #0f1115; --card-bg: #1a1d23; --text: #e0e6ed; --accent: #3b82f6; --border: #2d333f; }
    body { font-family: system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--text); margin: 0; padding: 2rem; }
    .container { max-width: 1000px; margin: 0 auto; }
    h1 { text-align: center; margin-bottom: 2rem; font-weight: 300; letter-spacing: 1px; }
    
    .provider-section { margin-bottom: 2.5rem; }
    .provider-title { 
      font-size: 0.85rem; text-transform: uppercase; letter-spacing: 1.5px; font-weight: 600; 
      color: #94a3b8; border-bottom: 1px solid var(--border); padding-bottom: 0.5rem; margin-bottom: 1rem; 
      display: flex; align-items: center; gap: 0.5rem;
    }
    .badge { background: #334155; color: #fff; font-size: 0.7em; padding: 2px 6px; border-radius: 4px; }

    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 1rem; }
    
    .card { 
      background: var(--card-bg); border: 1px solid var(--border); border-radius: 8px; padding: 1rem; 
      display: flex; justify-content: space-between; align-items: center; gap: 1rem;
      transition: transform 0.1s, border-color 0.2s;
    }
    .card:hover { border-color: #4b5563; transform: translateY(-1px); }
    
    .model-name { font-family: 'SF Mono', Consolas, monospace; font-size: 0.9rem; color: #cbd5e1; word-break: break-all; }
    
    .copy-btn { 
      background: #272e3b; border: 1px solid var(--border); color: #94a3b8; cursor: pointer; 
      padding: 0.4rem 0.8rem; border-radius: 6px; font-size: 0.8rem; font-weight: 500;
      transition: all 0.2s; white-space: nowrap;
    }
    .copy-btn:hover { background: var(--accent); color: white; border-color: var(--accent); }
    .copy-btn.copied { background: #10b981; border-color: #10b981; color: white; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Available Models</h1>
    ${sortedProviders.map(provider => `
      <div class="provider-section">
        <div class="provider-title">
          ${provider} 
          <span class="badge">${groups[provider].length}</span>
        </div>
        <div class="grid">
          ${groups[provider].sort().map(id => `
            <div class="card">
              <span class="model-name" title="${id}">${id}</span>
              <button class="copy-btn" onclick="copy('${id}', this)">Copy</button>
            </div>
          `).join('')}
        </div>
      </div>
    `).join('')}
  </div>

  <script>
    async function copy(text, btn) {
      try {
        await navigator.clipboard.writeText(text);
        const originalText = btn.innerText;
        btn.innerText = 'Copied';
        btn.classList.add('copied');
        
        setTimeout(() => {
          btn.innerText = originalText;
          btn.classList.remove('copied');
        }, 1500);
      } catch (err) {
        console.error('Failed to copy', err);
        btn.innerText = 'Error';
      }
    }
  </script>
</body>
</html>
  `;
}
// ----------------------------------------

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

  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const provider = url.searchParams.get('provider'); // matches puter.ai.listModels(provider)
    const cacheKey = provider || '__all__';

    const now = Date.now();
    let openaiModels = null;

    const cached = cache.get(cacheKey);
    if (cached && (now - cached.ts) < CACHE_MS) {
      openaiModels = cached.data;
    } else {
      const upstreamUrl = provider
        ? `${PUTER_MODELS_URL}?provider=${encodeURIComponent(provider)}`
        : PUTER_MODELS_URL;

      const r = await fetch(upstreamUrl, {
        headers: {
          'Accept': 'application/json',
          'Origin': 'https://puter.com'
        }
      });

      const contentType = (r.headers.get('content-type') || '').toLowerCase();

      if (!r.ok) {
        const txt = await r.text();
        throw new Error(`Failed to fetch models: ${r.status} - ${txt}`);
      }

      let raw;
      if (contentType.includes('application/json')) {
        raw = await r.json();
      } else {
        const txt = await r.text();
        try { raw = JSON.parse(txt); } 
        catch { throw new Error(`Models endpoint returned non-JSON content-type: ${contentType || 'unknown'}`); }
      }

      const arr = toArray(raw);
      if (!arr) {
        const hint = typeof raw === 'object' ? Object.keys(raw).slice(0, 20).join(',') : String(raw).slice(0, 200);
        throw new Error(`Models endpoint returned unexpected shape. Keys/preview: ${hint}`);
      }

      openaiModels = normalizeToOpenAI(arr);
      cache.set(cacheKey, { ts: now, data: openaiModels });
    }

    // --- CHECK FOR BROWSER REQUEST ---
    const accept = req.headers['accept'] || '';
    if (accept.includes('text/html')) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).send(renderHtml(openaiModels));
    }

    // --- STANDARD API RESPONSE ---
    return res.status(200).json({ object: 'list', data: openaiModels });

  } catch (error) {
    console.error('Models Error:', error);

    // Fallback minimal list so clients still work if upstream is down
    const created = Math.floor(Date.now() / 1000);
    const fallback = [
      { id: 'gpt-5-nano', object: 'model', created, owned_by: 'puter' },
      { id: 'openai/gpt-4o', object: 'model', created, owned_by: 'openai' }
    ];

    // Serve HTML error page if browser
    const accept = req.headers['accept'] || '';
    if (accept.includes('text/html')) {
      return res.status(500).send(`<h1>Error fetching models</h1><p>${error.message}</p>`);
    }

    return res.status(200).json({
      object: 'list',
      data: fallback,
      warning: 'Upstream model list unavailable; returned fallback list.'
    });
  }
}
