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
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

async function readUpstreamBodySafe(upstream) {
  // Avoid throwing on non-UTF8 / huge bodies; cap at ~64KB
  const txt = await upstream.text();
  return txt.length > 65536 ? (txt.slice(0, 65536) + '\n...[truncated]') : txt;
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

  const body = req.body || {};
  const { messages, model, stream, temperature, max_tokens, tools } = body;

  const selectedModel = model || 'gpt-5-nano';
  const wantStream = !!stream;

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
      const upstreamBody = await readUpstreamBodySafe(upstream);
      // Important: log this so Vercel logs show the real reason (401/403/429/etc.)
      console.error('Upstream chat error:', upstream.status, upstreamBody);

      // Pass through the upstream status code so you can see the real failure in the client
      return res.status(upstream.status).json({
        error: {
          message: upstreamBody || `Upstream error: ${upstream.status}`,
          type: 'upstream_error',
          upstream_status: upstream.status
        }
      });
    }

    // 4) Streaming (OpenAI-SSE compatible)
    if (wantStream) {
      sseHeaders(res);

      const created = Math.floor(Date.now() / 1000);
      const idBase = 'chatcmpl-' + Date.now();

      // initial role chunk
      writeSSE(res, {
        id: idBase,
        object: 'chat.completion.chunk',
        created,
        model: selectedModel,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
      });

      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();

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

      // final chunk + DONE
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
    const contentType = (upstream.headers.get('content-type') || '').toLowerCase();
    let data;

    if (contentType.includes('application/json')) {
      data = await upstream.json();
    } else {
      // If upstream returns text, do not crash; wrap it
      const txt = await upstream.text();
      data = { message: { role: 'assistant', content: txt } };
    }

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
