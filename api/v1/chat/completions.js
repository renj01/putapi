const PUTER_URL = 'https://api.puter.com/drivers/v1/call';

function unauthorized(res) {
  return res.status(401).json({ error: 'Invalid Proxy API Key' });
}

function sseHeaders(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
}

function writeSSE(res, obj) {
  // OpenAI style SSE: each message is `data: <json>\n\n`
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

export default async function handler(req, res) {
  // 1) CORS + Method gating
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // 2) Security Check (Client -> Proxy)
  const incomingKey = req.headers['authorization']?.replace('Bearer ', '');
  if (process.env.PROXY_API_KEY && incomingKey !== process.env.PROXY_API_KEY) {
    return unauthorized(res);
  }

  // 3) Ensure upstream token exists
  const puterToken = process.env.PUTER_TOKEN;
  if (!puterToken) {
    return res.status(500).json({ error: 'Server misconfiguration: Missing PUTER_TOKEN' });
  }

  const {
    messages,
    model,
    stream,
    temperature,
    max_tokens,
    tools
  } = req.body || {};

  const selectedModel = model || 'gpt-5-nano';
  const wantStream = !!stream;

  // OpenAI-compatible request validation (minimal)
  if (!Array.isArray(messages)) {
    return res.status(400).json({ error: 'Invalid request: messages must be an array' });
  }

  // Map OpenAI-ish payload -> puter.ai.chat args
  const puterArgs = [
    messages,
    {
      model: selectedModel,
      stream: wantStream,
      temperature,
      max_tokens,
      tools
    }
  ];

  // Client disconnect handling
  let clientGone = false;
  req.on('close', () => {
    clientGone = true;
  });

  try {
    const upstream = await fetch(PUTER_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${puterToken}`,
        'Content-Type': 'application/json',
        'Origin': 'https://puter.com'
      },
      body: JSON.stringify({
        interface: 'puter.ai',
        method: 'chat',
        args: puterArgs
      })
    });

    if (!upstream.ok) {
      const txt = await upstream.text();
      return res.status(502).json({
        error: {
          message: `Puter API Error: ${upstream.status} - ${txt}`,
          type: 'upstream_error'
        }
      });
    }

    // 4) Streaming (OpenAI-SSE compatible)
    if (wantStream) {
      sseHeaders(res);

      const created = Math.floor(Date.now() / 1000);
      const idBase = 'chatcmpl-' + Date.now();

      // Send an initial chunk (many clients expect at least one delta event quickly)
      writeSSE(res, {
        id: idBase,
        object: 'chat.completion.chunk',
        created,
        model: selectedModel,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
      });

      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();

      // We assume Puter returns a byte stream of text (or JSON-ish lines).
      // We forward decoded text as incremental deltas. This matches OpenAI SSE expectations:
      // - each "data: {...}\n\n" contains a chat.completion.chunk
      // - final message is "data: [DONE]\n\n"
      while (!clientGone) {
        const { done, value } = await reader.read();
        if (done) break;

        const text = decoder.decode(value, { stream: true });
        if (!text) continue;

        writeSSE(res, {
          id: idBase,
          object: 'chat.completion.chunk',
          created,
          model: selectedModel,
          choices: [{ index: 0, delta: { content: text }, finish_reason: null }]
        });
      }

      // Close out stream
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

    // 5) Non-stream response
    const data = await upstream.json();

    const content =
      typeof data === 'string'
        ? data
        : (data?.message?.content ?? data?.content ?? '');

    const tool_calls =
      (typeof data === 'object' && data?.message?.tool_calls) ? data.message.tool_calls : null;

    return res.status(200).json({
      id: 'chatcmpl-' + Date.now(),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: selectedModel,
      choices: [{
        index: 0,
        message: {
          role: data?.message?.role || 'assistant',
          content,
          tool_calls
        },
        finish_reason: 'stop'
      }],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0
      }
    });

  } catch (error) {
    console.error('Proxy Error:', error);
    return res.status(500).json({
      error: {
        message: error?.message || 'Internal Proxy Error',
        type: 'server_error'
      }
    });
  }
}
