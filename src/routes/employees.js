const express = require('express');
const queryService = require('../queryService');
const logger = require('../logger');
const { TABLE_SCHEMA, TABLE_NAME, ID_COLUMN } = require('../config');

const router = express.Router();

const tableRef = `${queryService.sqlIdent(TABLE_SCHEMA)}.${queryService.sqlIdent(TABLE_NAME)}`;

// GET /api/employees - list all rows, with whatever columns the table has.
router.get('/', async (req, res) => {
  try {
    const sql = `SELECT * FROM ${tableRef} ORDER BY ${queryService.sqlIdent(ID_COLUMN)}`;
    const result = await queryService.executeQuery(sql, { queryName: 'List employees' });
    res.json({ columns: result.columns, employees: result.rows });
  } catch (err) {
    logger.error('employees:list-failed', { error: err.message });
    res.status(err.status || 500).json({ error: err.message, details: err.body });
  }
});

// POST /api/employees - add a new row. Body: { <column>: value, ... } for
// whatever columns the table has. "id" is auto-generated if omitted.
router.post('/', async (req, res) => {
  try {
    const payload = { ...(req.body || {}) };
    if (!payload[ID_COLUMN]) {
      payload[ID_COLUMN] = `emp-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    }

    const columns = Object.keys(payload);
    if (columns.length === 0) {
      return res.status(400).json({ error: 'No columns provided.' });
    }

    const sql = `INSERT INTO ${tableRef} (${columns.map(queryService.sqlIdent).join(', ')}) ` +
      `VALUES (${columns.map((c) => queryService.sqlString(payload[c])).join(', ')})`;

    await queryService.executeQuery(sql, { queryName: 'Add employee' });
    logger.info('employees:added', { id: payload[ID_COLUMN], columns });
    res.status(201).json(payload);
  } catch (err) {
    logger.error('employees:add-failed', { error: err.message, body: req.body });
    res.status(err.status || 500).json({ error: err.message, details: err.body });
  }
});

// PUT /api/employees/:id - update an existing row. Body: { <column>: value, ... }.
// The id column itself can't be changed through an update.
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const payload = { ...(req.body || {}) };
    delete payload[ID_COLUMN];

    const columns = Object.keys(payload);
    if (columns.length === 0) {
      return res.status(400).json({ error: 'No columns to update.' });
    }

    const assignments = columns
      .map((col) => `${queryService.sqlIdent(col)} = ${queryService.sqlString(payload[col])}`)
      .join(', ');

    const sql = `UPDATE ${tableRef} SET ${assignments} WHERE ${queryService.sqlIdent(ID_COLUMN)} = ${queryService.sqlString(id)}`;

    await queryService.executeQuery(sql, { queryName: 'Update employee' });
    logger.info('employees:updated', { id, columns });
    res.json({ [ID_COLUMN]: id, ...payload });
  } catch (err) {
    logger.error('employees:update-failed', { error: err.message, id: req.params.id, body: req.body });
    res.status(err.status || 500).json({ error: err.message, details: err.body });
  }
});

module.exports = router;
