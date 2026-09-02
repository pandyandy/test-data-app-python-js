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

// Kai's SSE uses data-only lines with the event type inside the JSON body -
// no "event:" lines, so parsing is just picking out "data:" lines.
function* parseSSEChunk(text) {
    for (const line of text.split('\n')) {
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

async function readSSEStream(url, fetchOptions, onEvent) {
    const res = await fetch(url, fetchOptions);
    if (!res.ok) {
        const text = await res.text();
        let message = text;
        try {
            message = JSON.parse(text).error || text;
        } catch {
            // plain text error, use as-is
        }
        addChatError(message || `Request failed (${res.status})`);
        return null;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop();

        for (const part of parts) {
            if (!part.trim()) continue;
            for (const event of parseSSEChunk(part + '\n\n')) {
                onEvent(event);
            }
        }
    }

    return res;
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
        const res = await readSSEStream(
            '/api/chat',
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            },
            handleStreamEvent(content, accumulatedRef, toolNames)
        );

        if (!res) {
            content.remove();
        } else if (accumulatedRef.text) {
            const { body, suggestions } = extractSuggestions(accumulatedRef.text);
            content.innerHTML = renderMarkdown(body);
            if (suggestions.length) renderSuggestions(suggestions);
        } else {
            content.remove();
        }
    } catch (err) {
        content.remove();
        addChatError(`Connection error: ${err.message}`);
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
    const content = createAssistantMessage();
    const accumulatedRef = { text: '' };
    const toolNames = {};

    const action = approved ? 'approve' : 'reject';
    try {
        const res = await readSSEStream(
            `/api/chat/${chatId}/${action}/${approvalId}`,
            { method: 'POST', headers: { 'Content-Type': 'application/json' } },
            handleStreamEvent(content, accumulatedRef, toolNames)
        );
        if (res) content.innerHTML = renderMarkdown(accumulatedRef.text);
    } catch (err) {
        addChatError(`Connection error: ${err.message}`);
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
