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
  
  const sortedProviders = Object.keys(groups).sort();

  // 2. Build HTML (Minimalist Light + Courier)
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Available Models</title>
  <style>
    :root { 
      --bg: #ffffff; 
      --text: #1a1a1a; 
      --border: #e0e0e0; 
      --accent: #444; 
      --hover-bg: #f7f7f7;
    }
    body { 
      font-family: 'Courier New', Courier, monospace; 
      background: var(--bg); 
      color: var(--text); 
      margin: 0; 
      padding: 3rem 1.5rem; 
      line-height: 1.5;
    }
    .container { max-width: 900px; margin: 0 auto; }
    
    h1 { 
      font-weight: 700; 
      text-transform: uppercase; 
      letter-spacing: -1px; 
      font-size: 1.8rem;
      margin-bottom: 3rem; 
      border-bottom: 2px solid var(--text);
      padding-bottom: 0.5rem;
      display: inline-block;
    }
    
    .provider-section { margin-bottom: 3.5rem; }
    
    .provider-title { 
      font-weight: 700; 
      text-transform: uppercase; 
      font-size: 1rem;
      margin-bottom: 1.5rem; 
      display: flex; 
      align-items: center; 
      gap: 0.8rem;
    }
    
    .badge { 
      background: var(--text); 
      color: var(--bg); 
      font-size: 0.8rem; 
      padding: 2px 6px; 
      border-radius: 0; /* Boxy look for courier style */
      font-weight: 400;
    }

    .grid { 
      display: grid; 
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); 
      gap: 1rem; 
    }
    
    .card { 
      border: 1px solid var(--border); 
      padding: 0.8rem; 
      display: flex; 
      justify-content: space-between; 
      align-items: center; 
      gap: 1rem;
      background: #fff;
      transition: all 0.2s ease;
    }
    
    .card:hover { 
      border-color: var(--text); 
      background: var(--hover-bg);
      transform: translateY(-2px);
      box-shadow: 2px 2px 0px rgba(0,0,0,0.1);
    }
    
    .model-name { 
      font-size: 0.85rem; 
      word-break: break-all;
    }
    
    .copy-btn { 
      background: transparent; 
      border: 1px solid var(--border); 
      color: #888; 
      cursor: pointer; 
      padding: 0.3rem 0.6rem; 
      font-family: inherit;
      font-size: 0.75rem; 
      text-transform: uppercase;
      transition: all 0.2s;
    }
    
    .card:hover .copy-btn { border-color: #aaa; color: #555; }
    
    .copy-btn:hover { 
      background: var(--text); 
      color: var(--bg) !important; 
      border-color: var(--text) !important;
    }
    
    .copy-btn.copied { 
      background: var(--text); 
      color: var(--bg); 
      border-color: var(--text);
    }
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
  if (Array.isArray(raw)) return raw;

  if (raw && typeof raw === 'object') {
    if (Array.isArray(raw.models)) return raw.models;
    if (Array.isArray(raw.data)) return raw.data;
    if (Array.isArray(raw.results)) return raw.results;

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
      const id = m.id || m.model || m.slug || m.name || m.model_id;
      const provider = m.provider || m.owned_by || 
        (typeof id === 'string' && id.includes('/') ? id.split('/')[0] : null) || 'puter';

      return {
        id,
        object: 'model',
        created,
        owned_by: provider
      };
    })
    .filter((m) => typeof m.id === 'string' && m.id.length > 0);
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const provider = url.searchParams.get('provider');
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

    const created = Math.floor(Date.now() / 1000);
    const fallback = [
      { id: 'gpt-5-nano', object: 'model', created, owned_by: 'puter' },
      { id: 'openai/gpt-4o', object: 'model', created, owned_by: 'openai' }
    ];

    const accept = req.headers['accept'] || '';
    if (accept.includes('text/html')) {
      return res.status(500).send(`
        <body style="font-family:'Courier New';padding:2rem;">
          <h1>ERROR</h1>
          <p>${error.message}</p>
        </body>
      `);
    }

    return res.status(200).json({
      object: 'list',
      data: fallback,
      warning: 'Upstream model list unavailable; returned fallback list.'
    });
  }
}
