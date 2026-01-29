// Patch: OpenAI models on Puter sometimes require a different service name.
// We map service "openai" -> "openai-completion" (configurable via env).
// Drivers API: POST /drivers/call  citeturn1view0

const DRIVER_PATH = '/drivers/call';
const HOSTS = ['https://api.puter.com', 'https://puter.com'];

function mapService(service) {
  const s = (service || '').toLowerCase();

  // Allow override
  const override = process.env.PUTER_OPENAI_SERVICE;
  if (override && s === 'openai') return override;

  // Default mapping: many Puter installs register OpenAI driver as "openai-completion"
  if (s === 'openai') return 'openai-completion';

  return service;
}

function pickServiceFromModel(modelId = '') {
  const m = (modelId || '').toLowerCase();
  if (m.includes('/')) return m.split('/')[0];

  if (m.startsWith('claude')) return 'claude';
  if (m.startsWith('gemini')) return 'gemini';
  if (m.startsWith('grok') || m.startsWith('xai')) return 'xai';
  if (m.startsWith('mistral')) return 'mistral';
  if (m.startsWith('deepseek')) return 'deepseek';
  if (m.startsWith('openrouter')) return 'openrouter';
  if (m.startsWith('qwen')) return 'qwen';
  if (m.startsWith('gpt')) return 'openai';

  return 'openai';
}

function normalizeContent(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((p) => {
      if (p == null) return '';
      if (typeof p === 'string') return p;
      if (typeof p === 'object') {
        if (typeof p.text === 'string') return p.text;
        if (typeof p.content === 'string') return p.content;
        if (typeof p.value === 'string') return p.value;
        try { return JSON.stringify(p); } catch { return String(p); }
      }
      return String(p);
    }).join('');
  }
  try { return JSON.stringify(value); } catch { return String(value); }
}

async function callDriver({ token, body }) {
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

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const incomingKey = req.headers['authorization']?.replace('Bearer ', '');
  if (process.env.PROXY_API_KEY && incomingKey !== process.env.PROXY_API_KEY) {
    return res.status(401).json({ error: 'Invalid Proxy API Key' });
  }

  const puterToken = process.env.PUTER_TOKEN;
  if (!puterToken) return res.status(500).json({ error: 'Server misconfiguration: Missing PUTER_TOKEN' });

  const body = req.body || {};
  const { messages, model, temperature, max_tokens, tools } = body;

  if (!Array.isArray(messages)) {
    return res.status(400).json({ error: 'Invalid request: messages must be an array' });
  }

  const selectedModel = model || 'gpt-5-nano';

  const picked = pickServiceFromModel(selectedModel);
  const service = mapService(picked);

  const driverBody = {
    interface: 'puter-chat-completion',
    service,
    method: 'complete',
    args: { messages, model: selectedModel, stream: false, temperature, max_tokens, tools }
  };

  const upstream = await callDriver({ token: puterToken, body: driverBody });

  // Driver envelope errors always come back 200 with success:false per docs citeturn1view0
  if (upstream.json && typeof upstream.json === 'object' && upstream.json.success === false) {
    const msg = upstream.json?.error?.message || JSON.stringify(upstream.json.error || upstream.json);
    console.error('Upstream chat driver error:', upstream.host, msg);
    return res.status(502).json({ error: { message: msg, type: 'upstream_error' } });
  }

  if (!upstream.ok) {
    const msg = upstream.text || JSON.stringify(upstream.json || {});
    console.error('Upstream HTTP error:', upstream.host, upstream.status, msg);
    return res.status(upstream.status).json({ error: { message: msg, type: 'upstream_error' } });
  }

  const result = upstream.json?.result ?? upstream.json ?? upstream.text;
  const content = normalizeContent(
    typeof result === 'string'
      ? result
      : (result?.message?.content ?? result?.content ?? result)
  );

  return res.status(200).json({
    id: 'chatcmpl-' + Date.now(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: selectedModel,
    choices: [{
      index: 0,
      message: { role: 'assistant', content },
      finish_reason: 'stop'
    }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  });
}
