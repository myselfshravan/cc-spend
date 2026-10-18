const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadUsage, buildReport, modelKey, getPricing } = require('../src/parser');

test('modelKey normalises current and legacy model ids', () => {
  assert.strictEqual(modelKey('claude-opus-5-5'), 'opus-5.5');
  assert.strictEqual(modelKey('claude-opus-5-5[1m]'), 'opus-5.5');
  assert.strictEqual(modelKey('claude-opus-5'), 'opus-5');
  assert.strictEqual(modelKey('claude-opus-4-20250514'), 'opus-4');
  assert.strictEqual(modelKey('claude-haiku-4-5-20251001'), 'haiku-4.5');
  assert.strictEqual(modelKey('claude-3-7-sonnet-20250219'), 'sonnet-3.7');
  assert.strictEqual(modelKey('claude-fable-5-1'), 'fable-5.1');
  assert.strictEqual(modelKey('glm-5.2'), null);
});

test('unknown models are unpriced instead of guessed', () => {
  assert.strictEqual(getPricing('glm-5.2', 0), null);
  assert.strictEqual(getPricing('claude-opus-9-9', 0), null);
  assert.ok(Math.abs(getPricing('claude-opus-5', 0).input * 1e6 - 5) < 1e-9);
});

test('Haiku 5.5 switches tier above 100K prompt tokens', () => {
  assert.ok(Math.abs(getPricing('claude-haiku-5-5', 100_000).input * 1e6 - 0.10) < 1e-9);
  assert.ok(Math.abs(getPricing('claude-haiku-5-5', 100_001).input * 1e6 - 0.50) < 1e-9);
});

function writeJSONL(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-spend-test-'));
  const project = path.join(root, '.claude', 'projects', '-home-me-app');
  const usage = (output) => ({
    input_tokens: 10,
    output_tokens: output,
    cache_read_input_tokens: 1_000_000,
    cache_creation_input_tokens: 1_000_000,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1_000_000 },
  });
  const assistant = (id, ts, output, content = []) => ({
    type: 'assistant', requestId: 'req_' + id, timestamp: ts,
    message: { id: 'msg_' + id, model: 'claude-opus-5', usage: usage(output), content },
  });
  writeJSONL(path.join(project, 'sess1.jsonl'), [
    { type: 'user', uuid: 'u1', timestamp: '2026-10-01T10:00:00Z', message: { role: 'user', content: 'build it' } },
    // One response streamed as three rows: partial output counts, then the final one
    assistant('a', '2026-10-01T10:00:01Z', 5, [{ type: 'text', text: 'ok' }]),
    assistant('a', '2026-10-01T10:00:02Z', 5, [{ type: 'tool_use', name: 'Bash' }]),
    assistant('a', '2026-10-01T10:00:03Z', 1_000_000, [{ type: 'tool_use', name: 'Task' }]),
    { type: 'user', timestamp: '2026-10-01T10:00:04Z', toolUseResult: {}, message: { role: 'user', content: [{ type: 'tool_result' }] } },
    assistant('b', '2026-10-03T10:00:05Z', 0),
  ]);
  writeJSONL(path.join(project, 'sess1', 'subagents', 'agent-x.jsonl'), [
    { type: 'user', timestamp: '2026-10-01T10:00:04Z', message: { role: 'user', content: 'subagent brief' } },
    assistant('c', '2026-10-01T10:00:04Z', 0),
  ]);
  // A resumed session that copied response "a" into its own file
  writeJSONL(path.join(project, 'sess2.jsonl'), [assistant('a', '2026-10-01T10:00:03Z', 1_000_000)]);
  return path.join(root, '.claude');
}

test('dedupes streamed copies, adds subagents to the parent turn, prices 1h writes', async () => {
  const usage = await loadUsage({ dirs: ['work=' + fixture()] });
  const report = buildReport(usage, {});
  assert.strictEqual(report.totals.totalSessions, 1);
  assert.strictEqual(report.totals.totalQueries, 3);
  // Opus 5 per query: 10 input, 1M 1h writes, 1M cache reads, output as streamed.
  // a: 10*5 + 1M*10 + 1M*0.5 + 1M*25 (per MTok) = $35.50005; b and c: $10.50005 each
  assert.ok(Math.abs(report.totals.totalCost - 56.50015) < 1e-6, report.totals.totalCost);
  assert.ok(Math.abs(report.totals.totalSubagentCost - 10.50005) < 1e-6);
  assert.strictEqual(report.topPrompts.length, 1);
  assert.strictEqual(report.topPrompts[0].prompt, 'build it');
  assert.strictEqual(report.sessions[0].queries[0].tools.join(','), 'Bash,Task');
  assert.strictEqual(report.filters.accounts[0], 'work');
});

test('date filter keeps only queries inside the range', async () => {
  const usage = await loadUsage({ dirs: [fixture()] });
  const report = buildReport(usage, { from: '2026-10-02', to: '2026-10-31' });
  assert.strictEqual(report.totals.totalQueries, 1);
  assert.deepStrictEqual(report.totals.dateRange, { from: '2026-10-03', to: '2026-10-03' });
  assert.deepStrictEqual(report.filters.availableRange, { from: '2026-10-01', to: '2026-10-03' });
});
