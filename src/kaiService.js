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
// browser<->server leg alive). Disable both timeouts for this one dispatcher
// so only kai-assistant's own connection lifetime governs how long we wait.
const noTimeoutDispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

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

// Forwards `payload` to kai-assistant's /api/chat and pipes the SSE response
// straight through to `res`. Used both for new user messages and for
// tool-approval responses (see src/routes/kai.js) - both are just different
// message payloads against the same streaming endpoint.
async function proxyChat(payload, res) {
  if (!isConfigured()) {
    const status = configStatus();
    logger.error('kai:not-configured', status);
    const err = new Error(
      'Kai is not configured for this app (missing KBC_URL / KAI_TOKEN). ' +
        'Set these as environment variables, then redeploy.'
    );
    err.code = 'KAI_NOT_CONFIGURED';
    err.status = 503;
    throw err;
  }

  const kaiUrl = await discoverKaiUrl();
  const workspaceId = getWorkspaceId();

  const upstream = await fetch(`${kaiUrl}/api/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-storageapi-token': KAI_TOKEN,
      'x-storageapi-url': KBC_URL,
      ...(workspaceId && { 'x-workspace-id': workspaceId }),
    },
    body: JSON.stringify(payload),
    dispatcher: noTimeoutDispatcher,
  });

  if (!upstream.ok) {
    const text = await upstream.text();
    logger.error('kai:upstream-error', { status: upstream.status, body: text });
    res.status(upstream.status).json({ error: text || `Kai returned ${upstream.status}` });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // kai-assistant can go quiet for a while mid-response (thinking, or
  // running a tool), during which zero bytes flow. A proxy sitting between
  // the browser and here can treat that silence as a dead connection and
  // drop it - which reaches the user as a bare "network error" with no
  // useful detail. A periodic SSE comment line keeps bytes flowing so
  // nothing in the chain idle-times-out the connection; comment lines
  // (leading ":") are already ignored by the frontend's parser, which only
  // reads "data:" lines.
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 15000);

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(decoder.decode(value, { stream: true }));
    }
  } catch (err) {
    logger.error('kai:stream-interrupted', { error: err.message });
    throw err;
  } finally {
    clearInterval(heartbeat);
  }
  res.end();
}

module.exports = {
  isConfigured,
  configStatus,
  proxyChat,
};
