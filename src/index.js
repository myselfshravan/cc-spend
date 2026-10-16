#!/usr/bin/env node

const { createServer } = require('./server');

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
claude-spend - See where your Claude Code tokens go

Usage:
  claude-spend [options]

Options:
  --port <port>          Port to run dashboard on (default: 3456)
  --dir <[label=]path>   Claude data directory to read; repeat for several accounts.
                         Default: ~/.claude, $CLAUDE_CONFIG_DIR and every ~/.claude-*
                         directory that has a projects/ folder
  --from <YYYY-MM-DD>    Initial start date for the dashboard (inclusive)
  --to <YYYY-MM-DD>      Initial end date for the dashboard (inclusive)
  --days <n>             Initial range: the last n days (overrides --from)
  --account <label>      Initial account filter
  --no-open              Don't auto-open browser
  --help, -h             Show this help message

Examples:
  npx claude-spend                                      Open dashboard in browser
  claude-spend --port 8080                              Use custom port
  claude-spend --dir work=~/.claude --dir personal=~/.claude-personal
  claude-spend --days 30                                Last 30 days
`);
  process.exit(0);
}

function fail(msg) {
  console.error('Error: ' + msg);
  process.exit(1);
}

// Supports "--flag value" and "--flag=value"; returns every occurrence
function flagValues(name) {
  const values = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) {
      if (i + 1 >= args.length) fail(`${name} needs a value`);
      values.push(args[++i]);
    } else if (args[i].startsWith(name + '=')) {
      values.push(args[i].slice(name.length + 1));
    }
  }
  return values;
}
const flagValue = name => flagValues(name).pop();

const port = parseInt(flagValue('--port') || '3456', 10);
const noOpen = args.includes('--no-open');
const dirs = flagValues('--dir');
let from = flagValue('--from');
const to = flagValue('--to');
const days = flagValue('--days');
const account = flagValue('--account');

if (isNaN(port)) fail('--port must be a number');
for (const [name, value] of [['--from', from], ['--to', to]]) {
  if (value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(`${name} must be a date like 2026-10-01`);
}
if (days) {
  const n = parseInt(days, 10);
  if (isNaN(n) || n < 1) fail('--days must be a positive number');
  const d = new Date();
  d.setDate(d.getDate() - (n - 1));
  const pad = x => String(x).padStart(2, '0');
  from = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const app = createServer({ dirs });

// Bind to loopback only: the dashboard exposes your prompts and session history
const server = app.listen(port, '127.0.0.1', async () => {
  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  if (account) params.set('account', account);
  const query = params.toString();
  const url = `http://localhost:${port}${query ? '/?' + query : ''}`;
  console.log(`\n  claude-spend dashboard running at ${url}\n`);

  if (!noOpen) {
    try {
      const open = (await import('open')).default;
      await open(url);
    } catch {
      console.log('  Could not auto-open browser. Open the URL manually.');
    }
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use. Try --port <other-port>`);
    process.exit(1);
  }
  throw err;
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n  Shutting down...');
  server.close();
  process.exit(0);
});
