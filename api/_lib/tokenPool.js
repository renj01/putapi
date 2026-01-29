// Token pool with rotation + optional polling health-check (Vercel-friendly)
// Configure with env:
// - PUTER_TOKENS: comma/newline/space-separated list of tokens
// - PUTER_TOKEN: fallback single token
// - PUTER_TOKEN_POLLING: "true" to enable periodic health checks (default: false)
// - PUTER_TOKEN_POLL_INTERVAL_MS: interval (default: 300000 = 5 min)
// - PUTER_TOKEN_COOLDOWN_MS: cooldown after hard fail (default: 900000 = 15 min)
//
// Strategy:
// - Round-robin selection among "active" tokens
// - On upstream 401/403 => mark token as hard-failed (cooldown)
// - On 429/5xx => soft-fail (short cooldown) and retry next token
// - Optional polling uses a tiny chat completion (max_tokens=1) to re-enable tokens

const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_COOLDOWN_MS = 15 * 60 * 1000;

const state = {
  tokens: [], // [{ token, disabledUntil, lastError, failCount, lastOkTs }]
  rrIndex: 0,
  pollingStarted: false
};

function parseTokens() {
  const raw =
    process.env.PUTER_TOKENS ||
    process.env.PUTER_TOKEN ||
    '';

  const parts = raw
    .split(/[\n,\s]+/g)
    .map(s => s.trim())
    .filter(Boolean);

  // Deduplicate, keep order
  const seen = new Set();
  const uniq = [];
  for (const t of parts) {
    if (!seen.has(t)) {
      seen.add(t);
      uniq.push(t);
    }
  }
  return uniq;
}

export function initTokenPool() {
  const toks = parseTokens();
  if (!toks.length) return;

  // If tokens already initialized with same set, no-op
  const existing = state.tokens.map(x => x.token);
  if (existing.length === toks.length && existing.every((t, i) => t === toks[i])) return;

  state.tokens = toks.map(t => ({
    token: t,
    disabledUntil: 0,
    lastError: null,
    failCount: 0,
    lastOkTs: 0
  }));
  state.rrIndex = 0;

  maybeStartPolling();
}

export function hasAnyToken() {
  initTokenPool();
  return state.tokens.length > 0;
}

export function getToken() {
  initTokenPool();
  if (!state.tokens.length) return null;

  const now = Date.now();

  // Try up to N times to find an enabled token
  for (let i = 0; i < state.tokens.length; i++) {
    const idx = (state.rrIndex + i) % state.tokens.length;
    const t = state.tokens[idx];
    if (!t.disabledUntil || t.disabledUntil <= now) {
      state.rrIndex = (idx + 1) % state.tokens.length;
      return t.token;
    }
  }

  // All tokens disabled; pick the one with earliest re-enable time
  let best = state.tokens[0];
  for (const t of state.tokens) {
    if (t.disabledUntil < best.disabledUntil) best = t;
  }
  return best.token;
}

export function reportTokenResult(token, { ok, status, errorText }) {
  initTokenPool();
  const entry = state.tokens.find(t => t.token === token);
  if (!entry) return;

  const now = Date.now();
  const cooldownBase = Number(process.env.PUTER_TOKEN_COOLDOWN_MS || DEFAULT_COOLDOWN_MS);

  if (ok) {
    entry.disabledUntil = 0;
    entry.lastError = null;
    entry.failCount = 0;
    entry.lastOkTs = now;
    return;
  }

  entry.failCount = (entry.failCount || 0) + 1;
  entry.lastError = { status, errorText: (errorText || '').slice(0, 500), ts: now };

  // Hard fail: unauthorized/forbidden => longer cooldown
  if (status === 401 || status === 403) {
    entry.disabledUntil = now + Math.max(cooldownBase, 60 * 60 * 1000); // >= 1 hour
    return;
  }

  // Soft fail: rate limit or transient errors => shorter cooldown
  if (status === 429 || (status >= 500 && status <= 599)) {
    // Exponential-ish backoff capped at 5 minutes
    const backoff = Math.min(5 * 60 * 1000, cooldownBase * Math.min(8, entry.failCount));
    entry.disabledUntil = now + backoff;
    return;
  }

  // Other errors => default cooldown
  entry.disabledUntil = now + cooldownBase;
}

function maybeStartPolling() {
  const enabled = String(process.env.PUTER_TOKEN_POLLING || '').toLowerCase() === 'true';
  if (!enabled) return;
  if (state.pollingStarted) return;
  if (!state.tokens.length) return;

  state.pollingStarted = true;

  const intervalMs = Number(process.env.PUTER_TOKEN_POLL_INTERVAL_MS || DEFAULT_POLL_INTERVAL_MS);

  // Poll in the background within this serverless instance.
  // Note: Vercel instances may freeze between requests; this is best-effort.
  setInterval(() => {
    pollOnce().catch(() => {});
  }, intervalMs).unref?.();
}

async function pollOnce() {
  // Test each token with a tiny chat completion (max_tokens=1).
  // If Puter changes the interface/method, you can adjust here.
  const host = 'https://api.puter.com';
  const path = '/drivers/call';
  const url = host + path;

  const testBody = {
    interface: 'puter-chat-completion',
    service: 'openai',
    method: 'complete',
    args: {
      model: 'gpt-5-nano',
      stream: false,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }]
    }
  };

  const now = Date.now();
  await Promise.all(state.tokens.map(async (t) => {
    // Only poll tokens that are currently disabled or haven't been checked recently
    const entry = state.tokens.find(x => x.token === t.token);
    if (!entry) return;
    if (entry.disabledUntil > now || (entry.lastOkTs && (now - entry.lastOkTs) < 10 * 60 * 1000)) {
      // still disabled, or recently ok -> skip
      return;
    }

    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${t.token}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Origin': 'https://puter.com'
        },
        body: JSON.stringify(testBody)
      });

      let errTxt = '';
      if (!r.ok) errTxt = await r.text();

      reportTokenResult(t.token, { ok: r.ok, status: r.status, errorText: errTxt });
    } catch (e) {
      reportTokenResult(t.token, { ok: false, status: 599, errorText: String(e?.message || e) });
    }
  }));
}
