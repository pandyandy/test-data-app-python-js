// Client for Keboola's AI Assistant ("Kai"), proxied through this server so
// the Storage API token/URL never reach the browser.
//
// This targets the `kai-assistant` backend specifically (not the newer
// `kai-agent`): kai-assistant's tool-approval flow is a request/response pair
// on the same chat stream (tool-approval-request / tool-approval-response),
// which is what src/routes/kai.js implements. kai-agent uses a different,
// separate approval endpoint - pointing discovery at it without also
// rewriting the approval flow would leave write-tool calls hanging forever.
//
// Flow: discover the kai-assistant service URL from the Storage API's own
// service list (GET /v2/storage), then forward chat requests to it with the
// auth headers attached, streaming the SSE response straight back to the
// caller.

const { Agent } = require('undici');
const logger = require('./logger');
const { getWorkspaceId } = require('./queryService');

// Node's built-in fetch (undici) defaults to killing a request after 300s
// without any bytes received - headers or body. A complex Kai answer can go
// quiet for longer than that while it's thinking or running a tool, which
// would otherwise abort *our* fetch to kai-assistant regardless of the
// downstream heartbeat we send the browser (that heartbeat only keeps the
// browser<->server leg alive). Use a long but finite timeout - long enough
// for any real answer, but bounded so a genuinely dead upstream connection
// still gets cleaned up (and logged) instead of hanging forever.
const UPSTREAM_TIMEOUT_MS = 15 * 60 * 1000;
const longTimeoutDispatcher = new Agent({
  headersTimeout: UPSTREAM_TIMEOUT_MS,
  bodyTimeout: UPSTREAM_TIMEOUT_MS,
});

const KBC_URL = process.env.KBC_URL || process.env.STORAGE_API_URL;
// Separate from queryService's KBC_TOKEN: discovering kai-assistant and
// calling it requires a master token, whereas KBC_TOKEN in this app's env is
// scoped narrower (Storage Access only) and can't be reused here.
const KAI_TOKEN = process.env.KAI_TOKEN;

let cachedKaiUrl = null;

function isConfigured() {
  return Boolean(KBC_URL && KAI_TOKEN);
}

function configStatus() {
  return {
    hasStorageUrl: Boolean(KBC_URL),
    hasToken: Boolean(KAI_TOKEN),
  };
}

