// Chat Completions (CommonJS) + PUTER_TOKENS rotation + Streaming (OpenAI SSE) + Heartbeats (DATA frames)
// Fix: some clients (e.g., Open WebUI) may not ignore SSE comment frames (": ...") and can crash.
// So we ONLY send valid OpenAI "data: {...}" frames for heartbeats/keepalive (no ":" comment frames).
//
// Env (optional): SSE_HEARTBEAT_MS (default 8000)

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

// --- UPDATED: Web Search Detection & Transformation ---

function hasSearchIntent(tools) {
  if (!Array.isArray(tools)) return false;
  return tools.some(t => {
    if (!t) return false;
    // 1. Puter native format
    if (String(t.type).toLowerCase() === 'web_search') return true;
    // 2. OpenAI function format (e.g. "web_search", "google_search", "browse")
    if (t.type === 'function' && t.function?.name) {
      const n = t.function.name.toLowerCase();
      return n.includes('search') || n.includes('browse');
    }
    return false;
  });
}

function sanitizeTools(tools, baseService) {
  if (!Array.isArray(tools)) return undefined;

  // If search intent is detected, force the tool format Puter expects.
  // This fixes the issue where standard clients send { type: 'function' ... }
  // but Puter expects { type: 'web_search' }.
  if (hasSearchIntent(tools)) {
    return [{ type: 'web_search' }];
  }

  // Otherwise, only pass tools if not explicitly restricted (legacy behavior)
  if (baseService !== 'openai') {
     // If you want to support tools for other providers, remove this check.
     // For now, keeping original logic for non-search tools.
     return tools; 
  }
  return tools;
}

// -----------------------------------------------------

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

function isRetryableStatus(status) {
  return status === 401 || status === 403 || status === 429 || (status >= 500 && status <= 599) || status === 599;
}

