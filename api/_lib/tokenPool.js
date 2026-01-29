// Token pool with rotation + optional best-effort polling (Vercel-friendly)
const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_COOLDOWN_MS = 15 * 60 * 1000;

const state = { tokens: [], rrIndex: 0, pollingStarted: false };

function parseTokens() {
  const raw = process.env.PUTER_TOKENS || process.env.PUTER_TOKEN || '';
  const parts = raw.split(/[\n,\s]+/g).map(s => s.trim()).filter(Boolean);
  const seen = new Set();
  const uniq = [];
  for (const t of parts) { if (!seen.has(t)) { seen.add(t); uniq.push(t); } }
  return uniq;
}

export function initTokenPool() {
  const toks = parseTokens();
  if (!toks.length) return;
  const existing = state.tokens.map(x => x.token);
  if (existing.length === toks.length && existing.every((t, i) => t === toks[i])) return;

  state.tokens = toks.map(t => ({ token: t, disabledUntil: 0, lastError: null, failCount: 0, lastOkTs: 0 }));
  state.rrIndex = 0;
  maybeStartPolling();
}

export function hasAnyToken() { initTokenPool(); return state.tokens.length > 0; }

export function getToken() {
  initTokenPool();
  if (!state.tokens.length) return null;
  const now = Date.now();
  for (let i = 0; i < state.tokens.length; i++) {
    const idx = (state.rrIndex + i) % state.tokens.length;
    const t = state.tokens[idx];
    if (!t.disabledUntil || t.disabledUntil <= now) {
      state.rrIndex = (idx + 1) % state.tokens.length;
      return t.token;
    }
  }
  let best = state.tokens[0];
  for (const t of state.tokens) if (t.disabledUntil < best.disabledUntil) best = t;
  return best.token;
}

export function reportTokenResult(token, { ok, status, errorText }) {
  initTokenPool();
  const entry = state.tokens.find(t => t.token === token);
  if (!entry) return;
  const now = Date.now();
  const cooldownBase = Number(process.env.PUTER_TOKEN_COOLDOWN_MS || DEFAULT_COOLDOWN_MS);

  if (ok) {
    entry.disabledUntil = 0; entry.lastError = null; entry.failCount = 0; entry.lastOkTs = now; return;
  }

  entry.failCount = (entry.failCount || 0) + 1;
  entry.lastError = { status, errorText: (errorText || '').slice(0, 500), ts: now };

  if (status === 401 || status === 403) { entry.disabledUntil = now + Math.max(cooldownBase, 60 * 60 * 1000); return; }
  if (status === 429 || (status >= 500 && status <= 599) || status === 599) {
    const backoff = Math.min(5 * 60 * 1000, cooldownBase * Math.min(8, entry.failCount));
    entry.disabledUntil = now + backoff; return;
  }
  entry.disabledUntil = now + cooldownBase;
}

function maybeStartPolling() {
  const enabled = String(process.env.PUTER_TOKEN_POLLING || '').toLowerCase() === 'true';
  if (!enabled || state.pollingStarted || !state.tokens.length) return;
  state.pollingStarted = true;
  const intervalMs = Number(process.env.PUTER_TOKEN_POLL_INTERVAL_MS || DEFAULT_POLL_INTERVAL_MS);
  setInterval(() => { pollOnce().catch(() => {}); }, intervalMs).unref?.();
}

async function pollOnce() {
  const hosts = ['https://api.puter.com', 'https://puter.com'];
  const path = '/drivers/call';
  const testBody = {
    interface: 'puter-chat-completion',
    service: 'openai',
    method: 'complete',
    args: { model: 'gpt-5-nano', stream: false, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }
  };
  const now = Date.now();
  await Promise.all(state.tokens.map(async (entry) => {
    if (!entry) return;
    if (entry.disabledUntil > now) return;
    if (entry.lastOkTs && (now - entry.lastOkTs) < 10 * 60 * 1000) return;

    for (const host of hosts) {
      try {
        const r = await fetch(host + path, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${entry.token}`, 'Content-Type': 'application/json', 'Accept': 'application/json', 'Origin': 'https://puter.com' },
          body: JSON.stringify(testBody)
        });
        let errTxt = '';
        if (!r.ok) errTxt = await r.text();
        reportTokenResult(entry.token, { ok: r.ok, status: r.status, errorText: errTxt });
        break;
      } catch (e) {
        reportTokenResult(entry.token, { ok: false, status: 599, errorText: String(e?.message || e) });
      }
    }
  }));
}
