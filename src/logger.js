// Structured, "log everything" logging.
//
// Every line is a single JSON object on stdout (picked up by supervisord / the
// Keboola platform's log collector), plus a short rolling in-memory buffer so
// the UI itself can show a live activity feed without needing platform log
// access. Never log secrets (tokens) - only that a token was present.

const MAX_BUFFER = 200;
const buffer = [];

function write(level, event, details = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    ...details,
  };

  buffer.push(entry);
  if (buffer.length > MAX_BUFFER) buffer.shift();

  const line = JSON.stringify(entry);
  if (level === 'error') {
    console.error(line);
  } else {
    console.log(line);
  }

  return entry;
}

module.exports = {
  info: (event, details) => write('info', event, details),
  warn: (event, details) => write('warn', event, details),
  error: (event, details) => write('error', event, details),
  recent: (limit = 50) => buffer.slice(-limit).reverse(),
};
