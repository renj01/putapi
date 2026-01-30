// Chat Completions (Node.js + Robust Fallback)
// Fixes 504 errors by aggressively falling back to Legacy API on ANY primary failure.

const { hasAnyToken, getToken, reportTokenResult } = require('./tokenPool');

const DRIVER_PATH = '/drivers/call';
const HOSTS = ['https://api.puter.com', 'https://puter.com'];
const HEARTBEAT_MS = Math.max(3000, Number(process.env.SSE_HEARTBEAT_MS || 8000));

function mapOpenAIService(service) {
  if (service !== 'openai') return service;
  return process.env.PUTER_OPENAI_SERVICE || 'openai-completion';
}

function pickServiceFromModel(modelId = '') {
  const m = (modelId || '').toLowerCase();
  if (m.includes('/')) return m.split('/')[0];
  if (m.startsWith('gpt')) return 'openai';
  if (m.startsWith('claude')) return 'claude';
  if (m.startsWith('gemini')) return 'gemini';
  if (m.startsWith('mistral')) return 'mistral';
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

function sseHeaders(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
}

function writeSSE(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

function startHeartbeat(res, makeChunk) {
  const t = setInterval(() => {
    try { writeSSE(res, makeChunk()); } catch {}
  }, HEARTBEAT_MS);
  t.unref?.();
  return t;
}

async function fetchUpstream({ token, body }) {
  let lastErr = null;
  for (const host of HOSTS) {
    try {
      const r = await fetch(host + DRIVER_PATH, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
          'Origin': 'https://puter.com',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        body: JSON.stringify(body),
      });
      return { response: r, host };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('All upstream hosts failed');
}

async function readJsonSafe(r) {
  const ct = (r.headers.get('content-type') || '').toLowerCase();
  if (!ct.includes('application/json')) return null;
  try { return await r.json(); } catch { return null; }
}

async function readTextSafe(r) {
  try { return await r.text(); } catch { return ''; }
}

async function streamAsOpenAI({ upstreamResponse, res, selectedModel }) {
  sseHeaders(res);
  const created = Math.floor(Date.now() / 1000);
  const idBase = 'chatcmpl-' + Date.now();

  writeSSE(res, {
    id: idBase, object: 'chat.completion.chunk', created, model: selectedModel,
    choices: [{ index: 0, delta: { content: '' }, finish_reason: null }]
  });

  const hb = startHeartbeat(res, () => ({
    id: idBase, object: 'chat.completion.chunk', created, model: selectedModel,
    choices: [{ index: 0, delta: { content: '' }, finish_reason: null }]
  }));

  const reader = upstreamResponse.body?.getReader?.(); // Node 18+ fetch
  const decoder = new TextDecoder();

  if (!reader) {
    clearInterval(hb);
    writeSSE(res, {
      id: idBase, object: 'chat.completion.chunk', created, model: selectedModel,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
    });
    res.write('data: [DONE]\n\n');
    return res.end();
  }

  let buf = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const rawLine = buf.slice(0, idx);
        buf = buf.slice(idx + 1);

        const line = rawLine.trimEnd();
        if (!line) continue;

        if (line.startsWith('data:')) {
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') {
            buf = ''; break;
          }
          let text = null;
          try {
            const j = JSON.parse(payload);
            text = j?.choices?.[0]?.delta?.content ?? j?.choices?.[0]?.message?.content ?? j?.message?.content ?? j?.content ?? null;
            if (text == null && typeof j === 'string') text = j;
            if (text == null) text = payload;
          } catch { text = payload; }

          if (text) {
            writeSSE(res, {
              id: idBase, object: 'chat.completion.chunk', created, model: selectedModel,
              choices: [{ index: 0, delta: { content: String(text) }, finish_reason: null }]
            });
          }
        } else {
          writeSSE(res, {
            id: idBase, object: 'chat.completion.chunk', created, model: selectedModel,
            choices: [{ index: 0, delta: { content: line + '\n' }, finish_reason: null }]
          });
        }
      }
      if (buf.length > 2048 && !buf.includes('\n')) {
        writeSSE(res, {
          id: idBase, object: 'chat.completion.chunk', created, model: selectedModel,
          choices: [{ index: 0, delta: { content: buf }, finish_reason: null }]
        });
        buf = '';
      }
    }
    if (buf) {
       writeSSE(res, {
          id: idBase, object: 'chat.completion.chunk', created, model: selectedModel,
          choices: [{ index: 0, delta: { content: buf }, finish_reason: null }]
       });
    }

    writeSSE(res, {
      id: idBase, object: 'chat.completion.chunk', created, model: selectedModel,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
    });
    res.write('data: [DONE]\n\n');
    res.end();
  } finally {
    clearInterval(hb);
  }
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

  const accept = String(req.headers['accept'] || '').toLowerCase();
  const wantStream = body.stream === true && accept.includes('text/event-stream');

  const primaryArgs = { messages, model: selectedModel, stream: wantStream, max_tokens };
  if (tools) primaryArgs.tools = tools;
  if (typeof temperature === 'number') primaryArgs.temperature = temperature;

  const primaryBody = { interface: 'puter-chat-completion', service, method: 'complete', args: primaryArgs };

  const legacyOpts = {
    model: selectedModel,
    stream: wantStream,
    ...(typeof max_tokens === 'number' ? { max_tokens } : {}),
    ...(tools ? { tools } : {}),
    ...(typeof temperature === 'number' ? { temperature } : {}),
  };
  const legacyBody = { interface: 'puter.ai', method: 'chat', args: [messages, legacyOpts] };

  const maxAttempts = Math.max(1, Number(process.env.PUTER_TOKEN_MAX_ATTEMPTS || 3));
  let lastMsg = null;
  let lastStatus = 502;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const token = getToken();
    if (!token) break;

    try {
      // 1. Try Primary Interface
      // We will try this first. If it returns ANY error (even 504), we assume it's broken/unsupported
      // and immediately fall back to Legacy for this request.
      
      const { response: r1 } = await fetchUpstream({ token, body: primaryBody });

      // If stream success, pipe it
      if (wantStream && r1.ok && r1.body) {
        reportTokenResult(token, { ok: true, status: 200 });
        return await streamAsOpenAI({ upstreamResponse: r1, res, selectedModel });
      }

      // Read response
      let j1 = null;
      let t1 = null;
      try { j1 = await r1.json(); } catch { t1 = await readTextSafe(r1); }

      // Success JSON
      if (r1.ok && (!j1 || j1.success !== false)) {
        reportTokenResult(token, { ok: true, status: 200 });
        const result1 = j1?.result ?? j1 ?? t1;
        const content1 = normalizeContent(result1?.message?.content ?? result1?.content ?? result1);
        return res.status(200).json({
          id: 'chatcmpl-' + Date.now(),
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: selectedModel,
          choices: [{ index: 0, message: { role: 'assistant', content: content1 }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        });
      }

      // --- AGGRESSIVE FALLBACK LOGIC ---
      // If we are here, Primary failed (either status!=200 or json.success==false)
      // We do NOT return error yet. We immediately try Legacy.
      
      const { response: r2 } = await fetchUpstream({ token, body: legacyBody });

      if (wantStream && r2.ok && r2.body) {
        reportTokenResult(token, { ok: true, status: 200 });
        return await streamAsOpenAI({ upstreamResponse: r2, res, selectedModel });
      }

      let j2 = await readJsonSafe(r2);
      if (j2 && typeof j2 === 'object' && j2.success === false) {
        const msg2 = j2?.error?.message || JSON.stringify(j2.error || j2);
        lastMsg = msg2; lastStatus = 502;
        reportTokenResult(token, { ok: false, status: 502 });
        continue; // Try next token
      }
      if (!r2.ok) {
        const msg2 = (j2 ? JSON.stringify(j2) : await readTextSafe(r2));
        lastMsg = msg2; lastStatus = r2.status;
        reportTokenResult(token, { ok: false, status: r2.status });
        // Retry common temporary errors
        if ([429, 502, 503, 504].includes(r2.status)) continue;
        return res.status(r2.status).json({ error: { message: msg2, type: 'upstream_error' } });
      }

      const result2 = j2?.result ?? j2 ?? await readTextSafe(r2);
      reportTokenResult(token, { ok: true, status: 200 });
      const content2 = normalizeContent(result2?.message?.content ?? result2?.content ?? result2);

      return res.status(200).json({
        id: 'chatcmpl-' + Date.now(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: selectedModel,
        choices: [{ index: 0, message: { role: 'assistant', content: content2 }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });

    } catch (e) {
      lastMsg = String(e?.message || e);
      lastStatus = 502;
      reportTokenResult(token, { ok: false, status: 599 });
      continue;
    }
  }

  return res.status(lastStatus).json({ error: { message: lastMsg || 'All tokens failed', type: 'upstream_error' } });
};
