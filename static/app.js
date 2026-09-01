// Column layout is NOT hardcoded - it's discovered from whatever the API
// returns (which itself is a live "SELECT *" against the table), so this UI
// adapts to out.c-data.employee-data's real schema. The one assumption we
// make (matching the backend) is that a column named "id" is the row key.
const ID_COLUMN = 'id';

const tableHead = document.getElementById('employeeTableHead');
const tableBody = document.getElementById('employeeTableBody');
const emptyState = document.getElementById('emptyState');
const banner = document.getElementById('banner');
const refreshBtn = document.getElementById('refreshBtn');
const addRowBtn = document.getElementById('addRowBtn');
const toggleLogBtn = document.getElementById('toggleLogBtn');
const logPanel = document.getElementById('logPanel');
const logList = document.getElementById('logList');

let columns = [];
let employees = [];
let logPollHandle = null;

function showBanner(message, type = 'info') {
    banner.textContent = message;
    banner.className = `banner ${type}`;
    banner.hidden = false;
}

function hideBanner() {
    banner.hidden = true;
}

function labelFor(column) {
    return column
        .replace(/[_-]+/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase());
}

async function apiFetch(url, options) {
    const res = await fetch(url, options);
    let body = null;
    try {
        body = await res.json();
    } catch {
        // no JSON body
    }
    if (!res.ok) {
        const message = body?.error || `Request failed (${res.status})`;
        throw new Error(message);
    }
    return body;
}

function renderHead() {
    const tr = document.createElement('tr');
    columns.forEach((col) => {
        const th = document.createElement('th');
        th.textContent = labelFor(col);
        tr.appendChild(th);
    });
    const th = document.createElement('th');
    th.textContent = '';
    tr.appendChild(th);
    tableHead.innerHTML = '';
    tableHead.appendChild(tr);
}

function renderRows() {
    tableBody.innerHTML = '';
    emptyState.hidden = employees.length > 0;
    addRowBtn.disabled = columns.length === 0;

    employees.forEach((employee, index) => {
        tableBody.appendChild(buildRow(employee, index));
    });
}

function buildRow(employee, index) {
    const tr = document.createElement('tr');
    if (employee.__isNew) tr.classList.add('is-new');

    const actionsTd = document.createElement('td');
    const actionsWrap = document.createElement('div');
    actionsWrap.className = 'row-actions';

    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn btn-primary btn-small';
    saveBtn.textContent = employee.__isNew ? 'Add' : 'Save';
    // For an existing row, the Save button only shows up once something has
    // actually changed - not on every untouched row.
    saveBtn.hidden = !employee.__isNew;
    saveBtn.addEventListener('click', () => saveRow(employee, saveBtn));

    columns.forEach((col) => {
        const td = document.createElement('td');
        const input = document.createElement('input');
        input.type = 'text';
        input.value = employee[col] ?? '';
        input.disabled = col === ID_COLUMN;
        if (col === ID_COLUMN && employee.__isNew) input.placeholder = '(auto)';
        input.dataset.column = col;
        input.addEventListener('input', () => {
            employee[col] = input.value;
            if (!employee.__isNew) {
                tr.classList.add('is-dirty');
                saveBtn.hidden = false;
            }
        });
        td.appendChild(input);
        tr.appendChild(td);
    });

    actionsWrap.appendChild(saveBtn);

    if (employee.__isNew) {
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'btn btn-secondary btn-small';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', () => {
            employees.splice(index, 1);
            renderRows();
        });
        actionsWrap.appendChild(cancelBtn);
    }

    actionsTd.appendChild(actionsWrap);
    tr.appendChild(actionsTd);

    return tr;
}

