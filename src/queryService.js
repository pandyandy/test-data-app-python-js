// Client for Keboola's data-app "Storage Access" / Query Service, which lets a
// running data app read and write Storage tables live over SQL, without going
// through a job/input-output mapping. See:
// https://help.keboola.com/data-apps/reference/#storage-access
//
// This module is written against the live OpenAPI spec served by the Query
// Service itself (GET https://query.keboola.com/ -> apiDocs ->
// /api/v1/documentation/swagger.json), confirmed 2026-09-01. The API is
// async: submit a query job, poll its status, then fetch the results of each
// statement once the job completes.
//
//   1. POST   /api/v1/branches/{branchId}/workspaces/{workspaceId}/queries
//             body: { statements: string[], transactional: boolean, ... }
//             -> { queryJobId }
//   2. GET    /api/v1/queries/{queryJobId}
//             -> { status: created|enqueued|processing|canceled|completed|failed,
//                  statements: [{ id, status, error, ... }] }
//             poll until status is completed/failed/canceled.
//   3. GET    /api/v1/queries/{queryJobId}/{statementId}/results?offset&pageSize
//             -> { status, columns: [{name,...}], data: string[][], numberOfRows }
//
// Auth: header "X-StorageAPI-Token" with the Storage API token (KBC_TOKEN).

const fs = require('fs');
const logger = require('./logger');

const QUERY_SERVICE_URL = process.env.QUERY_SERVICE_URL;
const KBC_TOKEN = process.env.KBC_TOKEN;
const BRANCH_ID = process.env.BRANCH_ID;
const WORKSPACE_MANIFEST_PATH = process.env.KBC_WORKSPACE_MANIFEST_PATH;
const WORKSPACE_ID_ENV = process.env.WORKSPACE_ID;

const POLL_INTERVAL_MS = 300;
const POLL_TIMEOUT_MS = 30000;
const RESULTS_PAGE_SIZE = 500;

let cachedWorkspaceId = null;

function getWorkspaceId() {
  if (cachedWorkspaceId) return cachedWorkspaceId;

  if (WORKSPACE_MANIFEST_PATH) {
    try {
      const raw = fs.readFileSync(WORKSPACE_MANIFEST_PATH, 'utf8');
      const manifest = JSON.parse(raw);
      logger.info('query-service:manifest-loaded', { keys: Object.keys(manifest) });
      if (manifest.workspaceId) {
        cachedWorkspaceId = manifest.workspaceId;
        return cachedWorkspaceId;
      }
    } catch (err) {
      logger.warn('query-service:manifest-read-failed', {
        path: WORKSPACE_MANIFEST_PATH,
        error: err.message,
      });
    }
  }

  if (WORKSPACE_ID_ENV) {
    cachedWorkspaceId = WORKSPACE_ID_ENV;
    return cachedWorkspaceId;
  }

  return null;
}

function isConfigured() {
  return Boolean(QUERY_SERVICE_URL && KBC_TOKEN && BRANCH_ID && getWorkspaceId());
}

function configStatus() {
  return {
    hasQueryServiceUrl: Boolean(QUERY_SERVICE_URL),
    hasToken: Boolean(KBC_TOKEN),
    hasBranchId: Boolean(BRANCH_ID),
    hasWorkspaceId: Boolean(getWorkspaceId()),
  };
}

// Escapes a value for inline use in a SQL string literal. The Query Service
// takes raw SQL statements (no bind-parameter support), so every value that
// isn't a validated column/table identifier MUST go through this before
// being interpolated into a query.
function sqlString(value) {
  if (value === null || value === undefined) return 'NULL';
  return `'${String(value).replace(/'/g, "''")}'`;
}

// Wraps an identifier (table/column name) in the delimited-identifier form
// this project's SQL dialect (Snowflake) requires.
function sqlIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

async function apiRequest(method, path, body) {
  const url = `${QUERY_SERVICE_URL.replace(/\/+$/, '')}${path}`;
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-StorageAPI-Token': KBC_TOKEN,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    logger.error('query-service:network-error', { method, url, error: err.message });
    throw err;
  }

  const bodyText = await response.text();
  let parsed;
  try {
    parsed = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    parsed = bodyText;
  }

  if (!response.ok) {
    logger.error('query-service:response-error', { method, url, status: response.status, body: parsed });
    const err = new Error(parsed?.exception || `Query Service returned ${response.status}`);
    err.code = 'QUERY_SERVICE_ERROR';
    err.status = response.status;
    err.body = parsed;
    throw err;
  }

  return parsed;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForJob(queryJobId) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    const job = await apiRequest('GET', `/api/v1/queries/${queryJobId}`);
    if (['completed', 'failed', 'canceled'].includes(job.status)) {
      return job;
    }
    if (Date.now() > deadline) {
      const err = new Error(`Timed out waiting for query job ${queryJobId} (last status: ${job.status})`);
      err.code = 'QUERY_SERVICE_TIMEOUT';
      throw err;
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

async function fetchAllResults(queryJobId, statementId) {
  const columns = [];
  const rows = [];
  let offset = 0;

  for (;;) {
    const page = await apiRequest(
      'GET',
      `/api/v1/queries/${queryJobId}/${statementId}/results?offset=${offset}&pageSize=${RESULTS_PAGE_SIZE}`
    );

    if (offset === 0) {
      (page.columns || []).forEach((c) => columns.push(c.name));
    }

    const data = page.data || [];
    data.forEach((rowValues) => {
      const row = {};
      columns.forEach((colName, i) => {
        row[colName] = rowValues[i];
      });
      rows.push(row);
    });

    if (data.length < RESULTS_PAGE_SIZE) break;
    offset += RESULTS_PAGE_SIZE;
  }

  return { columns, rows };
}

async function executeQuery(sql, { queryName } = {}) {
  if (!isConfigured()) {
    const status = configStatus();
    logger.error('query-service:not-configured', status);
    const err = new Error(
      'Storage Access is not configured for this app (missing QUERY_SERVICE_URL / KBC_TOKEN / BRANCH_ID / workspace id). ' +
        'Enable Storage Access + select out.c-data.employee-data in the app\'s Advanced Settings, then redeploy.'
    );
    err.code = 'QUERY_SERVICE_NOT_CONFIGURED';
    throw err;
  }

  const workspaceId = getWorkspaceId();
  logger.info('query-service:submit', { queryName, sql });

  const submitted = await apiRequest(
    'POST',
    `/api/v1/branches/${BRANCH_ID}/workspaces/${workspaceId}/queries`,
    { statements: [sql], transactional: true }
  );

  const job = await waitForJob(submitted.queryJobId);
  const statement = job.statements?.[0];

  if (job.status !== 'completed' || statement?.status === 'failed') {
    logger.error('query-service:job-failed', { queryName, queryJobId: submitted.queryJobId, job });
    const err = new Error(statement?.error || `Query job ${job.status}`);
    err.code = 'QUERY_SERVICE_JOB_FAILED';
    throw err;
  }

  logger.info('query-service:job-completed', {
    queryName,
    queryJobId: submitted.queryJobId,
    rowsAffected: statement?.rowsAffected,
    numberOfRows: statement?.numberOfRows,
  });

  if (!statement?.id) {
    return { columns: [], rows: [] };
  }

  return fetchAllResults(submitted.queryJobId, statement.id);
}

module.exports = {
  isConfigured,
  configStatus,
  executeQuery,
  sqlString,
  sqlIdent,
};
