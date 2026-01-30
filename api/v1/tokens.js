// Check balances of all PUTER_TOKENS
// GET /v1/tokens

const HOST = 'https://api.puter.com';

// Reuse the parsing logic to find all tokens in the pool
function parseTokens() {
  const raw = process.env.PUTER_TOKENS || process.env.PUTER_TOKEN || '';
  return raw.split(/[\n,\s]+/g).map(s => s.trim()).filter(Boolean);
}

export default async function handler(req, res) {
  // Security: Require the Proxy Key if one is set
  const incomingKey = req.headers['authorization']?.replace('Bearer ', '');
  if (process.env.PROXY_API_KEY && incomingKey !== process.env.PROXY_API_KEY) {
    // If accessing via browser, query param ?key=... is also accepted for convenience
    const queryKey = new URL(req.url, `http://${req.headers.host}`).searchParams.get('key');
    if (!queryKey || queryKey !== process.env.PROXY_API_KEY) {
       return res.status(401).json({ error: 'Invalid Proxy API Key' });
    }
  }

  const tokens = parseTokens();
  if (!tokens.length) {
    return res.status(500).json({ error: 'No PUTER_TOKENS configured in environment variables.' });
  }

  const results = [];

  // Check each token in parallel (or sequential if preferred, parallel is faster)
  await Promise.all(tokens.map(async (token) => {
    // Mask token for display (e.g. "abc12...890")
    const masked = token.length > 10 
      ? token.slice(0, 6) + '...' + token.slice(-4) 
      : '****';
    
    const start = Date.now();
    try {
      const r = await fetch(`${HOST}/drivers/call`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json; charset=utf-8',
          'Origin': 'https://puter.com',
        },
        body: JSON.stringify({
          interface: 'puter.auth',
          method: 'getMonthlyUsage',
          args: []
        })
      });
      
      const latency = Date.now() - start;

      if (!r.ok) {
        results.push({ 
          token: masked, 
          status: 'error', 
          code: r.status, 
          latency 
        });
        return;
      }

      const body = await r.json();
      const data = body.result; // Puter returns result in .result property

      if (data && data.allowanceInfo) {
        // Values are in microcents (1/100,000,000 of a dollar)
        const allowance = data.allowanceInfo.monthUsageAllowance || 0;
        const remaining = data.allowanceInfo.remaining || 0;
        const used = allowance - remaining;
        
        // Formatter: $1.00 = 100,000,000 microcents
        const fmt = (n) => '$' + (n / 100000000).toFixed(2);

        results.push({
          token: masked,
          status: 'active',
          latency,
          balance: {
            allowance_formatted: fmt(allowance),
            remaining_formatted: fmt(remaining),
            used_formatted: fmt(used),
            remaining_microcents: remaining,
            allowance_microcents: allowance
          }
        });
      } else {
        results.push({ token: masked, status: 'unknown', message: 'Invalid response shape', latency });
      }

    } catch (err) {
      results.push({ token: masked, status: 'error', message: err.message, latency: Date.now() - start });
    }
  }));

  // Sort results by status then remaining balance (ascending)
  results.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'active' ? -1 : 1;
    return (a.balance?.remaining_microcents || 0) - (b.balance?.remaining_microcents || 0);
  });

  // HTML View for Browsers (matching your models.js theme)
  const accept = req.headers['accept'] || '';
  if (accept.includes('text/html')) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(renderHtml(results));
  }

  // JSON Response for API
  return res.status(200).json({ 
    object: 'list', 
    count: results.length, 
    data: results 
  });
}

function renderHtml(results) {
  const totalRemaining = results.reduce((acc, r) => acc + (r.balance?.remaining_microcents || 0), 0);
  const totalFmt = '$' + (totalRemaining / 100000000).toFixed(2);

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Token Pool Status</title>
  <style>
    :root { 
      --bg: #ffffff; --text: #1a1a1a; --border: #e0e0e0; 
      --accent: #444; --hover-bg: #f7f7f7;
      --good: #059669; --bad: #dc2626; --warn: #d97706;
    }
    body { 
      font-family: 'Courier New', Courier, monospace; 
      background: var(--bg); color: var(--text); 
      margin: 0; padding: 3rem 1.5rem; 
    }
    .container { max-width: 900px; margin: 0 auto; }
    
    h1 { 
      font-weight: 700; text-transform: uppercase; letter-spacing: -1px; 
      font-size: 1.8rem; margin-bottom: 2rem; 
      border-bottom: 2px solid var(--text); padding-bottom: 0.5rem;
      display: flex; justify-content: space-between; align-items: center;
    }
    .total-badge {
      background: var(--text); color: var(--bg);
      font-size: 0.9rem; padding: 4px 10px; border-radius: 0;
    }

    table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
    th { text-align: left; text-transform: uppercase; font-size: 0.85rem; padding: 10px; border-bottom: 2px solid #000; }
    td { padding: 12px 10px; border-bottom: 1px solid var(--border); font-size: 0.9rem; }
    tr:last-child td { border-bottom: none; }
    tr:hover { background: var(--hover-bg); }

    .status-dot { height: 10px; width: 10px; border-radius: 50%; display: inline-block; margin-right: 8px; }
    .active { background-color: var(--good); }
    .error { background-color: var(--bad); }
    
    .mono { font-family: 'Courier New', monospace; letter-spacing: -0.5px; }
    .money { font-weight: 700; }
  </style>
</head>
<body>
  <div class="container">
    <h1>
      Token Pool
      <span class="total-badge">Total: ${totalFmt}</span>
    </h1>
    <table>
      <thead>
        <tr>
          <th>Status</th>
          <th>Token ID</th>
          <th>Latency</th>
          <th>Remaining</th>
          <th>Allowance</th>
        </tr>
      </thead>
      <tbody>
        ${results.map(r => `
          <tr>
            <td>
              <span class="status-dot ${r.status === 'active' ? 'active' : 'error'}"></span>
              ${r.status.toUpperCase()}
            </td>
            <td class="mono">${r.token}</td>
            <td>${r.latency}ms</td>
            <td class="money" style="color: ${r.status === 'active' ? 'var(--good)' : 'var(--bad)'}">
              ${r.balance?.remaining_formatted || '-'}
            </td>
            <td class="mono">${r.balance?.allowance_formatted || '-'}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  </div>
</body>
</html>
  `;
}
