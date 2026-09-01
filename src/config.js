// Central place for anything the rest of the app needs to agree on:
// the table we manage. Column layout is NOT hardcoded here - it's read from
// the table itself at request time (SELECT *), so this app works against
// whatever columns out.c-data.employee-data actually has.

const TABLE_STAGE = 'out';
const TABLE_BUCKET = 'c-data';
const TABLE_NAME = 'employee-data';

// Bucket ids in Keboola Storage are written as "<stage>.<bucket>", e.g. "out.c-data".
const TABLE_SCHEMA = `${TABLE_STAGE}.${TABLE_BUCKET}`;
const TABLE_ID = `${TABLE_SCHEMA}.${TABLE_NAME}`;

// The one column we do assume exists: a unique row identifier, used to
// target UPDATE statements and to auto-generate an id for new rows.
const ID_COLUMN = 'id';

// Keboola-managed Storage tables can carry internal bookkeeping columns
// (e.g. "_timestamp" for row versioning) alongside the real data columns.
// These are maintained by the platform's own write path - writing to them
// directly over SQL can fail (their stored representation isn't always a
// value Snowflake will implicitly cast back in a plain UPDATE/INSERT). Treat
// any underscore-prefixed column as read-only/hidden.
function isSystemColumn(name) {
  return typeof name === 'string' && name.startsWith('_');
}

module.exports = {
  TABLE_SCHEMA,
  TABLE_NAME,
  TABLE_ID,
  ID_COLUMN,
  isSystemColumn,
  PORT: process.env.PORT || 3000,
};
