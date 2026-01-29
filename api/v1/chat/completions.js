// Chat Completions (CommonJS) + PUTER_TOKENS rotation
// Patch: handle "No implementation available for interface `puter-chat-completion`"
// - Retry next token on that error
// - Fallback to legacy interface/method: interface 'puter.ai', method 'chat' (still via /drivers/call)
//
// Also includes:
// - openai service mapping -> openai-completion (env override)
// - omit temperature for openai by default (env override)

const { hasAnyToken, getToken, reportTokenResult } = require('./tokenPool');

const DRIVER_PATH = '/drivers/call';
const HOSTS = ['https://api.puter.com', 'https://puter.com'];

function mapOpenAIService(service) {
  if (service !== 'openai') return service;
  return process.env.PUTER_OPENAI_SERVICE || 'openai-completion';
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
  try { return JSON.stringify(value); } catch { return String(value); }
}

function isNoImplError(msg) {
  return typeof msg === 'string' && msg.includes('No implementation available for interface `puter-chat-completion`');
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
  const { messages, model, temperature, max_tokens, tools } = body;
  if (!Array.isArray(messages)) return res.status(400).json({ error: 'messages must be an array' });

  const selectedModel = model || 'gpt-5-nano';
  const baseService = pickServiceFromModel(selectedModel);
  const service = mapOpenAIService(baseService);

  // Build args; omit temperature for openai unless forced
  const args = { messages, model: selectedModel, stream: false, max_tokens, tools };
  const allowTemp = baseService !== 'openai' || process.env.PUTER_OPENAI_ALLOW_TEMPERATURE === 'true';
  if (allowTemp && typeof temperature === 'number') args.temperature = temperature;

  // Primary driver payload
  const driverBody = {
    interface: 'puter-chat-completion',
    service,
    method: 'complete',
    args
  };

  // Legacy fallback payload (some Puter deployments expose only puter.ai/chat)
  const legacyBody = {
    interface: 'puter.ai',
    method: 'chat',
    args: [
      messages,
      {
        model: selectedModel,
        stream: false,
        ...(allowTemp && typeof temperature === 'number' ? { temperature } : {}),
        ...(typeof max_tokens === 'number' ? { max_tokens } : {}),
        ...(tools ? { tools } : {})
      }
    ]
  };

  const maxAttempts = Math.max(1, Number(process.env.PUTER_TOKEN_MAX_ATTEMPTS || 3));
  let lastMsg = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const token = getToken();
    if (!token) break;

    try {
      // 1) try primary
      let upstream = await callDriver({ token, body: driverBody });

      // Driver envelope error?
      if (upstream.json && typeof upstream.json === 'object' && upstream.json.success === false) {
        const msg = upstream.json?.error?.message || JSON.stringify(upstream.json.error || upstream.json);
        lastMsg = msg;

        // If it's the "no implementation" error, try legacy once for this token
        if (isNoImplError(msg)) {
          upstream = await callDriver({ token, body: legacyBody });

          if (upstream.json && typeof upstream.json === 'object' && upstream.json.success === false) {
            const msg2 = upstream.json?.error?.message || JSON.stringify(upstream.json.error || upstream.json);
            lastMsg = msg2;
            reportTokenResult(token, { ok: false, status: 502 });
            // retry next token
            continue;
          }
        } else {
          reportTokenResult(token, { ok: false, status: 502 });
          // retry next token
          continue;
        }
      }

      // HTTP error?
      if (!upstream.ok) {
        const msg = upstream.text || JSON.stringify(upstream.json || {});
        lastMsg = msg;
        reportTokenResult(token, { ok: false, status: upstream.status });
        if ([401,403,429].includes(upstream.status) || (upstream.status >= 500 && upstream.status <= 599)) continue;
        return res.status(upstream.status).json({ error: { message: msg, type: 'upstream_error' } });
      }

      reportTokenResult(token, { ok: true, status: 200 });

      const result = upstream.json?.result ?? upstream.json ?? upstream.text;
      const content = normalizeContent(result?.message?.content ?? result?.content ?? result);

      return res.status(200).json({
        id: 'chatcmpl-' + Date.now(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: selectedModel,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      });

    } catch (e) {
      lastMsg = String(e?.message || e);
      reportTokenResult(token, { ok: false, status: 599 });
      continue;
    }
  }

  return res.status(502).json({ error: { message: lastMsg || 'All tokens failed', type: 'upstream_error' } });
};