async function discoverKaiUrl() {
  if (cachedKaiUrl) return cachedKaiUrl;

  const res = await fetch(`${KBC_URL.replace(/\/+$/, '')}/v2/storage`, {
    headers: { 'X-StorageAPI-Token': KAI_TOKEN },
  });
  if (!res.ok) {
    throw new Error(`Storage API discovery failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  const service = (data.services || []).find((s) => s.id === 'kai-assistant');
  if (!service || !service.url) {
    throw new Error('kai-assistant service not found for this project/region.');
  }

  cachedKaiUrl = service.url.replace(/\/+$/, '');
  logger.info('kai:discovered', { url: cachedKaiUrl });
  return cachedKaiUrl;
}

let requestCounter = 0;

// Short, log-friendly id for correlating every line that belongs to one
// proxyChat() call. Deliberately separate from the chat/message UUIDs
// (which are also logged) - this one is just easy to grep for.
function nextRequestId() {
  requestCounter += 1;
  return `k${requestCounter}`;
}

// Forwards `payload` to kai-assistant's /api/chat and pipes the SSE response
// straight through to `res`. Used both for new user messages and for
// tool-approval responses (see src/routes/kai.js) - both are just different
// message payloads against the same streaming endpoint.
//
// Every call gets its own reqId and a start/end log line, unlike
// discoverKaiUrl()'s 'kai:discovered' which only ever logs once per process
// (it's cached) - without this, any chat message after the first one in a
// server's lifetime produced zero log output until it either finished or
// errored, so a request that just hung was invisible.
async function proxyChat(payload, res) {
  const reqId = nextRequestId();
  const chatId = payload?.id;
  const partTypes = (payload?.message?.parts || []).map((p) => p?.type);

  if (!isConfigured()) {
    const status = configStatus();
    logger.error('kai:not-configured', { reqId, chatId, ...status });
    const err = new Error(
      'Kai is not configured for this app (missing KBC_URL / KAI_TOKEN). ' +
        'Set these as environment variables, then redeploy.'
    );
    err.code = 'KAI_NOT_CONFIGURED';
    err.status = 503;
    throw err;
  }

  const startedAt = Date.now();
  logger.info('kai:chat-request-start', { reqId, chatId, partTypes });

  let kaiUrl;
  try {
    kaiUrl = await discoverKaiUrl();
  } catch (err) {
    logger.error('kai:discovery-failed', { reqId, chatId, error: err.message, durationMs: Date.now() - startedAt });
    throw err;
  }
  const workspaceId = getWorkspaceId();

  logger.info('kai:discovery-ok', { reqId, chatId, hasWorkspaceId: Boolean(workspaceId), waitedMs: Date.now() - startedAt });

  let upstream;
  try {
    upstream = await fetch(`${kaiUrl}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-storageapi-token': KAI_TOKEN,
        'x-storageapi-url': KBC_URL,
        ...(workspaceId && { 'x-workspace-id': workspaceId }),
      },
      body: JSON.stringify(payload),
      dispatcher: longTimeoutDispatcher,
    });
  } catch (err) {
    // Thrown before we get any response at all - e.g. kai-assistant refused
    // the connection, DNS failed, or our own fetch's timeout tripped. `cause`
    // is where undici puts the actual socket/protocol-level error.
    logger.error('kai:upstream-fetch-failed', {
      reqId,
      chatId,
      error: err.message,
      cause: err.cause?.message,
      durationMs: Date.now() - startedAt,
    });
    throw err;
  }

  logger.info('kai:upstream-headers-received', {
    reqId,
    chatId,
    status: upstream.status,
    contentType: upstream.headers.get('content-type'),
    waitedMs: Date.now() - startedAt,
  });

  if (!upstream.ok) {
    const text = await upstream.text();
    logger.error('kai:upstream-error', { reqId, chatId, status: upstream.status, body: text });
    res.status(upstream.status).json({ error: text || `Kai returned ${upstream.status}` });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // Once the browser disconnects (tab closed, fetch aborted, an
  // intermediate proxy dropped it), stop doing pointless work: skip further
  // heartbeats/writes and cancel the upstream read early instead of reading
  // out a full response nobody's listening for. Logging exactly when/if this
  // fires (and how that compares to when the user actually saw an error) is
  // the main thing missing from earlier diagnostics.
  let clientClosed = false;
  res.on('close', () => {
    clientClosed = true;
    logger.info('kai:client-disconnected', { reqId, chatId, elapsedMs: Date.now() - startedAt });
  });
  res.on('error', (err) => {
    logger.warn('kai:response-error', { reqId, chatId, error: err.message, elapsedMs: Date.now() - startedAt });
  });

  // kai-assistant can go quiet for a while mid-response (thinking, or
  // running a tool), during which zero bytes flow. A proxy sitting between
  // the browser and here can treat that silence as a dead connection and
  // drop it - which reaches the user as a bare "network error" with no
  // useful detail. A periodic SSE comment line keeps bytes flowing so
  // nothing in the chain idle-times-out the connection; comment lines
  // (leading ":") are already ignored by the frontend's parser, which only
  // reads "data:" lines.
  let heartbeatCount = 0;
  const heartbeat = setInterval(() => {
    if (clientClosed) {
      clearInterval(heartbeat);
      return;
    }
    heartbeatCount += 1;
    res.write(': heartbeat\n\n');
  }, 15000);

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let bytesReceived = 0;
  let chunkCount = 0;
  try {
    while (true) {
      if (clientClosed) {
        await reader.cancel();
        logger.info('kai:chat-aborted', {
          reqId, chatId, durationMs: Date.now() - startedAt, heartbeatCount, chunkCount, bytesReceived,
        });
        return;
      }
      const { done, value } = await reader.read();
      if (done) break;
      chunkCount += 1;
      bytesReceived += value.byteLength;
      res.write(decoder.decode(value, { stream: true }));
    }
    logger.info('kai:chat-completed', {
      reqId, chatId, durationMs: Date.now() - startedAt, heartbeatCount, chunkCount, bytesReceived,
    });
  } catch (err) {
    logger.error('kai:stream-interrupted', {
      reqId, chatId, error: err.message, cause: err.cause?.message,
      durationMs: Date.now() - startedAt, heartbeatCount, chunkCount, bytesReceived,
    });
    throw err;
  } finally {
    clearInterval(heartbeat);
  }

  if (!clientClosed) res.end();
}

// GET /api/chat/{chatId} returns the chat's current state (messages so far)
// directly from kai-assistant - a plain request/response, not a stream, so
// it isn't subject to whatever cut the SSE connection short. kai-assistant
// keeps working on a request server-side independent of whether our
// downstream connection to the browser survives, so this lets the frontend
// recover an answer that finished after the browser already saw a dropped
// connection (see src/routes/kai.js and the "Check if it finished" action
// in static/kai.js).
async function fetchChat(chatId) {
  const reqId = nextRequestId();
  const startedAt = Date.now();

  if (!isConfigured()) {
    const err = new Error('Kai is not configured for this app (missing KBC_URL / KAI_TOKEN).');
    err.status = 503;
    throw err;
  }

  const kaiUrl = await discoverKaiUrl();
  const workspaceId = getWorkspaceId();

  logger.info('kai:fetch-chat-start', { reqId, chatId });

  const res = await fetch(`${kaiUrl}/api/chat/${encodeURIComponent(chatId)}`, {
    headers: {
      'x-storageapi-token': KAI_TOKEN,
      'x-storageapi-url': KBC_URL,
      ...(workspaceId && { 'x-workspace-id': workspaceId }),
    },
  });

  if (!res.ok) {
    const text = await res.text();
    logger.error('kai:fetch-chat-error', {
      reqId, chatId, status: res.status, body: text, durationMs: Date.now() - startedAt,
    });
    const err = new Error(text || `Kai returned ${res.status}`);
    err.status = res.status;
    throw err;
  }

  logger.info('kai:fetch-chat-completed', { reqId, chatId, durationMs: Date.now() - startedAt });
  return res.json();
}

module.exports = {
  isConfigured,
  configStatus,
  proxyChat,
  fetchChat,
};
