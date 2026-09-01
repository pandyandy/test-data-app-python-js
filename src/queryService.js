// Client for Keboola's data-app "Storage Access" / Query Service, which lets a
// running data app read and write Storage tables live over SQL, without going
// through a job/input-output mapping. See:
// https://help.keboola.com/data-apps/reference/#storage-access
//
// IMPORTANT - verify against your deployment:
// This module was written without a live deployment to test against (this
// session only had read access to the Keboola project). The environment
// variables below are the ones Keboola documents for Storage Access, but the
// exact request/response shape of the Query Service HTTP API is our best
// reasonable guess at Keboola's REST conventions, not something we've
// confirmed by calling it. The FIRST time this app runs for real with
// Storage Access enabled:
//   1. Check the app logs for the "query-service:request" / "query-service:response"
//      entries this module writes on every call.
//   2. If a query fails, the error log includes the raw response body - use it
//      to correct `QUERY_SERVICE_PATH` / the request body shape below.
// Everything Query-Service-specific is isolated in this one file so that fix
// is a small, local change.

const fs = require('fs');
const logger = require('./logger');

const QUERY_SERVICE_URL = process.env.QUERY_SERVICE_URL;
const KBC_TOKEN = process.env.KBC_TOKEN;
const BRANCH_ID = process.env.BRANCH_ID;
const WORKSPACE_MANIFEST_PATH = process.env.KBC_WORKSPACE_MANIFEST_PATH;
const WORKSPACE_ID_ENV = process.env.WORKSPACE_ID;

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
  return Boolean(QUERY_SERVICE_URL && KBC_TOKEN && getWorkspaceId());
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

async function executeQuery(sql, { queryName } = {}) {
  if (!isConfigured()) {
    const status = configStatus();
    logger.error('query-service:not-configured', status);
    const err = new Error(
      'Storage Access is not configured for this app (missing QUERY_SERVICE_URL / KBC_TOKEN / workspace id). ' +
        'Enable Storage Access + select out.c-data.employee-data in the app\'s Advanced Settings, then redeploy.'
    );
    err.code = 'QUERY_SERVICE_NOT_CONFIGURED';
    throw err;
  }

  const workspaceId = getWorkspaceId();
  const url = `${QUERY_SERVICE_URL.replace(/\/+$/, '')}/branch/${BRANCH_ID}/workspace/${workspaceId}/query`;

  logger.info('query-service:request', { queryName, sql, url });

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-StorageApi-Token': KBC_TOKEN,
      },
      body: JSON.stringify({ statements: [sql] }),
    });
  } catch (err) {
    logger.error('query-service:network-error', { queryName, url, error: err.message });
    throw err;
  }

  const bodyText = await response.text();
  let body;
  try {
    body = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    body = bodyText;
  }

  if (!response.ok) {
    logger.error('query-service:response-error', {
      queryName,
      status: response.status,
      body,
    });
    const err = new Error(`Query Service returned ${response.status}`);
    err.code = 'QUERY_SERVICE_ERROR';
    err.status = response.status;
    err.body = body;
    throw err;
  }

  logger.info('query-service:response', { queryName, status: response.status });

  return normalizeResult(body);
}

// The Query Service response shape isn't confirmed from a live call (see the
// module header). This accepts a few plausible shapes for a single-statement
// call and always returns { columns: string[], rows: object[] }.
function normalizeResult(body) {
  if (!body) return { columns: [], rows: [] };

  const candidate = Array.isArray(body?.results) ? body.results[0] : body;

  if (Array.isArray(candidate?.rows) && Array.isArray(candidate?.columns)) {
    const columns = candidate.columns;
    const rows = candidate.rows.map((row) => {
      if (Array.isArray(row)) {
        const obj = {};
        columns.forEach((col, i) => {
          obj[col] = row[i];
        });
        return obj;
      }
      return row;
    });
    return { columns, rows };
  }

  if (Array.isArray(candidate?.data)) {
    const rows = candidate.data;
    const columns = rows.length ? Object.keys(rows[0]) : [];
    return { columns, rows };
  }

  if (Array.isArray(body)) {
    const columns = body.length ? Object.keys(body[0]) : [];
    return { columns, rows: body };
  }

  logger.warn('query-service:unrecognized-result-shape', { bodyPreview: JSON.stringify(body).slice(0, 500) });
  return { columns: [], rows: [] };
}

module.exports = {
  isConfigured,
  configStatus,
  executeQuery,
  sqlString,
  sqlIdent,
};
