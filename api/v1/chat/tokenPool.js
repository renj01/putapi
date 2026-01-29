// CommonJS token pool (local to api/v1/chat) to avoid module resolution issues on Vercel.
// Env:
// - PUTER_TOKENS: comma/newline/space separated
// - PUTER_TOKEN: fallback single
// - PUTER_TOKEN_COOLDOWN_MS: default 15min
// - PUTER_TOKEN_MAX_ATTEMPTS: default 3

const DEFAULT_COOLDOWN_MS = 15 * 60 * 1000;

const state = { tokens: [], rrIndex: 0 };

function parseTokens() {
  const raw = process.env.PUTER_TOKENS || process.env.PUTER_TOKEN || '';
  const parts = raw.split(/[\n,\s]+/g).map(s => s.trim()).filter(Boolean);

  const seen = new Set();
  const uniq = [];
  for (const t of parts) {
    if (!seen.has(t)) { seen.add(t); uniq.push(t); }
  }
  return uniq;
}

function init() {
  const toks = parseTokens();
  if (!toks.length) return;

  const existing = state.tokens.map(x => x.token);
  if (existing.length === toks.length && existing.every((t, i) => t === toks[i])) return;

  state.tokens = toks.map(t => ({ token: t, disabledUntil: 0, failCount: 0 }));
  state.rrIndex = 0;
}

function hasAnyToken() {
  init();
  return state.tokens.length > 0;
}

function getToken() {
  init();
  if (!state.tokens.length) return null;

  const now = Date.now();
  for (let i = 0; i < state.tokens.length; i++) {
    const idx = (state.rrIndex + i) % state.tokens.length;
    const entry = state.tokens[idx];
    if (!entry.disabledUntil || entry.disabledUntil <= now) {
      state.rrIndex = (idx + 1) % state.tokens.length;
      return entry.token;
    }
  }

  // all disabled -> pick earliest re-enable
  let best = state.tokens[0];
  for (const e of state.tokens) if (e.disabledUntil < best.disabledUntil) best = e;
  return best.token;
}

function report(token, { ok, status }) {
  init();
  const entry = state.tokens.find(e => e.token === token);
  if (!entry) return;

  const now = Date.now();
  const cooldownBase = Number(process.env.PUTER_TOKEN_COOLDOWN_MS || DEFAULT_COOLDOWN_MS);

  if (ok) {
    entry.disabledUntil = 0;
    entry.failCount = 0;
    return;
  }

  entry.failCount = (entry.failCount || 0) + 1;

  if (status === 401 || status === 403) {
    entry.disabledUntil = now + Math.max(cooldownBase, 60 * 60 * 1000);
    return;
  }

  if (status === 429 || (status >= 500 && status <= 599) || status === 599) {
    const backoff = Math.min(5 * 60 * 1000, cooldownBase * Math.min(8, entry.failCount));
    entry.disabledUntil = now + backoff;
    return;
  }

  entry.disabledUntil = now + cooldownBase;
}

module.exports = { hasAnyToken, getToken, reportTokenResult: report };
