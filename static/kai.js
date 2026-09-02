// Kai chat panel. Talks only to this server's /api/chat routes, which proxy
// to Keboola's kai-assistant with auth headers attached (see
// src/kaiService.js) - no credentials ever reach the browser.

const chatMessages = document.getElementById('chatMessages');
const chatForm = document.getElementById('chatForm');
const chatInput = document.getElementById('chatInput');
const chatSendBtn = document.getElementById('chatSendBtn');
const newChatBtn = document.getElementById('newChatBtn');
const chatApproval = document.getElementById('chatApproval');
const chatApproveBtn = document.getElementById('chatApproveBtn');
const chatDenyBtn = document.getElementById('chatDenyBtn');
const chatSuggestions = document.getElementById('chatSuggestions');

let chatId = crypto.randomUUID();
let pendingApproval = null;
let isStreaming = false;

function scrollChatToBottom() {
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function setStreaming(value) {
    isStreaming = value;
    chatSendBtn.disabled = value;
    chatInput.disabled = value;
}

// "Connection error: network error" alone isn't enough to diagnose anything.
// Logs full detail (name, message, stack) to the console and returns a
// display string carrying the error type, elapsed time, and chat id - the
// chat id lets you match this failure against the server's activity log,
// which now logs it on every kai:* line for the same request.
function describeConnectionError(err, startedAt) {
    const elapsedS = ((performance.now() - startedAt) / 1000).toFixed(1);
    console.error('[kai] connection error', { name: err.name, message: err.message, chatId, elapsedS, err });
    return `Connection error: ${err.name || 'Error'}: ${err.message} (chat ${chatId.slice(0, 8)}, after ${elapsedS}s)`;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Escapes first, then layers a small safe subset of markdown on top of the
// escaped text - so anything Kai's response text contains (including
// HTML-looking content echoed back from a prompt) can never inject markup.
function renderMarkdown(text) {
    return escapeHtml(text)
        .replace(/```(\w*)\n([\s\S]*?)```/g, (_m, _lang, code) => `<pre><code>${code.trim()}</code></pre>`)
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
        .replace(/\n/g, '<br>');
}

function parseListItems(block) {
    return block
        .trim()
        .split('\n')
        .map((line) => line.replace(/^\s*[-*]\s+/, '').trim())
        .filter(Boolean);
}

// Kai appends suggested next actions either as a fenced ```next_actions
// block or as trailing bullet lines. Pull them out so they render as
// clickable buttons instead of raw list text.
function extractSuggestions(text) {
    const stripped = text.trimEnd();

    const fencedMatch = stripped.match(/\n```[^\n]*\n((?:\s*[-*]\s+.+\n?)+)\s*```\s*$/);
    if (fencedMatch) {
        return {
            body: stripped.slice(0, fencedMatch.index).trimEnd(),
            suggestions: parseListItems(fencedMatch[1]),
        };
    }

    const listMatch = stripped.match(/\n((?:[-*]\s+.+\n?){2,})$/);
    if (listMatch) {
        return {
            body: stripped.slice(0, listMatch.index).trimEnd(),
            suggestions: parseListItems(listMatch[1]),
        };
    }

    return { body: text, suggestions: [] };
}

function addUserMessage(text) {
    const div = document.createElement('div');
    div.className = 'chat-message user';
    div.textContent = text;
    chatMessages.appendChild(div);
    scrollChatToBottom();
}

function createAssistantMessage() {
    const div = document.createElement('div');
    div.className = 'chat-message assistant';
    chatMessages.appendChild(div);
    return div;
}

function addToolIndicator(container, text, completed = false) {
    const div = document.createElement('div');
    div.className = 'chat-tool' + (completed ? ' completed' : '');
    div.textContent = text;
    container.parentElement.insertBefore(div, container.nextSibling);
    scrollChatToBottom();
}

function addChatError(text) {
    const div = document.createElement('div');
    div.className = 'chat-error';
    div.textContent = text;
    chatMessages.appendChild(div);
    scrollChatToBottom();
}

// Like addChatError, but with action buttons - used when the connection
// itself dropped (as opposed to Kai returning an error response). `actions`
// is [{ label, onClick }]; each click removes the error and runs its action.
function addChatErrorWithActions(text, actions) {
    const div = document.createElement('div');
    div.className = 'chat-error';
    const message = document.createElement('span');
    message.textContent = text;
    div.appendChild(message);

    actions.forEach(({ label, onClick }) => {
        const btn = document.createElement('button');
        btn.className = 'btn btn-secondary btn-small chat-retry-btn';
        btn.textContent = label;
        btn.addEventListener('click', () => {
            div.remove();
            onClick();
        });
        div.appendChild(btn);
    });

    chatMessages.appendChild(div);
    scrollChatToBottom();
}

// kai-assistant keeps working on a request server-side even after our
// proxied SSE connection to it drops, so a plain (non-streaming, so not
// subject to whatever cut the stream short) GET can often recover an answer
// that finished after the browser already saw a connection error. Message
// shape follows the same { role, parts: [{ type: 'text', text }] } form we
// send our own messages in.
async function fetchRecoveredAnswer() {
    try {
        const res = await fetch(`/api/chat/${chatId}`);
        if (!res.ok) return null;
        const data = await res.json();
        const messages = Array.isArray(data.messages) ? data.messages : [];
        const lastAssistant = [...messages].reverse().find((m) => m && m.role === 'assistant');
        if (!lastAssistant || !Array.isArray(lastAssistant.parts)) return null;
        const text = lastAssistant.parts
            .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
            .map((p) => p.text)
            .join('');
        return text || null;
    } catch {
        return null;
    }
}

// Looks up whether Kai actually finished the answer despite the dropped
// connection, and either renders it or offers to check again / retry.
async function checkIfFinished(content, accumulatedRef, originalText) {
    setStreaming(true);
    const recovered = await fetchRecoveredAnswer();

    if (recovered) {
        const finalContent = accumulatedRef.text ? content : createAssistantMessage();
        const { body, suggestions } = extractSuggestions(recovered);
        finalContent.innerHTML = renderMarkdown(body);
        if (suggestions.length) renderSuggestions(suggestions);
    } else {
        addChatErrorWithActions("Kai hasn't finished yet, or the answer couldn't be recovered.", [
            { label: 'Check again', onClick: () => checkIfFinished(content, accumulatedRef, originalText) },
            { label: 'Retry', onClick: () => sendMessage(originalText) },
        ]);
    }

    setStreaming(false);
    chatInput.focus();
}

function renderSuggestions(suggestions) {
    chatSuggestions.innerHTML = '';
    suggestions.forEach((text) => {
        const btn = document.createElement('button');
        btn.className = 'suggestion-btn';
        btn.textContent = text;
        btn.addEventListener('click', () => {
            chatSuggestions.innerHTML = '';
            sendMessage(text);
        });
        chatSuggestions.appendChild(btn);
    });
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

const POLL_INTERVAL_MS = 1200;

// Reads a JSON error body's `.error` field if present, falling back to the
// raw text.
async function readErrorBody(res) {
    const text = await res.text();
    try {
        return JSON.parse(text).error || text;
    } catch {
        return text;
    }
}

// Starts a chat turn at `url` (POST /api/chat or an approval endpoint) and
// polls for its buffered events instead of holding one connection open for
// the whole answer. The Keboola Data Apps platform proxy in front of this
// app enforces a hard 30s timeout on any plain HTTP request regardless of
// activity (confirmed via platform traces - only WebSockets are exempt
// there), so a Kai answer involving several tool calls routinely exceeds
// it. Every request here - the start, and each poll - completes in well
// under a second, so that cap never applies.
async function runChat(url, fetchOptions, onEvent) {
    const startRes = await fetch(url, fetchOptions);
    if (!startRes.ok) {
        throw new Error((await readErrorBody(startRes)) || `Request failed (${startRes.status})`);
    }
    const { streamId } = await startRes.json();

    let since = 0;
    for (;;) {
        const res = await fetch(`/api/chat/stream/${streamId}/events?since=${since}`);
        if (!res.ok) {
            throw new Error((await readErrorBody(res)) || `Poll failed (${res.status})`);
        }
        const data = await res.json();
        for (const event of data.events) onEvent(event);
        since = data.nextSeq;

        if (data.error) throw new Error(data.error);
        if (data.done) return;
        await sleep(POLL_INTERVAL_MS);
    }
}

function handleStreamEvent(content, accumulatedRef, toolNames) {
    return ({ type, data }) => {
        switch (type) {
            case 'text-delta':
                if (data && data.delta) {
                    accumulatedRef.text += data.delta;
                    content.innerHTML = renderMarkdown(accumulatedRef.text) + '<span class="chat-cursor"></span>';
                    scrollChatToBottom();
                }
                break;

            case 'tool-call': {
                const callId = data.toolCallId || '';
                const name = data.toolName || null;
                const state = data.state || '';
                if (name) toolNames[callId] = name;
                const displayName = name || toolNames[callId] || 'tool';

                if (state === 'input-available') {
                    content.innerHTML = renderMarkdown(accumulatedRef.text);
                    addToolIndicator(content, `Calling ${displayName}…`);
                } else if (state === 'output-available') {
                    addToolIndicator(content, `${displayName} completed.`, true);
                }
                break;
            }

            case 'tool-approval-request':
                pendingApproval = { approvalId: data.approvalId, toolCallId: data.toolCallId };
                chatApproval.hidden = false;
                break;

            case 'error':
                addChatError(data.message || 'Unknown error');
                break;
        }
    };
}

async function sendMessage(text) {
    if (!text.trim() || isStreaming) return;

    chatSuggestions.innerHTML = '';
    addUserMessage(text);
    setStreaming(true);

    const startedAt = performance.now();
    const content = createAssistantMessage();
    const accumulatedRef = { text: '' };
    const toolNames = {};

    const payload = {
        id: chatId,
        message: {
            id: crypto.randomUUID(),
            role: 'user',
            parts: [{ type: 'text', text }],
        },
        selectedChatModel: 'chat-model',
        selectedVisibilityType: 'private',
    };

    try {
        await runChat(
            '/api/chat',
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            },
            handleStreamEvent(content, accumulatedRef, toolNames)
        );

        if (accumulatedRef.text) {
            const { body, suggestions } = extractSuggestions(accumulatedRef.text);
            content.innerHTML = renderMarkdown(body);
            if (suggestions.length) renderSuggestions(suggestions);
        } else {
            content.remove();
        }
    } catch (err) {
        // The connection dropped mid-stream rather than Kai returning an
        // error - keep whatever text made it through (if any). Kai itself
        // may well have kept working after our stream to it was cut, so
        // offer to check for a finished answer before falling back to
        // resending the question.
        if (accumulatedRef.text) {
            content.innerHTML = renderMarkdown(accumulatedRef.text);
        } else {
            content.remove();
        }

        addChatErrorWithActions(describeConnectionError(err, startedAt), [
            { label: 'Check if it finished', onClick: () => checkIfFinished(content, accumulatedRef, text) },
            { label: 'Retry', onClick: () => sendMessage(text) },
        ]);
    }

    setStreaming(false);
    chatInput.focus();
}

async function handleApproval(approved) {
    if (!pendingApproval) return;

    chatApproval.hidden = true;
    const { approvalId } = pendingApproval;
    pendingApproval = null;

    setStreaming(true);
    const startedAt = performance.now();
    const content = createAssistantMessage();
    const accumulatedRef = { text: '' };
    const toolNames = {};

    const action = approved ? 'approve' : 'reject';
    try {
        await runChat(
            `/api/chat/${chatId}/${action}/${approvalId}`,
            { method: 'POST', headers: { 'Content-Type': 'application/json' } },
            handleStreamEvent(content, accumulatedRef, toolNames)
        );
        content.innerHTML = renderMarkdown(accumulatedRef.text);
    } catch (err) {
        addChatError(describeConnectionError(err, startedAt));
    }

    setStreaming(false);
}

chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (text) {
        chatInput.value = '';
        sendMessage(text);
    }
});

newChatBtn.addEventListener('click', () => {
    chatId = crypto.randomUUID();
    chatMessages.innerHTML = '';
    chatSuggestions.innerHTML = '';
    chatApproval.hidden = true;
    pendingApproval = null;
    chatInput.focus();
});

chatApproveBtn.addEventListener('click', () => handleApproval(true));
chatDenyBtn.addEventListener('click', () => handleApproval(false));

fetch('/api/status')
    .then((res) => res.json())
    .then((data) => {
        const kai = data.kai || {};
        if (!kai.hasStorageUrl || !kai.hasToken) {
            addChatError(
                'Kai isn\'t configured for this app yet (missing KBC_URL / KAI_TOKEN environment variables).'
            );
        }
    })
    .catch(() => {
        // status endpoint failing isn't fatal to the chat UI
    });
