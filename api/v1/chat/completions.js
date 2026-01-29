// Patch: Some Puter OpenAI delegates only accept default temperature=1.
// Fix: omit temperature unless explicitly supported.
//
// Drivers API: POST /drivers/call

const DRIVER_PATH = '/drivers/call';
const HOSTS = ['https://api.puter.com', 'https://puter.com'];

function mapService(service) {
  const override = process.env.PUTER_OPENAI_SERVICE;
  if (override && service === 'openai') return override;
  if (service === 'openai') return 'openai-completion';
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
    return value.map(p => {
      if (!p) return '';
      if (typeof p === 'string') return p;
      if (typeof p === 'object') return p.text || p.content || JSON.stringify(p);
      return String(p);
    }).join('');
  }
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
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
  const baseService = pickServiceFromModel(selectedModel);
  const service = mapService(baseService);

  // Build args carefully:
  // - OpenAI delegate may reject non-default temperature
  const args = {
    messages,
    model: selectedModel,
    max_tokens,
    tools
  };

  // Only pass temperature if NOT OpenAI, or explicitly forced
  const allowTemp =
    baseService !== 'openai' ||
    process.env.PUTER_OPENAI_ALLOW_TEMPERATURE === 'true';

  if (allowTemp && typeof temperature === 'number') {
    args.temperature = temperature;
  }

  const driverBody = {
    interface: 'puter-chat-completion',
    service,
    method: 'complete',
    args
  };

  const upstream = await callDriver({ token: puterToken, body: driverBody });

  if (upstream.json && typeof upstream.json === 'object' && upstream.json.success === false) {
    const msg = upstream.json?.error?.message || JSON.stringify(upstream.json.error || upstream.json);
    return res.status(502).json({ error: { message: msg, type: 'upstream_error' } });
  }

  if (!upstream.ok) {
    const msg = upstream.text || JSON.stringify(upstream.json || {});
    return res.status(upstream.status).json({ error: { message: msg, type: 'upstream_error' } });
  }

  const result = upstream.json?.result ?? upstream.json ?? upstream.text;
  const content = normalizeContent(result?.message?.content ?? result?.content ?? result);

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
