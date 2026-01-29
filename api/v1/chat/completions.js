// OpenAI-compatible Chat Completions -> Puter Drivers API
// Fixes the /gui/ 404 by using POST /drivers/call (per Puter driver docs)
//
// References:
// - Puter Drivers endpoint: POST /drivers/call citeturn1view0
// - LLM driver interface is `puter-chat-completion`, method `complete` citeturn1view0turn3search3

const DRIVER_PATH = '/drivers/call';
const HOSTS = ['https://api.puter.com', 'https://puter.com']; // try api first, then fallback

function pickServiceFromModel(modelId = '') {
  const m = (modelId || '').toLowerCase();

  // If caller uses provider/model format, prefer provider as service.
  if (m.includes('/')) return m.split('/')[0];

  if (m.startsWith('claude')) return 'claude';
  if (m.startsWith('gemini')) return 'gemini';
  if (m.startsWith('grok') || m.startsWith('xai')) return 'xai';
  if (m.startsWith('mistral')) return 'mistral';
  if (m.startsWith('deepseek')) return 'deepseek';
  if (m.startsWith('openrouter')) return 'openrouter';
  if (m.startsWith('qwen')) return 'qwen';

  // Most "gpt-*" models go through OpenAI
  if (m.startsWith('gpt')) return 'openai';

  // Safe default
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

      // Some Puter driver errors still return 200 with {success:false,...} citeturn1view0
      const ct = (r.headers.get('content-type') || '').toLowerCase();
      const text = ct.includes('application/json') ? null : await r.text();
      const json = ct.includes('application/json') ? await r.json() : null;

      return { ok: r.ok, status: r.status, ct, text, json, host };
    } catch (e) {
      lastErr = e;
    }
  }

  throw lastErr || new Error('All upstream hosts failed');
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Dummy key gate
  const incomingKey = req.headers['authorization']?.replace('Bearer ', '');
  if (process.env.PROXY_API_KEY && incomingKey !== process.env.PROXY_API_KEY) {
    return res.status(401).json({ error: 'Invalid Proxy API Key' });
  }

  const puterToken = process.env.PUTER_TOKEN;
  if (!puterToken) return res.status(500).json({ error: 'Server misconfiguration: Missing PUTER_TOKEN' });

  const body = req.body || {};
  const { messages, model, stream, temperature, max_tokens, tools } = body;

  if (!Array.isArray(messages)) {
    return res.status(400).json({ error: 'Invalid request: messages must be an array' });
  }

  const selectedModel = model || 'gpt-5-nano';
  const wantStream = !!stream;

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

  // Client disconnect handling (for SSE)
  let clientGone = false;
  req.on('close', () => { clientGone = true; });

  try {
    const upstream = await callDriver({ puterToken, body: driverBody });

    // Handle Puter driver JSON envelope (success true/false) citeturn1view0
    if (upstream.json && typeof upstream.json === 'object') {
      if (upstream.json.success === false) {
        const msg = upstream.json?.error?.message || JSON.stringify(upstream.json.error || upstream.json);
        console.error('Upstream chat driver error:', upstream.host, msg);
        // Keep 502 to signal "upstream rejected" but include details
        return res.status(502).json({ error: { message: msg, type: 'upstream_error' } });
      }
    }

    // STREAMING
    if (wantStream) {
      sseHeaders(res);
      const created = Math.floor(Date.now() / 1000);
      const idBase = 'chatcmpl-' + Date.now();

      // initial role chunk (OpenAI SSE expectation)
      writeSSE(res, {
        id: idBase,
        object: 'chat.completion.chunk',
        created,
        model: selectedModel,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
      });

      // Upstream driver stream format varies; common cases:
      // - raw text stream
      // - JSON envelope with non-JSON content-type
      if (upstream.text) {
        // If upstream returned non-stream text, emit once
        writeSSE(res, {
          id: idBase,
          object: 'chat.completion.chunk',
          created,
          model: selectedModel,
          choices: [{ index: 0, delta: { content: upstream.text }, finish_reason: null }]
        });
      } else if (upstream.json) {
        // If upstream returned JSON result, emit its content once
        const result = upstream.json.result ?? upstream.json;
        const content = result?.message?.content ?? result?.content ?? (typeof result === 'string' ? result : JSON.stringify(result));
        writeSSE(res, {
          id: idBase,
          object: 'chat.completion.chunk',
          created,
          model: selectedModel,
          choices: [{ index: 0, delta: { content }, finish_reason: null }]
        });
      } else {
        // Nothing to stream; proceed to DONE
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

    // NON-STREAM response mapping
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
