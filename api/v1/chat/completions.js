// Chat Completions (Edge Runtime)
// Bypasses timeouts and includes aggressive retries for upstream 504 errors.

import { hasAnyToken, getToken, reportTokenResult } from './tokenPool.js';

export const config = {
  runtime: 'edge',
  regions: ['iad1', 'cle1', 'sfo1', 'pdx1'], // Optional: US regions often have better connectivity
};

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

function isNoImplError(msg) {
  return typeof msg === 'string' && msg.includes('No implementation available');
}

// --- UPSTREAM FETCH HELPERS ---

async function fetchUpstream({ token, body }) {
  let lastErr = null;
  // Try hosts (redundancy)
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

function createStreamResponse(upstreamResponse, selectedModel) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const created = Math.floor(Date.now() / 1000);
  const idBase = 'chatcmpl-' + Date.now();

  const stream = new ReadableStream({
    async start(controller) {
      const enqueue = (data) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      
      // 1. Send initial chunk
      enqueue({
        id: idBase, object: 'chat.completion.chunk', created, model: selectedModel,
        choices: [{ index: 0, delta: { content: '' }, finish_reason: null }]
      });

      // 2. Setup Heartbeat
      const heartbeat = setInterval(() => {
        try {
          enqueue({
            id: idBase, object: 'chat.completion.chunk', created, model: selectedModel,
            choices: [{ index: 0, delta: { content: '' }, finish_reason: null }]
          });
        } catch (err) {
          clearInterval(heartbeat);
        }
      }, HEARTBEAT_MS);

      // 3. Process Upstream
      const reader = upstreamResponse.body.getReader();
      let buf = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          
          buf += decoder.decode(value, { stream: true });
          
          let idx;
          while ((idx = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, idx).trimEnd();
            buf = buf.slice(idx + 1);
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
                text = j?.choices?.[0]?.delta?.content 
                    ?? j?.choices?.[0]?.message?.content 
                    ?? j?.message?.content 
                    ?? j?.content 
                    ?? null;
                if (text == null && typeof j === 'string') text = j;
                if (text == null) text = payload;
              } catch {
                text = payload;
              }

              if (text) {
                enqueue({
                  id: idBase, object: 'chat.completion.chunk', created, model: selectedModel,
                  choices: [{ index: 0, delta: { content: String(text) }, finish_reason: null }]
                });
              }
            } else {
              // Non-SSE line (raw text)
              enqueue({
                id: idBase, object: 'chat.completion.chunk', created, model: selectedModel,
                choices: [{ index: 0, delta: { content: line + '\n' }, finish_reason: null }]
              });
            }
          }
          
          if (buf.length > 2048 && !buf.includes('\n')) {
             enqueue({
                id: idBase, object: 'chat.completion.chunk', created, model: selectedModel,
                choices: [{ index: 0, delta: { content: buf }, finish_reason: null }]
             });
             buf = '';
          }
        }
        
        if (buf) {
             enqueue({
                id: idBase, object: 'chat.completion.chunk', created, model: selectedModel,
                choices: [{ index: 0, delta: { content: buf }, finish_reason: null }]
             });
        }

        enqueue({
          id: idBase, object: 'chat.completion.chunk', created, model: selectedModel,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
        });
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));

      } catch (err) {
        controller.error(err);
      } finally {
        clearInterval(heartbeat);
        controller.close();
      }
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    }
  });
}