async function saveRow(employee, button) {
    const originalLabel = button.textContent;
    const startedAt = performance.now();
    const elapsedSeconds = () => ((performance.now() - startedAt) / 1000).toFixed(1);

    button.disabled = true;
    hideBanner();
    openLogPanel();

    const ticker = setInterval(() => {
        button.textContent = `Saving… ${elapsedSeconds()}s`;
    }, 100);
    button.textContent = `Saving… 0.0s`;

    try {
        const payload = {};
        columns.forEach((col) => {
            if (col === ID_COLUMN && employee.__isNew && !employee[col]) return;
            payload[col] = employee[col] ?? '';
        });

        if (employee.__isNew) {
            const created = await apiFetch('/api/employees', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            showBanner(`Added employee ${created[ID_COLUMN]} in ${elapsedSeconds()}s.`, 'success');
        } else {
            delete payload[ID_COLUMN];
            await apiFetch(`/api/employees/${encodeURIComponent(employee[ID_COLUMN])}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            showBanner(`Saved changes to ${employee[ID_COLUMN]} in ${elapsedSeconds()}s.`, 'success');
        }

        await loadEmployees();
        loadLogs();
    } catch (err) {
        showBanner(`${err.message} (after ${elapsedSeconds()}s)`, 'error');
        button.disabled = false;
        button.textContent = originalLabel;
        loadLogs();
    } finally {
        clearInterval(ticker);
    }
}

function addBlankRow() {
    if (columns.length === 0) return;
    const blank = { __isNew: true };
    columns.forEach((col) => {
        blank[col] = '';
    });
    employees.push(blank);
    renderRows();
    tableBody.lastElementChild?.querySelector('input:not(:disabled)')?.focus();
}

async function loadEmployees() {
    try {
        const data = await apiFetch('/api/employees');
        employees = data.employees || [];
        columns = data.columns && data.columns.length
            ? data.columns
            : (employees.length ? Object.keys(employees[0]) : columns);
        renderHead();
        renderRows();
    } catch (err) {
        showBanner(err.message, 'error');
    }
}

async function loadStatus() {
    try {
        const data = await apiFetch('/api/status');
        const status = data.storageAccess;
        const missing = Object.entries(status)
            .filter(([, ok]) => !ok)
            .map(([key]) => key);
        if (missing.length) {
            showBanner(
                `Storage Access isn't fully configured yet (missing: ${missing.join(', ')}). ` +
                'Enable it in the app\'s Advanced Settings and select out.c-data.employee-data, then redeploy.',
                'error'
            );
        }
    } catch {
        // status endpoint failing isn't fatal to the UI
    }
}

function renderLogs(logs) {
    logList.innerHTML = '';
    logs.forEach((entry) => {
        const li = document.createElement('li');
        li.className = `level-${entry.level}`;
        const time = document.createElement('span');
        time.textContent = new Date(entry.ts).toLocaleTimeString();
        const event = document.createElement('span');
        event.className = 'log-event';
        event.textContent = entry.event;
        li.appendChild(time);
        li.appendChild(event);
        if (entry.id) {
            const idSpan = document.createElement('span');
            idSpan.textContent = entry.id;
            li.appendChild(idSpan);
        }
        logList.appendChild(li);
    });
}

async function loadLogs() {
    try {
        const data = await apiFetch('/api/logs');
        renderLogs(data.logs || []);
    } catch {
        // ignore log-fetch failures
    }
}

refreshBtn.addEventListener('click', () => {
    hideBanner();
    loadEmployees();
});

addRowBtn.addEventListener('click', addBlankRow);

function openLogPanel() {
    logPanel.hidden = false;
    toggleLogBtn.textContent = 'Hide';
    loadLogs();
    if (!logPollHandle) {
        logPollHandle = setInterval(loadLogs, 5000);
    }
}

function closeLogPanel() {
    logPanel.hidden = true;
    toggleLogBtn.textContent = 'Show';
    if (logPollHandle) {
        clearInterval(logPollHandle);
        logPollHandle = null;
    }
}

toggleLogBtn.addEventListener('click', () => {
    if (logPanel.hidden) {
        openLogPanel();
    } else {
        closeLogPanel();
    }
});

renderHead();
loadStatus();
loadEmployees();
