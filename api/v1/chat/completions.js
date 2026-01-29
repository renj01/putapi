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

  const { messages, model, stream } = req.body || {};
  if (!Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages must be an array' });
  }

  const upstream = await fetch(PUTER_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.PUTER_TOKEN}`,
      'Content-Type': 'application/json',
      'Origin': 'https://puter.com'
    },
    body: JSON.stringify({
      interface: 'puter.ai',
      method: 'chat',
      args: [messages, { model: model || 'gpt-5-nano', stream: !!stream }]
    })
  });

  if (!upstream.ok) {
    const txt = await upstream.text();
    console.error('Upstream chat error:', upstream.status, txt);
    return res.status(upstream.status).json({ error: txt });
  }

  if (stream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      res.write(`data: ${JSON.stringify({
        id: 'chatcmpl-' + Date.now(),
        object: 'chat.completion.chunk',
        choices: [{ delta: { content: chunk } }]
      })}\n\n`);
    }
    res.write('data: [DONE]\n\n');
    return res.end();
  }

  const data = await upstream.json();
  return res.status(200).json({
    id: 'chatcmpl-' + Date.now(),
    object: 'chat.completion',
    choices: [{ message: { role: 'assistant', content: data?.message?.content ?? data } }]
  });
}