async function streamAsOpenAI({ upstreamResponse, res, selectedModel }) {
  sseHeaders(res);

  const created = Math.floor(Date.now() / 1000);
  const idBase = 'chatcmpl-' + Date.now();

  writeSSE(res, {
    id: idBase,
    object: 'chat.completion.chunk',
    created,
    model: selectedModel,
    choices: [{ index: 0, delta: { content: '' }, finish_reason: null }]
  });

  const hb = startHeartbeat(res, () => ({
    id: idBase,
    object: 'chat.completion.chunk',
    created,
    model: selectedModel,
    choices: [{ index: 0, delta: { content: '' }, finish_reason: null }]
  }));

  const reader = upstreamResponse.body?.getReader?.();
  const decoder = new TextDecoder();

  if (!reader) {
    clearInterval(hb);
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
            buf = ''; 
            break;
          }

          let text = null;
          try {
            const j = JSON.parse(payload);
            text =
              j?.choices?.[0]?.delta?.content ??
              j?.choices?.[0]?.message?.content ??
              j?.message?.content ??
              j?.content ??
              null;

            if (text == null && typeof j === 'string') text = j;
            if (text == null) text = payload;
          } catch {
            text = payload;
          }

          if (text) {
            writeSSE(res, {
              id: idBase,
              object: 'chat.completion.chunk',
              created,
              model: selectedModel,
              choices: [{ index: 0, delta: { content: String(text) }, finish_reason: null }]
            });
          }
        } else {
          writeSSE(res, {
            id: idBase,
            object: 'chat.completion.chunk',
            created,
            model: selectedModel,
            choices: [{ index: 0, delta: { content: line + '\n' }, finish_reason: null }]
          });
        }
      }

      if (buf.length > 2048 && !buf.includes('\n')) {
        writeSSE(res, {
          id: idBase,
          object: 'chat.completion.chunk',
          created,
          model: selectedModel,
          choices: [{ index: 0, delta: { content: buf }, finish_reason: null }]
        });
        buf = '';
      }
    }

    if (buf) {
      writeSSE(res, {
        id: idBase,
        object: 'chat.completion.chunk',
        created,
        model: selectedModel,
        choices: [{ index: 0, delta: { content: buf }, finish_reason: null }]
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

  // --- UPDATED LOGIC HERE ---
  // Detect intent first
  const wantWebSearch = hasSearchIntent(tools);
  // Transform tools to Puter format if search, otherwise pass through (sanitized)
  const safeTools = sanitizeTools(tools, baseService);

  const allowTemp = baseService !== 'openai' || process.env.PUTER_OPENAI_ALLOW_TEMPERATURE === 'true';

  const accept = String(req.headers['accept'] || '').toLowerCase();
  const wantStream = body.stream === true && accept.includes('text/event-stream');

  const primaryArgs = { messages, model: selectedModel, stream: wantStream, max_tokens };
  if (safeTools) primaryArgs.tools = safeTools;
  if (allowTemp && typeof temperature === 'number') primaryArgs.temperature = temperature;

  const primaryBody = { interface: 'puter-chat-completion', service, method: 'complete', args: primaryArgs };

  const legacyOpts = {
    model: selectedModel,
    stream: wantStream,
    ...(typeof max_tokens === 'number' ? { max_tokens } : {}),
    ...(safeTools ? { tools: safeTools } : {}),
    ...(allowTemp && typeof temperature === 'number' ? { temperature } : {}),
  };
  const legacyBody = { interface: 'puter.ai', method: 'chat', args: [messages, legacyOpts] };

  const maxAttempts = Math.max(1, Number(process.env.PUTER_TOKEN_MAX_ATTEMPTS || 3));
  let lastMsg = null;
  let lastStatus = 502;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const token = getToken();
    if (!token) break;

    try {
      if (wantWebSearch) {
        // Legacy body (puter.ai) handles the web_search tool correctly
        const { response: r } = await fetchUpstream({ token, body: legacyBody });

        if (wantStream && r.ok && r.body) {
          reportTokenResult(token, { ok: true, status: 200 });
          return await streamAsOpenAI({ upstreamResponse: r, res, selectedModel });
        }

        const j = await readJsonSafe(r);
        if (j && typeof j === 'object' && j.success === false) {
          const msg = j?.error?.message || JSON.stringify(j.error || j);
          lastMsg = msg; lastStatus = 502;
          reportTokenResult(token, { ok: false, status: 502 });
          continue;
        }
        if (!r.ok) {
          const msg = (j ? JSON.stringify(j) : await readTextSafe(r));
          lastMsg = msg; lastStatus = r.status;
          reportTokenResult(token, { ok: false, status: r.status });
          if (isRetryableStatus(r.status)) continue;
          return res.status(r.status).json({ error: { message: msg, type: 'upstream_error' } });
        }

        const result = j?.result ?? j ?? await readTextSafe(r);
        reportTokenResult(token, { ok: true, status: 200 });
        const content = normalizeContent(result?.message?.content ?? result?.content ?? result);

        return res.status(200).json({
          id: 'chatcmpl-' + Date.now(),
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: selectedModel,
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        });
      }

      // ... Standard flow (unchanged) ...
      const { response: r1 } = await fetchUpstream({ token, body: primaryBody });

      if (wantStream && r1.ok && r1.body) {
        reportTokenResult(token, { ok: true, status: 200 });
        return await streamAsOpenAI({ upstreamResponse: r1, res, selectedModel });
      }

      const j1 = await readJsonSafe(r1);
      if (j1 && typeof j1 === 'object' && j1.success === false) {
        const msg = j1?.error?.message || JSON.stringify(j1.error || j1);
        lastMsg = msg; lastStatus = 502;
        reportTokenResult(token, { ok: false, status: 502 });

        if (isNoImplError(msg)) {
          const { response: r2 } = await fetchUpstream({ token, body: legacyBody });

          if (wantStream && r2.ok && r2.body) {
            reportTokenResult(token, { ok: true, status: 200 });
            return await streamAsOpenAI({ upstreamResponse: r2, res, selectedModel });
          }

          const j2 = await readJsonSafe(r2);
          if (j2 && typeof j2 === 'object' && j2.success === false) {
            const msg2 = j2?.error?.message || JSON.stringify(j2.error || j2);
            lastMsg = msg2; lastStatus = 502;
            reportTokenResult(token, { ok: false, status: 502 });
            continue;
          }
          if (!r2.ok) {
            const msg2 = (j2 ? JSON.stringify(j2) : await readTextSafe(r2));
            lastMsg = msg2; lastStatus = r2.status;
            reportTokenResult(token, { ok: false, status: r2.status });
            if (isRetryableStatus(r2.status)) continue;
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
        }

        continue;
      }

      if (!r1.ok) {
        const msg = (j1 ? JSON.stringify(j1) : await readTextSafe(r1));
        lastMsg = msg; lastStatus = r1.status;
        reportTokenResult(token, { ok: false, status: r1.status });
        if (isRetryableStatus(r1.status)) continue;
        return res.status(r1.status).json({ error: { message: msg, type: 'upstream_error' } });
      }

      const result1 = j1?.result ?? j1 ?? await readTextSafe(r1);
      reportTokenResult(token, { ok: true, status: 200 });
      const content1 = normalizeContent(result1?.message?.content ?? result1?.content ?? result1);

      return res.status(200).json({
        id: 'chatcmpl-' + Date.now(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: selectedModel,
        choices: [{ index: 0, message: { role: 'assistant', content: content1 }, finish_reason: 'stop' }],
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
