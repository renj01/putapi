// OpenAI-compatible Chat Completions -> Puter Drivers API
// Fix: prevent clients that expect JSON from receiving SSE accidentally.
//
// Key changes:
// - Only stream when req.body.stream === true (strict boolean)
// - Also require client Accept header includes text/event-stream for SSE
//
// Drivers API: POST /drivers/call
const DRIVER_PATH = '/drivers/call';
const HOSTS = ['https://api.puter.com', 'https://puter.com'];

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

function sseHeaders(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
}

function writeSSE(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

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

  const body = req.body || {};
  const { messages, model, temperature, max_tokens, tools } = body;

  if (!Array.isArray(messages)) {
    return res.status(400).json({ error: 'Invalid request: messages must be an array' });
  }

  const selectedModel = model || 'gpt-5-nano';

  // IMPORTANT: Only stream if stream is strictly boolean true AND client accepts SSE.
  const accept = (req.headers['accept'] || '').toLowerCase();
  const wantStream = (body.stream === true) && accept.includes('text/event-stream');

  const driverBody = {
    interface: 'puter-chat-completion',
    service: pickServiceFromModel(selectedModel),
    method: 'complete',
    args: {
      messages,
      model: selectedModel,
      stream: wantStream,
      temperature,
      max_tokens,
      tools
    }
  };

  try {
    const upstream = await callDriver({ puterToken, body: driverBody });

    if (upstream.json && typeof upstream.json === 'object' && upstream.json.success === false) {
      const msg = upstream.json?.error?.message || JSON.stringify(upstream.json.error || upstream.json);
      console.error('Upstream chat driver error:', upstream.host, msg);
      return res.status(502).json({ error: { message: msg, type: 'upstream_error' } });
    }

    // STREAMING (OpenAI SSE)
    if (wantStream) {
      sseHeaders(res);

      const created = Math.floor(Date.now() / 1000);
      const idBase = 'chatcmpl-' + Date.now();

      writeSSE(res, {
        id: idBase,
        object: 'chat.completion.chunk',
        created,
        model: selectedModel,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
      });

      // If upstream is not actually streaming bytes, we still emit a single content chunk.
      const result = upstream.json?.result ?? upstream.json ?? upstream.text;
      const content =
        typeof result === 'string'
          ? result
          : (result?.message?.content ?? result?.content ?? '');

      if (content) {
        writeSSE(res, {
          id: idBase,
          object: 'chat.completion.chunk',
          created,
          model: selectedModel,
          choices: [{ index: 0, delta: { content }, finish_reason: null }]
        });
      }

      writeSSE(res, {
        id: idBase,
        object: 'chat.completion.chunk',
        created,
        model: selectedModel,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
      });

      res.write('data: [DONE]\n\n');
      return res.end();
    }

    // NON-STREAM (JSON) — always return valid JSON (no "data:" lines)
    const result = upstream.json?.result ?? upstream.json ?? upstream.text;
    const content =
      typeof result === 'string'
        ? result
        : (result?.message?.content ?? result?.content ?? '');

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
  } catch (e) {
    console.error('Proxy Error:', e);
    return res.status(500).json({ error: { message: e?.message || 'Internal Proxy Error', type: 'server_error' } });
  }
}
