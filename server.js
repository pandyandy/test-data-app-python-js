const path = require('path');
const express = require('express');
const logger = require('./src/logger');
const queryService = require('./src/queryService');
const employeesRouter = require('./src/routes/employees');
const { PORT } = require('./src/config');

const app = express();

app.use(express.json());

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    logger.info('http:request', {
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs: Date.now() - start,
    });
  });
  next();
});

app.use('/api/employees', employeesRouter);

app.get('/api/status', (req, res) => {
  res.json({ storageAccess: queryService.configStatus() });
});

app.get('/api/logs', (req, res) => {
  res.json({ logs: logger.recent(100) });
});

app.use(express.static(path.join(__dirname, 'static')));

app.listen(PORT, () => {
  logger.info('server:started', { port: PORT, storageAccess: queryService.configStatus() });
});
