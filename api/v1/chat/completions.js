// Chat Completions + token rotation
// FIX: correct import path (must reach api/_lib from api/v1/chat)
import { getToken, hasAnyToken, reportTokenResult } from '../../../_lib/tokenPool.js';

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

function normalizeContent(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(p => (p && (p.text || p.content)) || (typeof p === 'string' ? p : JSON.stringify(p))).join('');
  try { return JSON.stringify(value); } catch { return String(value); }
}

async function callDriverWithToken({ token, body }) {
  let lastErr = null;
  for (const host of HOSTS) {
    try {
      const r = await fetch(host + DRIVER_PATH, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Accept': 'application/json', 'Origin': 'https://puter.com' },
        body: JSON.stringify(body)
      });
      const ct = (r.headers.get('content-type') || '').toLowerCase();
      const json = ct.includes('application/json') ? await r.json() : null;
      const text = ct.includes('application/json') ? null : await r.text();
      return { ok: r.ok, status: r.status, json, text, host };
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('All upstream hosts failed');
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const incomingKey = req.headers['authorization']?.replace('Bearer ', '');
  if (process.env.PROXY_API_KEY && incomingKey !== process.env.PROXY_API_KEY) return res.status(401).json({ error: 'Invalid Proxy API Key' });

  if (!hasAnyToken()) return res.status(500).json({ error: 'Missing PUTER_TOKEN(S)' });

  const body = req.body || {};
  const { messages, model, temperature, max_tokens, tools } = body;
  if (!Array.isArray(messages)) return res.status(400).json({ error: 'messages must be an array' });

  const selectedModel = model || 'gpt-5-nano';
  const driverBody = { interface: 'puter-chat-completion', service: pickServiceFromModel(selectedModel), method: 'complete', args: { messages, model: selectedModel, stream: false, temperature, max_tokens, tools } };

  const maxAttempts = Math.max(1, Number(process.env.PUTER_TOKEN_MAX_ATTEMPTS || 3));
  let lastErr = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const token = getToken();
    if (!token) break;
    try {
      const upstream = await callDriverWithToken({ token, body: driverBody });

      if (upstream.json && typeof upstream.json === 'object' && upstream.json.success === false) {
        const msg = upstream.json?.error?.message || JSON.stringify(upstream.json.error || upstream.json);
        reportTokenResult(token, { ok: false, status: 502, errorText: msg });
        lastErr = { msg };
        continue;
      }

      if (!upstream.ok) {
        const msg = upstream.text || JSON.stringify(upstream.json || {});
        reportTokenResult(token, { ok: false, status: upstream.status, errorText: msg });
        lastErr = { msg };
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
      lastErr = { msg: String(e?.message || e) };
      reportTokenResult(token, { ok: false, status: 599, errorText: lastErr.msg });
      continue;
    }
  }

  return res.status(502).json({ error: { message: lastErr?.msg || 'All tokens failed', type: 'upstream_error' } });
}
