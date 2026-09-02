const express = require('express');
const crypto = require('crypto');
const kaiService = require('../kaiService');
const logger = require('../logger');

const router = express.Router();

function handleError(err, res, event) {
  logger.error(event, { error: err.message });
  res.status(err.status || 500).json({ error: err.message });
}

// POST /api/chat - start a chat turn against Kai in the background and
// return a streamId immediately. We don't hold this HTTP request open for
// the answer: the Keboola Data Apps platform proxy in front of this app
// enforces a hard 30s timeout on any plain HTTP request regardless of
// activity (confirmed via platform traces - only WebSockets get a longer
// allowance there), so a Kai answer involving several tool calls routinely
// exceeds it. The frontend polls GET /api/chat/stream/:streamId/events
// instead - see src/kaiService.js for the buffering.
router.post('/chat', (req, res) => {
  try {
    const streamId = kaiService.startChat(req.body);
    res.json({ streamId });
  } catch (err) {
    handleError(err, res, 'kai:chat-start-failed');
  }
});

// GET /api/chat/stream/:streamId/events?since=N - poll for events buffered
// since sequence N. Each call is a plain, near-instant JSON response.
router.get('/chat/stream/:streamId/events', (req, res) => {
  try {
    const since = Number.parseInt(req.query.since, 10) || 0;
    const result = kaiService.readStreamEvents(req.params.streamId, since);
    res.json(result);
  } catch (err) {
    handleError(err, res, 'kai:stream-poll-failed');
  }
});

// GET /api/chat/:chatId - fetch the chat's current messages as a plain JSON
// response, straight from kai-assistant (not from our own stream buffer).
// Used by the frontend to recover an answer if a stream buffer already
// expired or the server restarted mid-conversation.
router.get('/chat/:chatId', async (req, res) => {
  try {
    const data = await kaiService.fetchChat(req.params.chatId);
    res.json(data);
  } catch (err) {
    handleError(err, res, 'kai:fetch-chat-failed');
  }
});

// POST /api/chat/:chatId/:action/:approvalId - resume a chat after a write
// tool paused for approval. :action is "approve" or "reject"; either way we
// send a tool-approval-response message and start a new buffered stream for
// the continuation, same as POST /chat.
router.post('/chat/:chatId/:action/:approvalId', (req, res) => {
  try {
    const { chatId, action, approvalId } = req.params;
    const approved = action === 'approve';

    const payload = {
      id: chatId,
      message: {
        id: crypto.randomUUID(),
        role: 'user',
        parts: [{
          type: 'tool-approval-response',
          approvalId,
          approved,
          ...(approved ? {} : { reason: 'User denied' }),
        }],
      },
      selectedChatModel: 'chat-model',
      selectedVisibilityType: 'private',
    };

    const streamId = kaiService.startChat(payload);
    res.json({ streamId });
  } catch (err) {
    handleError(err, res, 'kai:approval-start-failed');
  }
});

module.exports = router;
