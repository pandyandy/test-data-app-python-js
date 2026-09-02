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
// Architecture: the Keboola Data Apps platform proxy in front of this app
// (apps-proxy) enforces a hard 30s timeout on any plain HTTP request,
// regardless of how much data is flowing - streaming/heartbeats don't
// exempt it, only WebSockets get a long (6h) timeout there. Confirmed via
// platform traces: a real Kai answer involving several tool calls took just
// over 30s and got its connection cut mid-response even though kai-assistant
// itself completed the request successfully. So holding one HTTP request
// open from browser to server for the whole answer is not viable here.
//
// Instead: startChat() kicks off the request to kai-assistant in the
// background and returns a streamId immediately; the SSE response is parsed
// into discrete events and buffered in memory (readStreamEvents below serves
// them). The frontend polls for new events every ~1.2s instead of holding a
// connection open - every individual request, in both directions, finishes
// in well under a second, so the 30s cap never applies to anything.

const crypto = require('crypto');
const { Agent } = require('undici');
const logger = require('./logger');
const { getWorkspaceId } = require('./queryService');

// Bounds how long we'll wait on kai-assistant itself (now purely a
// server-side background operation, not tied to any browser connection) -
// generous, but finite so a genuinely dead upstream still gets cleaned up
// and logged instead of hanging forever.
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
// runChatStream() call. Deliberately separate from the chat/message/stream
// UUIDs (also logged) - this one is just easy to grep for.
function nextRequestId() {
  requestCounter += 1;
  return `k${requestCounter}`;
}

// streamId -> { events: [{seq,type,data}], done, error, createdAt, lastAccess }
const streamBuffers = new Map();
const STREAM_BUFFER_TTL_MS = 30 * 60 * 1000;

function createStreamBuffer() {
  const streamId = crypto.randomUUID();
  streamBuffers.set(streamId, {
    events: [],
    done: false,
    error: null,
    createdAt: Date.now(),
    lastAccess: Date.now(),
  });
  return streamId;
}

// Sweeps buffers nobody has polled in a while so a long-running server
// process doesn't accumulate them forever. unref()'d so it never keeps the
// process alive on its own.
setInterval(() => {
  const cutoff = Date.now() - STREAM_BUFFER_TTL_MS;
  for (const [id, buf] of streamBuffers) {
    if (buf.lastAccess < cutoff) streamBuffers.delete(id);
  }
}, 5 * 60 * 1000).unref();

// Splits one "\n\n"-delimited SSE part into its data-only lines. Kai's SSE
// format has no "event:" lines - the type is inside the JSON body.
function* parseSSEPart(part) {
  for (const line of part.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const raw = line.slice(5).trim();
    if (raw === '[DONE]') continue;
    try {
      const data = JSON.parse(raw);
      yield { type: data.type || 'unknown', data };
    } catch {
      // skip unparseable lines
    }
  }
}

// Does the actual work: discovers kai-assistant, forwards `payload`, reads
// its SSE response, and pushes parsed events into the buffer for `streamId`
// as they arrive. Runs detached from any browser connection (see
// startChat) - a request here can safely take minutes; nothing is waiting
// on this HTTP response.
async function runChatStream(streamId, payload) {
  const buf = streamBuffers.get(streamId);
  const reqId = nextRequestId();
  const chatId = payload?.id;
  const partTypes = (payload?.message?.parts || []).map((p) => p?.type);
  const startedAt = Date.now();

  logger.info('kai:chat-request-start', { reqId, chatId, streamId, partTypes });

  let kaiUrl;
  try {
    kaiUrl = await discoverKaiUrl();
  } catch (err) {
    logger.error('kai:discovery-failed', { reqId, chatId, streamId, error: err.message, durationMs: Date.now() - startedAt });
    buf.error = err.message;
    buf.done = true;
    return;
  }

  const workspaceId = getWorkspaceId();
  logger.info('kai:discovery-ok', { reqId, chatId, streamId, hasWorkspaceId: Boolean(workspaceId), waitedMs: Date.now() - startedAt });

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
      reqId, chatId, streamId, error: err.message, cause: err.cause?.message, durationMs: Date.now() - startedAt,
    });
    buf.error = err.message;
    buf.done = true;
    return;
  }

  logger.info('kai:upstream-headers-received', {
    reqId, chatId, streamId, status: upstream.status,
    contentType: upstream.headers.get('content-type'), waitedMs: Date.now() - startedAt,
  });

  if (!upstream.ok) {
    const text = await upstream.text();
    logger.error('kai:upstream-error', { reqId, chatId, streamId, status: upstream.status, body: text });
    buf.error = text || `Kai returned ${upstream.status}`;
    buf.done = true;
    return;
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = '';
  let chunkCount = 0;
  let eventCount = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunkCount += 1;
      sseBuffer += decoder.decode(value, { stream: true });

      const parts = sseBuffer.split('\n\n');
      sseBuffer = parts.pop();
      for (const part of parts) {
        if (!part.trim()) continue;
        for (const event of parseSSEPart(part)) {
          buf.events.push(event);
          eventCount += 1;
        }
      }
    }
    buf.done = true;
    logger.info('kai:chat-completed', {
      reqId, chatId, streamId, durationMs: Date.now() - startedAt, chunkCount, eventCount,
    });
  } catch (err) {
    buf.error = err.message;
    buf.done = true;
    logger.error('kai:stream-interrupted', {
      reqId, chatId, streamId, error: err.message, cause: err.cause?.message,
      durationMs: Date.now() - startedAt, chunkCount, eventCount,
    });
  }
}

// Starts a chat turn (new message or tool-approval response - both are just
// different payloads against the same kai-assistant endpoint) and returns a
// streamId to poll via readStreamEvents. Synchronous except for the
// isConfigured check, so callers get an immediate response either way.
function startChat(payload) {
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

  const streamId = createStreamBuffer();
  runChatStream(streamId, payload).catch((err) => {
    // runChatStream already catches and records its own errors on the
    // buffer - this only guards against a genuinely unexpected throw so it
    // can't become an unhandled promise rejection.
    logger.error('kai:stream-worker-crashed', { streamId, error: err.message });
    const buf = streamBuffers.get(streamId);
    if (buf) {
      buf.error = err.message;
      buf.done = true;
    }
  });

  return streamId;
}

// Returns events buffered since sequence `since`, plus done/error state.
function readStreamEvents(streamId, since) {
  const buf = streamBuffers.get(streamId);
  if (!buf) {
    const err = new Error('Unknown or expired chat stream.');
    err.status = 404;
    throw err;
  }
  buf.lastAccess = Date.now();

  return {
    events: buf.events.slice(since),
    nextSeq: buf.events.length,
    done: buf.done,
    error: buf.error,
  };
}

// GET /api/chat/{chatId} returns the chat's current state (messages so far)
// directly from kai-assistant - independent of any stream buffer here, so
// it still works even if a buffer already expired or the server restarted
// mid-conversation. Used by the frontend's "Check if it finished" fallback
// in static/kai.js.
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
  startChat,
  readStreamEvents,
  fetchChat,
};
