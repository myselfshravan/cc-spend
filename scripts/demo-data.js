#!/usr/bin/env node
// Writes synthetic Claude Code transcripts so the dashboard can be shown without real data
// (README screenshots, demos). Usage: node scripts/demo-data.js [outDir]

const fs = require('fs');
const os = require('os');
const path = require('path');

const outDir = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'cc-spend-demo'));
const DAYS = 60;

// Seeded PRNG so every run produces the same dataset
let seed = 42;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const between = (lo, hi) => Math.round(lo + rand() * (hi - lo));
const pick = list => list[Math.floor(rand() * list.length)];

const ACCOUNTS = {
  work: {
    projects: ['-Users-me-code-payments-api', '-Users-me-code-web-dashboard', '-Users-me-code-infra', '-Users-me-code-mobile-app'],
    models: ['claude-opus-5-5', 'claude-opus-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1'],
    sessionsPerDay: [1, 5],
  },
  personal: {
    projects: ['-Users-me-drone-firmware', '-Users-me-blog', '-Users-me-home-automation'],
    models: ['claude-sonnet-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'],
    sessionsPerDay: [0, 3],
  },
};

const PROMPTS = [
  'Add retry with exponential backoff to the webhook sender and cover it with tests',
  'Why is the checkout page re-rendering on every keystroke? Profile it and fix',
  'Migrate the user settings table to the new schema without downtime',
  'Write a script that backfills missing invoice totals from the ledger',
  'Refactor the auth middleware so token refresh happens in one place',
  'The CI build is flaky on the integration suite, find the race',
  'Add dark mode to the settings screen, following the existing tokens',
  'Review this PR for security issues before I merge it',
  'Explain how the scheduler picks the next job and where it can starve',
  'Port the image resize worker from Python to Go',
  'Set up structured logging with request ids across all services',
  'Draft the release notes for v3.2 from the merged PRs',
  'Make the telemetry parser handle truncated packets',
  'Tune the PID loop so the drone stops oscillating on yaw',
  'Write a blog post outline about running models on a Raspberry Pi',
  'Hook the porch light up to the motion sensor with a 2 minute timeout',
  'Find every place we still call the deprecated pricing endpoint',
  'Add pagination to the audit log API and update the client',
];
const FOLLOW_UPS = ['yes, go ahead', 'run the tests again', 'that broke the build, check the logs', 'looks good, commit it', 'can you simplify that?', 'now update the docs'];
const TOOLS = ['Read', 'Edit', 'Bash', 'Grep', 'Write', 'Task'];

function localDay(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(9, 0, 0, 0);
  return d;
}

let counter = 0;
const id = () => (++counter).toString(36).padStart(8, '0');

function session(start, model) {
  const rows = [];
  let t = start.getTime();
  const at = () => new Date((t += between(4, 90) * 1000)).toISOString();
  let context = between(12_000, 30_000);
  const turns = between(2, 18);

  for (let turn = 0; turn < turns; turn++) {
    const text = turn === 0 ? pick(PROMPTS) : pick(FOLLOW_UPS);
    rows.push({ type: 'user', uuid: id(), timestamp: at(), message: { role: 'user', content: text } });
    const calls = between(1, 9);
    for (let c = 0; c < calls; c++) {
      const write = between(1_500, 14_000);
      const msg = id();
      rows.push({
        type: 'assistant', requestId: 'req_' + msg, timestamp: at(),
        message: {
          id: 'msg_' + msg, model,
          content: c < calls - 1 ? [{ type: 'tool_use', name: pick(TOOLS) }] : [{ type: 'text', text: 'Done.' }],
          usage: {
            input_tokens: between(3, 60),
            output_tokens: between(150, 3_500),
            cache_read_input_tokens: context,
            cache_creation_input_tokens: write,
            cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: write },
          },
        },
      });
      context += write;
      if (c < calls - 1) {
        rows.push({ type: 'user', timestamp: at(), toolUseResult: {}, message: { role: 'user', content: [{ type: 'tool_result' }] } });
      }
    }
  }
  return rows;
}

fs.rmSync(outDir, { recursive: true, force: true });
for (const [account, cfg] of Object.entries(ACCOUNTS)) {
  for (let day = DAYS - 1; day >= 0; day--) {
    const weekend = [0, 6].includes(localDay(day).getDay());
    const count = between(cfg.sessionsPerDay[0], cfg.sessionsPerDay[1]) - (weekend && account === 'work' ? 2 : 0);
    for (let s = 0; s < count; s++) {
      const start = localDay(day);
      start.setMinutes(between(0, 600));
      const file = path.join(outDir, account, 'projects', pick(cfg.projects), `${id()}-${id()}.jsonl`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, session(start, pick(cfg.models)).map(r => JSON.stringify(r)).join('\n') + '\n');
    }
  }
}

console.log(`Demo data written to ${outDir}\n`);
console.log(`  node src/index.js --dir work=${path.join(outDir, 'work')} --dir personal=${path.join(outDir, 'personal')}\n`);
