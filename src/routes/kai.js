const express = require('express');
const crypto = require('crypto');
const kaiService = require('../kaiService');
const logger = require('../logger');

const router = express.Router();

function handleProxyError(err, res, event) {
  logger.error(event, { error: err.message });
  if (!res.headersSent) {
    res.status(err.status || 500).json({ error: err.message });
  } else {
    res.end();
  }
}

// POST /api/chat - forward a chat message to Kai and stream the SSE response back.
router.post('/chat', async (req, res) => {
  try {
    await kaiService.proxyChat(req.body, res);
  } catch (err) {
    handleProxyError(err, res, 'kai:chat-failed');
  }
});

// GET /api/chat/:chatId - fetch the chat's current messages as a plain JSON
// response (not a stream). Used by the frontend to recover an answer after
// a dropped streaming connection - see src/kaiService.js#fetchChat.
router.get('/chat/:chatId', async (req, res) => {
  try {
    const data = await kaiService.fetchChat(req.params.chatId);
    res.json(data);
  } catch (err) {
    handleProxyError(err, res, 'kai:fetch-chat-failed');
  }
});

// POST /api/chat/:chatId/:action/:approvalId - resume a chat after a write
// tool paused for approval. :action is "approve" or "reject"; either way we
// send a tool-approval-response message and stream the continuation back.
router.post('/chat/:chatId/:action/:approvalId', async (req, res) => {
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

    await kaiService.proxyChat(payload, res);
  } catch (err) {
    handleProxyError(err, res, 'kai:approval-failed');
  }
});

module.exports = router;
