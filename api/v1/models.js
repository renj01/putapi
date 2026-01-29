export default function handler(req, res) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // Optional: protect this endpoint too (uncomment if desired)
  // const incomingKey = req.headers['authorization']?.replace('Bearer ', '');
  // if (process.env.PROXY_API_KEY && incomingKey !== process.env.PROXY_API_KEY) {
  //   return res.status(401).json({ error: 'Invalid Proxy API Key' });
  // }

  const created = Math.floor(Date.now() / 1000);

  res.status(200).json({
    object: "list",
    data: [
      { id: "gpt-5-nano", object: "model", created, owned_by: "puter" },
      { id: "gpt-5.2-chat", object: "model", created, owned_by: "openai" },
      { id: "gemini-2.5-flash-lite", object: "model", created, owned_by: "google" },
      { id: "claude-sonnet-4", object: "model", created, owned_by: "anthropic" },
      { id: "gpt-4o", object: "model", created, owned_by: "openai" }
    ]
  });
}
