const PUTER_URL = 'https://puter.com/drivers/v1/call';
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const incomingKey = req.headers['authorization']?.replace('Bearer ', '');
  if (process.env.PROXY_API_KEY && incomingKey !== process.env.PROXY_API_KEY) {
    return res.status(401).json({ error: 'Invalid Proxy API Key' });
  }

  if (!process.env.PUTER_TOKEN) {
    return res.status(500).json({ error: 'Missing PUTER_TOKEN' });
  }

  const { input, model } = req.body || {};

  const upstream = await fetch(PUTER_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.PUTER_TOKEN}`,
      'Content-Type': 'application/json',
      'Origin': 'https://puter.com'
    },
    body: JSON.stringify({
      interface: 'puter.ai',
      method: 'embeddings',
      args: [input, { model: model || 'text-embedding-3-small' }]
    })
  });

  if (!upstream.ok) {
    const txt = await upstream.text();
    console.error('Upstream embeddings error:', upstream.status, txt);
    return res.status(upstream.status).json({ error: txt });
  }

  const data = await upstream.json();
  return res.status(200).json({
    object: 'list',
    data: Array.isArray(data) ? [{ object: 'embedding', embedding: data }] : data.data
  });
}