// --- MAIN HANDLER (EDGE) ---

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200 });
  if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });

  const authHeader = req.headers.get('authorization') || '';
  const incomingKey = authHeader.replace('Bearer ', '');
  if (process.env.PROXY_API_KEY && incomingKey !== process.env.PROXY_API_KEY) {
    return new Response(JSON.stringify({ error: 'Invalid Proxy API Key' }), { status: 401 });
  }

  if (!hasAnyToken()) {
    return new Response(JSON.stringify({ error: 'Server misconfiguration: Missing PUTER_TOKEN(S)' }), { status: 500 });
  }

  let body;
  try { body = await req.json(); } catch { body = {}; }

  const { messages, model, temperature, max_tokens, tools } = body;
  if (!Array.isArray(messages)) return new Response(JSON.stringify({ error: 'messages must be an array' }), { status: 400 });

  const selectedModel = model || 'gpt-5-nano';
  const baseService = pickServiceFromModel(selectedModel);
  const service = mapOpenAIService(baseService);

  const accept = (req.headers.get('accept') || '').toLowerCase();
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

  // Aggressive retry limit for timeouts
  const maxAttempts = Math.max(2, Number(process.env.PUTER_TOKEN_MAX_ATTEMPTS || 5));
  
  let lastMsg = null;
  let lastStatus = 502;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const token = getToken();
    if (!token) break;

    try {
      // 1. Try Primary Interface
      const { response: r1 } = await fetchUpstream({ token, body: primaryBody });

      if (wantStream && r1.ok && r1.body) {
        reportTokenResult(token, { ok: true, status: 200 });
        return createStreamResponse(r1, selectedModel);
      }

      let j1 = null;
      let t1 = null;
      const ct1 = (r1.headers.get('content-type') || '').toLowerCase();
      
      if (ct1.includes('application/json')) {
        try { j1 = await r1.json(); } catch {}
      } else {
        try { t1 = await r1.text(); } catch {}
      }

      if (r1.ok && (!j1 || j1.success !== false)) {
        reportTokenResult(token, { ok: true, status: 200 });
        const result = j1?.result ?? j1 ?? t1;
        const content = normalizeContent(result?.message?.content ?? result?.content ?? result);
        
        return new Response(JSON.stringify({
          id: 'chatcmpl-' + Date.now(),
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: selectedModel,
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      // Handle Errors
      if (j1 && typeof j1 === 'object' && j1.success === false) {
        const msg = j1?.error?.message || JSON.stringify(j1.error || j1);
        if (isNoImplError(msg)) {
           // Fall through to Legacy
        } else {
          // If 504 Gateway Timeout from Puter, retry loop will handle it
          lastMsg = msg; lastStatus = 502;
          reportTokenResult(token, { ok: false, status: 502 });
          continue; 
        }
      } else if (!r1.ok) {
        const msg = j1 ? JSON.stringify(j1) : (t1 || '');
        lastMsg = msg; lastStatus = r1.status;
        reportTokenResult(token, { ok: false, status: r1.status });
        // Retry these statuses
        if ([401, 403, 408, 429, 502, 503, 504].includes(r1.status)) continue;
        return new Response(JSON.stringify({ error: { message: msg, type: 'upstream_error' } }), { status: r1.status });
      }

      // 2. Legacy Fallback
      const { response: r2 } = await fetchUpstream({ token, body: legacyBody });

      if (wantStream && r2.ok && r2.body) {
        reportTokenResult(token, { ok: true, status: 200 });
        return createStreamResponse(r2, selectedModel);
      }

      let j2 = null;
      let t2 = null;
      const ct2 = (r2.headers.get('content-type') || '').toLowerCase();
      if (ct2.includes('application/json')) {
        try { j2 = await r2.json(); } catch {}
      } else {
        try { t2 = await r2.text(); } catch {}
      }

      if (!r2.ok) {
        const msg = j2 ? JSON.stringify(j2) : (t2 || '');
        lastMsg = msg; lastStatus = r2.status;
        reportTokenResult(token, { ok: false, status: r2.status });
        if ([401, 403, 408, 429, 502, 503, 504].includes(r2.status)) continue;
        return new Response(JSON.stringify({ error: { message: msg, type: 'upstream_error' } }), { status: r2.status });
      }

      if (j2 && typeof j2 === 'object' && j2.success === false) {
        const msg = j2?.error?.message || JSON.stringify(j2.error || j2);
        lastMsg = msg; lastStatus = 502;
        reportTokenResult(token, { ok: false, status: 502 });
        continue;
      }

      reportTokenResult(token, { ok: true, status: 200 });
      const result2 = j2?.result ?? j2 ?? t2;
      const content2 = normalizeContent(result2?.message?.content ?? result2?.content ?? result2);

      return new Response(JSON.stringify({
          id: 'chatcmpl-' + Date.now(),
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: selectedModel,
          choices: [{ index: 0, message: { role: 'assistant', content: content2 }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });

    } catch (e) {
      lastMsg = String(e?.message || e);
      lastStatus = 502;
      reportTokenResult(token, { ok: false, status: 599 });
      continue;
    }
  }

  return new Response(JSON.stringify({ error: { message: lastMsg || 'All tokens failed', type: 'upstream_error' } }), { status: lastStatus });
}
