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

module.exports = {
  TABLE_SCHEMA,
  TABLE_NAME,
  TABLE_ID,
  ID_COLUMN,
  PORT: process.env.PORT || 3000,
};
