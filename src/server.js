const express = require('express');
const path = require('path');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function createServer({ dirs = [] } = {}) {
  const app = express();

  // Parsed usage is cached; filters are applied per request (reparse via refresh endpoint)
  let usagePromise = null;
  const loadUsage = () => {
    if (!usagePromise) {
      usagePromise = require('./parser').loadUsage({ dirs });
      usagePromise.catch(() => { usagePromise = null; });
    }
    return usagePromise;
  };

  function friendlyError(err) {
    const msg = err.message || String(err);
    if (err.code === 'ENOENT') return { error: 'Claude Code data directory not found. Have you used Claude Code yet?', code: 'ENOENT' };
    if (err.code === 'EPERM' || err.code === 'EACCES') return { error: 'Permission denied reading Claude Code data. Try running with elevated permissions.', code: err.code };
    return { error: msg };
  }

  function filtersFrom(query) {
    const date = v => (typeof v === 'string' && DATE_RE.test(v) ? v : undefined);
    return {
      from: date(query.from),
      to: date(query.to),
      account: typeof query.account === 'string' && query.account ? query.account : undefined,
    };
  }

  app.get('/api/data', async (req, res) => {
    try {
      const report = require('./parser').buildReport(await loadUsage(), filtersFrom(req.query));
      // Per-turn rows are fetched on demand by /api/session to keep this payload small
      report.sessions = report.sessions.map(({ queries, ...s }) => s);
      res.json(report);
    } catch (err) {
      res.status(500).json(friendlyError(err));
    }
  });

  app.get('/api/session', async (req, res) => {
    try {
      const queries = require('./parser').sessionQueries(await loadUsage(), {
        ...filtersFrom(req.query),
        sessionId: String(req.query.id || ''),
      });
      if (!queries) return res.status(404).json({ error: 'Session not found' });
      res.json({ queries });
    } catch (err) {
      res.status(500).json(friendlyError(err));
    }
  });

  app.get('/api/refresh', async (req, res) => {
    try {
      delete require.cache[require.resolve('./parser')];
      usagePromise = null;
      const usage = await loadUsage();
      res.json({ ok: true, sessions: usage.sessions.length });
    } catch (err) {
      res.status(500).json(friendlyError(err));
    }
  });

  // Serve static dashboard
  app.use(express.static(path.join(__dirname, 'public')));

  return app;
}

module.exports = { createServer };
