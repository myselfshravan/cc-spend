const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

// Anthropic API pricing in USD per million tokens, from
// https://platform.claude.com/docs/en/about-claude/pricing (checked 2026-10-17).
// These are API-equivalent estimates. Claude Code subscription pricing differs.
// Columns: base input, 5-minute cache write, 1-hour cache write, cache read, output.
const PRICING_SOURCE = 'platform.claude.com pricing, checked 2026-10-17';
const rate = (input, cacheWrite5m, cacheWrite1h, cacheRead, output) => ({
  input: input / 1e6,
  cacheWrite5m: cacheWrite5m / 1e6,
  cacheWrite1h: cacheWrite1h / 1e6,
  cacheRead: cacheRead / 1e6,
  output: output / 1e6,
});
const MODEL_PRICING = {
  'fable-5.1': rate(10, 12.5, 20, 0.25, 50),
  'mythos-5.1': rate(10, 12.5, 20, 0.25, 50),
  'fable-5': rate(10, 12.5, 20, 1, 50),
  'mythos-5': rate(10, 12.5, 20, 1, 50),
  'opus-5.5': rate(4, 5, 8, 0.20, 20),
  'opus-5': rate(5, 6.25, 10, 0.50, 25),
  'opus-4.8': rate(5, 6.25, 10, 0.50, 25),
  'opus-4.7': rate(5, 6.25, 10, 0.50, 25),
  'opus-4.6': rate(5, 6.25, 10, 0.50, 25),
  'opus-4.5': rate(5, 6.25, 10, 0.50, 25),
  'opus-4.1': rate(15, 18.75, 30, 1.50, 75),
  'opus-4': rate(15, 18.75, 30, 1.50, 75),
  'opus-3': rate(15, 18.75, 30, 1.50, 75),
  'sonnet-5.5': rate(2, 2.5, 4, 0.10, 10),
  'sonnet-5': rate(2, 2.5, 4, 0.20, 10),
  'sonnet-4.6': rate(3, 3.75, 6, 0.30, 15),
  'sonnet-4.5': rate(3, 3.75, 6, 0.30, 15),
  'sonnet-4': rate(3, 3.75, 6, 0.30, 15),
  'sonnet-3.7': rate(3, 3.75, 6, 0.30, 15),
  'sonnet-3.5': rate(3, 3.75, 6, 0.30, 15),
  'haiku-4.5': rate(1, 1.25, 2, 0.10, 5),
  'haiku-3.5': rate(0.80, 1, 1.6, 0.08, 4),
  'haiku-3': rate(0.25, 0.30, 0.50, 0.03, 1.25),
};
// Haiku 5.5 is priced by prompt length: prompts over 100K tokens (counting cache
// reads and writes) are billed at the higher tier for the whole request.
const HAIKU_55_THRESHOLD = 100_000;
const HAIKU_55_SHORT = rate(0.10, 0.125, 0.20, 0.01, 0.50);
const HAIKU_55_LONG = rate(0.50, 0.625, 1, 0.05, 2.50);

// "claude-opus-5-5[1m]" -> "opus-5.5", "claude-haiku-4-5-20251001" -> "haiku-4.5",
// "claude-opus-4-20250514" -> "opus-4", "claude-3-7-sonnet-20250219" -> "sonnet-3.7".
function modelKey(model) {
  if (!model) return null;
  const m = model.toLowerCase().replace(/\[.*?\]$/, '');
  let match = m.match(/claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2}))?(?=$|-)/);
  if (match) return match[1] + '-' + match[2] + (match[3] ? '.' + match[3] : '');
  match = m.match(/claude-(\d+)(?:-(\d+))?-(opus|sonnet|haiku)/);
  if (match) return match[3] + '-' + match[1] + (match[2] ? '.' + match[2] : '');
  return null;
}

// Returns null when the model has no known price (non-Claude models, aliases, new releases).
function getPricing(model, promptTokens) {
  const key = modelKey(model);
  if (key === 'haiku-5.5') return promptTokens > HAIKU_55_THRESHOLD ? HAIKU_55_LONG : HAIKU_55_SHORT;
  return (key && MODEL_PRICING[key]) || null;
}

function priceQuery(q) {
  const pricing = getPricing(q.model, q.inputTokens + q.cacheCreationTokens + q.cacheReadTokens);
  if (!pricing) return { cost: 0, priced: false, cacheSavings: 0 };
  const write5m = q.cacheCreationTokens - q.cacheWrite1hTokens;
  const cost = (q.inputTokens * pricing.input)
    + (write5m * pricing.cacheWrite5m)
    + (q.cacheWrite1hTokens * pricing.cacheWrite1h)
    + (q.cacheReadTokens * pricing.cacheRead)
    + (q.outputTokens * pricing.output);
  return { cost, priced: true, cacheSavings: q.cacheReadTokens * (pricing.input - pricing.cacheRead) };
}

function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

// ".claude" -> "default", ".claude-personal" -> "personal"
function labelForDir(dir) {
  const base = path.basename(path.resolve(dir)).replace(/^\./, '');
  if (base === 'claude') return 'default';
  return base.replace(/^claude[-_]/, '') || base;
}

// Accepts "path" or "label=path". With no explicit dirs, reads ~/.claude, CLAUDE_CONFIG_DIR,
// and every ~/.claude-* directory that has a projects/ folder (e.g. ~/.claude-personal).
function resolveClaudeDirs(specs = []) {
  const out = [];
  const seen = new Set();
  const add = (dir, label) => {
    const resolved = path.resolve(expandHome(dir));
    let real = resolved;
    try { real = fs.realpathSync(resolved); } catch {}
    if (seen.has(real)) return;
    seen.add(real);
    out.push({ dir: resolved, label: label || labelForDir(resolved) });
  };

  if (specs.length) {
    for (const spec of specs) {
      const eq = spec.indexOf('=');
      if (eq > 0 && !/^[A-Za-z]:[\\/]/.test(spec)) add(spec.slice(eq + 1), spec.slice(0, eq));
      else add(spec);
    }
    return out;
  }

  if (process.env.CLAUDE_CONFIG_DIR) add(process.env.CLAUDE_CONFIG_DIR);
  add(path.join(os.homedir(), '.claude'));
  try {
    for (const name of fs.readdirSync(os.homedir()).sort()) {
      if (!name.startsWith('.claude-')) continue;
      const dir = path.join(os.homedir(), name);
      if (fs.existsSync(path.join(dir, 'projects'))) add(dir);
    }
  } catch {}
  return out;
}

async function parseJSONLFile(filePath) {
  const lines = [];
  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      lines.push(JSON.parse(line));
    } catch {
      // Skip malformed lines silently — user can't act on this
    }
  }
  return lines;
}

// Every .jsonl under a project dir, including <session-id>/subagents/agent-*.jsonl
function listJSONLFiles(dir) {
  const files = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue; // Skip directories we can't read
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(full);
    }
  }
  return files;
}

// Local calendar date (YYYY-MM-DD) in the machine's timezone, not UTC.
function localDate(timestamp) {
  const d = new Date(timestamp);
  if (isNaN(d)) return 'unknown';
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const NON_PROMPT_PREFIXES = [
  '<local-command', '<command-name', '<command-message', '<bash-input', '<bash-stdout',
  '<bash-stderr', '<task-notification', '<system-reminder', '[Request interrupted',
];

function userPromptText(entry) {
  if (entry.isMeta || entry.isCompactSummary || entry.isSidechain || entry.toolUseResult) return null;
  const content = entry.message.content;
  const text = typeof content === 'string'
    ? content.trim()
    : Array.isArray(content)
      ? content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim()
      : '';
  if (!text || NON_PROMPT_PREFIXES.some(p => text.startsWith(p))) return null;
  // Pasted blocks arrive wrapped in <pasted_content id="..."> tags; keep only the text
  return text.replace(/<\/?pasted_content[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() || null;
}

// Claude Code writes one assistant response as several JSONL rows (one per content block)
// that share requestId + message.id, and resumed sessions copy earlier rows into new files.
// `seen` maps that key to the query already recorded so copies are merged, not re-counted.
function extractQueries(entries, { isSubagent, seen }) {
  const queries = [];
  let pendingPrompt = null;

  for (const entry of entries) {
    if (entry.type === 'user' && entry.message?.role === 'user') {
      if (isSubagent) continue; // a subagent's "user" turn is its task brief, not your prompt
      const text = userPromptText(entry);
      if (text) pendingPrompt = { id: entry.uuid || entry.timestamp, text, timestamp: entry.timestamp };
      continue;
    }

    if (entry.type !== 'assistant' || !entry.message?.usage) continue;
    const model = entry.message.model || 'unknown';
    if (model === '<synthetic>') continue;

    const usage = entry.message.usage;
    const cacheCreation = usage.cache_creation_input_tokens || 0;
    const split = usage.cache_creation || {};
    const tokens = {
      inputTokens: usage.input_tokens || 0,
      cacheCreationTokens: cacheCreation,
      cacheWrite1hTokens: Math.min(cacheCreation, split.ephemeral_1h_input_tokens || 0),
      cacheReadTokens: usage.cache_read_input_tokens || 0,
      outputTokens: usage.output_tokens || 0,
    };
    const tools = [];
    if (Array.isArray(entry.message.content)) {
      for (const block of entry.message.content) {
        if (block.type === 'tool_use' && block.name) tools.push(block.name);
      }
    }

    const key = entry.message.id ? `${entry.requestId || ''}:${entry.message.id}` : null;
    const existing = key && seen.get(key);
    if (existing) {
      // Streaming copies carry partial output counts; keep the largest (final) value.
      for (const k of Object.keys(tokens)) existing[k] = Math.max(existing[k], tokens[k]);
      existing.tools.push(...tools);
      continue;
    }

    const query = {
      promptId: isSubagent ? null : pendingPrompt?.id || null,
      userPrompt: isSubagent ? null : pendingPrompt?.text || null,
      userTimestamp: isSubagent ? null : pendingPrompt?.timestamp || null,
      assistantTimestamp: entry.timestamp,
      date: entry.timestamp ? localDate(entry.timestamp) : 'unknown',
      model,
      isSubagent,
      ...tokens,
      tools,
    };
    if (key) seen.set(key, query);
    queries.push(query);
  }

  return queries;
}

// Reads every configured Claude data directory once. The result is filtered and
// aggregated per request by buildReport().
async function loadUsage({ dirs } = {}) {
  const sources = resolveClaudeDirs(dirs);
  const warnings = [];
  const sessionMap = new Map();
  const seen = new Map();

  for (const { dir, label } of sources) {
    const projectsDir = path.join(dir, 'projects');
    if (!fs.existsSync(projectsDir)) {
      warnings.push({ type: 'missing-dir', message: `No Claude Code project data found in ${dir}.` });
      continue;
    }

    // history.jsonl gives the prompt text as you typed it
    const historyPath = path.join(dir, 'history.jsonl');
    const historyEntries = fs.existsSync(historyPath) ? await parseJSONLFile(historyPath) : [];
    const sessionFirstPrompt = {};
    for (const entry of historyEntries) {
      if (entry.sessionId && entry.display && !sessionFirstPrompt[entry.sessionId]) {
        const display = entry.display.trim();
        if (display.startsWith('/') && display.length < 30) continue;
        sessionFirstPrompt[entry.sessionId] = display;
      }
    }

    let projectDirs = [];
    try {
      projectDirs = fs.readdirSync(projectsDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
    } catch {}

    for (const projectDir of projectDirs) {
      const root = path.join(projectsDir, projectDir);
      // Main transcripts first, so a response copied into a subagent or resumed
      // session stays attributed to the session that produced it.
      const files = listJSONLFiles(root).sort((a, b) => a.split(path.sep).length - b.split(path.sep).length || a.localeCompare(b));

      for (const filePath of files) {
        const rel = path.relative(root, filePath).split(path.sep);
        const isSubagent = rel.length > 1;
        const sessionId = isSubagent ? rel[0] : path.basename(filePath, '.jsonl');

        let entries;
        try {
          entries = await parseJSONLFile(filePath);
        } catch {
          continue;
        }
        if (entries.length === 0) continue;

        const queries = extractQueries(entries, { isSubagent, seen });
        if (queries.length === 0) continue;

        const mapKey = label + ':' + sessionId;
        if (!sessionMap.has(mapKey)) {
          sessionMap.set(mapKey, {
            sessionId,
            account: label,
            project: projectDir,
            historyPrompt: sessionFirstPrompt[sessionId] || null,
            queries: [],
          });
        }
        sessionMap.get(mapKey).queries.push(...queries);
      }
    }
  }

  const sessions = [];
  for (const session of sessionMap.values()) {
    session.queries.sort((a, b) => (a.assistantTimestamp || '').localeCompare(b.assistantTimestamp || ''));
    // Mark only the first response to each prompt as the turn start; tool loops and
    // subagent work that follow belong to the same turn.
    let lastPromptId = null;
    for (const q of session.queries) {
      Object.assign(q, priceQuery(q));
      q.totalTokens = q.inputTokens + q.cacheCreationTokens + q.cacheReadTokens + q.outputTokens;
      q.tools = [...new Set(q.tools)];
      if (q.promptId && q.promptId !== lastPromptId) {
        lastPromptId = q.promptId;
      } else {
        q.userPrompt = null;
      }
      delete q.promptId;
    }
    sessions.push(session);
  }

  return { sources, sessions, warnings };
}

function emptyTokens() {
  return { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheWrite1hTokens: 0, cacheReadTokens: 0, totalTokens: 0, cost: 0 };
}

function addTokens(target, q) {
  target.inputTokens += q.inputTokens;
  target.outputTokens += q.outputTokens;
  target.cacheCreationTokens += q.cacheCreationTokens;
  target.cacheWrite1hTokens += q.cacheWrite1hTokens;
  target.cacheReadTokens += q.cacheReadTokens;
  target.totalTokens += q.totalTokens;
  target.cost += q.cost;
}

// Filters the loaded usage to a date range (inclusive, local YYYY-MM-DD) and account,
// then builds everything the dashboard renders.
function buildReport(usage, { from, to, account } = {}) {
  const warnings = [...usage.warnings];
  const accounts = usage.sources.map(s => s.label);
  const inRange = q => q.date !== 'unknown' && (!from || q.date >= from) && (!to || q.date <= to);

  let minDate = null, maxDate = null;
  for (const s of usage.sessions) {
    for (const q of s.queries) {
      if (q.date === 'unknown') continue;
      if (!minDate || q.date < minDate) minDate = q.date;
      if (!maxDate || q.date > maxDate) maxDate = q.date;
    }
  }

  const sessions = [];
  const dailyMap = {};
  const modelMap = {};
  const unpricedMap = {};
  const allPrompts = []; // for "most expensive prompts" across all sessions
  let totalSaved = 0;

  for (const source of usage.sessions) {
    if (account && account !== 'all' && source.account !== account) continue;
    const queries = source.queries.filter(inRange);
    if (queries.length === 0) continue;

    const totals = emptyTokens();
    let subagentCost = 0;
    const modelCounts = {};
    for (const q of queries) {
      addTokens(totals, q);
      totalSaved += q.cacheSavings;
      if (q.isSubagent) subagentCost += q.cost;
      modelCounts[q.model] = (modelCounts[q.model] || 0) + 1;

      if (!dailyMap[q.date]) dailyMap[q.date] = { date: q.date, ...emptyTokens(), sessions: new Set(), queries: 0 };
      addTokens(dailyMap[q.date], q);
      dailyMap[q.date].sessions.add(source.account + ':' + source.sessionId);
      dailyMap[q.date].queries += 1;

      if (!modelMap[q.model]) modelMap[q.model] = { model: q.model, ...emptyTokens(), queryCount: 0, priced: q.priced };
      addTokens(modelMap[q.model], q);
      modelMap[q.model].queryCount += 1;

      if (!q.priced) unpricedMap[q.model] = (unpricedMap[q.model] || 0) + q.totalTokens;
    }

    const primaryModel = Object.entries(modelCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'unknown';
    const date = queries[0].date;
    // history.jsonl shows pastes as "[Pasted text #1 +26 lines]"; prefer the real text then
    const historyPrompt = source.historyPrompt && !/^\[Pasted text #\d+/.test(source.historyPrompt) ? source.historyPrompt : null;
    const firstPrompt = historyPrompt
      || source.queries.find(q => q.userPrompt)?.userPrompt
      || source.historyPrompt
      || '(no prompt)';

    // Group each turn (your prompt + every tool call and subagent run it caused)
    let current = null;
    const flushPrompt = () => {
      if (current && current.totalTokens > 0) allPrompts.push(current);
    };
    for (const q of queries) {
      if (q.userPrompt) {
        flushPrompt();
        current = {
          prompt: q.userPrompt.substring(0, 300),
          ...emptyTokens(),
          date: q.date,
          sessionId: source.sessionId,
          account: source.account,
          model: primaryModel,
        };
      }
      if (current) addTokens(current, q);
    }
    flushPrompt();

    sessions.push({
      sessionId: source.sessionId,
      account: source.account,
      project: source.project,
      date,
      timestamp: queries[0].assistantTimestamp,
      firstPrompt: firstPrompt.substring(0, 200),
      model: primaryModel,
      queryCount: queries.length,
      queries,
      subagentCost,
      ...totals,
    });
  }

  sessions.sort((a, b) => b.totalTokens - a.totalTokens);

  // Per-project aggregation
  const projectMap = {};
  for (const session of sessions) {
    const proj = session.project;
    if (!projectMap[proj]) {
      projectMap[proj] = { project: proj, ...emptyTokens(), sessionCount: 0, queryCount: 0, modelMap: {}, allPrompts: [] };
    }
    const p = projectMap[proj];
    p.inputTokens += session.inputTokens;
    p.outputTokens += session.outputTokens;
    p.totalTokens += session.totalTokens;
    p.cost += session.cost;
    p.sessionCount += 1;
    p.queryCount += session.queryCount;

    for (const q of session.queries) {
      if (!p.modelMap[q.model]) {
        p.modelMap[q.model] = { model: q.model, inputTokens: 0, outputTokens: 0, totalTokens: 0, queryCount: 0 };
      }
      const m = p.modelMap[q.model];
      m.inputTokens += q.inputTokens;
      m.outputTokens += q.outputTokens;
      m.totalTokens += q.totalTokens;
      m.queryCount += 1;
    }

    // Per-project prompt grouping with tool tracking
    let cur = null;
    const flushProjectPrompt = () => {
      if (cur && (cur.inputTokens + cur.outputTokens) > 0) {
        cur.model = Object.entries(cur.models).sort((a, b) => b[1] - a[1])[0]?.[0] || session.model;
        delete cur.models;
        p.allPrompts.push(cur);
      }
    };
    for (const q of session.queries) {
      if (q.userPrompt) {
        flushProjectPrompt();
        cur = {
          prompt: q.userPrompt.substring(0, 300),
          inputTokens: 0, outputTokens: 0, totalTokens: 0, continuations: -1,
          models: {}, toolCounts: {},
          date: q.date, sessionId: session.sessionId,
        };
      }
      if (!cur) continue;
      cur.continuations++;
      cur.inputTokens += q.inputTokens;
      cur.outputTokens += q.outputTokens;
      cur.totalTokens += q.inputTokens + q.outputTokens;
      cur.models[q.model] = (cur.models[q.model] || 0) + 1;
      for (const t of q.tools || []) cur.toolCounts[t] = (cur.toolCounts[t] || 0) + 1;
    }
    flushProjectPrompt();
  }

  const projectBreakdown = Object.values(projectMap).map(p => ({
    project: p.project,
    inputTokens: p.inputTokens,
    outputTokens: p.outputTokens,
    totalTokens: p.totalTokens,
    cost: p.cost,
    sessionCount: p.sessionCount,
    queryCount: p.queryCount,
    modelBreakdown: Object.values(p.modelMap).sort((a, b) => b.totalTokens - a.totalTokens),
    topPrompts: p.allPrompts.sort((a, b) => b.totalTokens - a.totalTokens).slice(0, 10),
  })).sort((a, b) => b.totalTokens - a.totalTokens);

  const dailyUsage = Object.values(dailyMap)
    .map(d => ({ ...d, sessions: d.sessions.size }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // Top 20 most expensive individual prompts (by cost; tokens break ties and order unpriced turns)
  allPrompts.sort((a, b) => (b.cost - a.cost) || (b.totalTokens - a.totalTokens));
  const topPrompts = allPrompts.slice(0, 20);

  const sum = key => sessions.reduce((s, x) => s + x[key], 0);
  const totalCacheReadTokens = sum('cacheReadTokens');
  const totalAllInput = sum('inputTokens') + sum('cacheCreationTokens') + totalCacheReadTokens;
  const unpricedTokens = Object.values(unpricedMap).reduce((a, b) => a + b, 0);

  const grandTotals = {
    totalSessions: sessions.length,
    totalQueries: sum('queryCount'),
    totalTokens: sum('totalTokens'),
    totalInputTokens: sum('inputTokens'),
    totalOutputTokens: sum('outputTokens'),
    totalCacheCreationTokens: sum('cacheCreationTokens'),
    totalCacheWrite1hTokens: sum('cacheWrite1hTokens'),
    totalCacheReadTokens,
    totalCost: sum('cost'),
    totalSubagentCost: sum('subagentCost'),
    totalSaved,
    unpricedTokens,
    cacheHitRate: totalAllInput > 0 ? totalCacheReadTokens / totalAllInput : 0,
    avgTokensPerQuery: 0,
    avgTokensPerSession: 0,
    dateRange: dailyUsage.length > 0
      ? { from: dailyUsage[0].date, to: dailyUsage[dailyUsage.length - 1].date }
      : null,
  };
  if (grandTotals.totalQueries > 0) {
    grandTotals.avgTokensPerQuery = Math.round(grandTotals.totalTokens / grandTotals.totalQueries);
  }
  if (grandTotals.totalSessions > 0) {
    grandTotals.avgTokensPerSession = Math.round(grandTotals.totalTokens / grandTotals.totalSessions);
  }

  if (unpricedTokens > 0) {
    const list = Object.entries(unpricedMap).sort((a, b) => b[1] - a[1]).map(([m, t]) => `${m} (${fmt(t)})`).join(', ');
    warnings.push({
      type: 'unpriced-models',
      message: `${fmt(unpricedTokens)} tokens came from models without a known Anthropic price and are left out of cost: ${list}.`,
    });
  }

  return {
    sessions,
    dailyUsage,
    modelBreakdown: Object.values(modelMap),
    projectBreakdown,
    topPrompts,
    totals: grandTotals,
    insights: generateInsights(sessions, allPrompts, grandTotals),
    warnings,
    filters: {
      from: from || null,
      to: to || null,
      account: account && account !== 'all' ? account : 'all',
      accounts,
      sources: usage.sources,
      availableRange: minDate ? { from: minDate, to: maxDate } : null,
      pricingSource: PRICING_SOURCE,
    },
  };
}

// The per-turn rows for one session, for the drill-down view.
function sessionQueries(usage, { sessionId, account, from, to } = {}) {
  const session = usage.sessions.find(s => s.sessionId === sessionId && (!account || s.account === account));
  if (!session) return null;
  return session.queries.filter(q => q.date !== 'unknown' && (!from || q.date >= from) && (!to || q.date <= to));
}

async function parseAllSessions(options = {}) {
  return buildReport(await loadUsage(options), options);
}

function generateInsights(sessions, allPrompts, totals) {
  const insights = [];

  // 1. Short replies that kicked off expensive turns
  const shortExpensive = allPrompts.filter(p => p.prompt.trim().length < 30 && p.totalTokens > 100_000);
  if (shortExpensive.length > 0) {
    const totalWasted = shortExpensive.reduce((s, p) => s + p.totalTokens, 0);
    const examples = [...new Set(shortExpensive.map(p => p.prompt.trim()))].slice(0, 4);
    insights.push({
      id: 'vague-prompts',
      type: 'warning',
      title: 'Short replies kicked off some of your most expensive turns',
      description: `${shortExpensive.length} times a short message like ${examples.map(e => '"' + e + '"').join(', ')} started a turn that used at least 100K tokens. Across all ${shortExpensive.length}, that adds up to ${fmt(totalWasted)} tokens. Usually the message itself isn't the problem: a "yes" that approves a big plan pays for all the tool calls and subagent work that follow, and every one of those calls re-reads the conversation so far.`,
      action: 'Open these turns in the session view to see where the tokens went. If a long conversation precedes the approval, starting the execution in a fresh session with the plan pasted in is usually cheaper.',
    });
  }

  // 2. Long conversations getting more expensive over time
  const longSessions = sessions.filter(s => s.queries.length > 50);
  if (longSessions.length > 0) {
    const growthData = longSessions.map(s => {
      const first5 = s.queries.slice(0, 5).reduce((sum, q) => sum + q.totalTokens, 0) / Math.min(5, s.queries.length);
      const last5 = s.queries.slice(-5).reduce((sum, q) => sum + q.totalTokens, 0) / Math.min(5, s.queries.length);
      return { session: s, first5, last5, ratio: last5 / Math.max(first5, 1) };
    }).filter(g => g.ratio > 2);

    if (growthData.length > 0) {
      const avgGrowth = (growthData.reduce((s, g) => s + g.ratio, 0) / growthData.length).toFixed(1);
      const worstSession = growthData.sort((a, b) => b.ratio - a.ratio)[0];
      insights.push({
        id: 'context-growth',
        type: 'warning',
        title: 'The longer you chat, the more each message costs',
        description: `In ${growthData.length} of your conversations, the messages near the end cost ${avgGrowth}x more than the ones at the start. Why? Every time you send a message, Claude re-reads the entire conversation from the beginning. So message #5 is cheap, but message #80 is expensive because Claude is re-reading 79 previous messages plus all the code it wrote. Your longest conversation ("${worstSession.session.firstPrompt.substring(0, 50)}...") grew ${worstSession.ratio.toFixed(1)}x more expensive by the end.`,
        action: 'Start a fresh conversation when you move to a new task. If you need context from before, paste a short summary in your first message. This gives Claude a clean slate instead of re-reading hundreds of old messages.',
      });
    }
  }

  // 3. Marathon conversations
  const turnCounts = sessions.map(s => s.queryCount);
  const medianTurns = turnCounts.sort((a, b) => a - b)[Math.floor(turnCounts.length / 2)] || 0;
  const longCount = sessions.filter(s => s.queryCount > 200).length;
  if (longCount >= 3) {
    const longTokens = sessions.filter(s => s.queryCount > 200).reduce((s, ses) => s + ses.totalTokens, 0);
    const longPct = ((longTokens / Math.max(totals.totalTokens, 1)) * 100).toFixed(0);
    insights.push({
      id: 'marathon-sessions',
      type: 'info',
      title: `Just ${longCount} long conversations used ${longPct}% of all your tokens`,
      description: `You have ${longCount} conversations with over 200 messages each. These alone consumed ${fmt(longTokens)} tokens -- that's ${longPct}% of everything. Meanwhile, your typical conversation is about ${medianTurns} messages. Long conversations aren't always bad, but they're disproportionately expensive because of how context builds up.`,
      action: 'Try keeping one conversation per task. When a conversation starts drifting into different topics, that is a good time to start a new one.',
    });
  }

  // 4. Most tokens are re-reading, not writing
  if (totals.totalTokens > 0) {
    const outputPct = (totals.totalOutputTokens / totals.totalTokens) * 100;
    if (outputPct < 2) {
      insights.push({
        id: 'input-heavy',
        type: 'info',
        title: `${outputPct.toFixed(1)}% of your tokens are Claude actually writing`,
        description: `Here's something surprising: out of ${fmt(totals.totalTokens)} total tokens, only ${fmt(totals.totalOutputTokens)} are from Claude writing responses. The other ${(100 - outputPct).toFixed(1)}% is Claude re-reading your conversation history, files, and context before each response. This means the biggest factor in token usage isn't how much Claude writes -- it's how long your conversations are.`,
        action: 'Keeping conversations shorter has more impact than asking for shorter answers. A 20-message conversation costs far less than a 200-message one, even if the total output is similar.',
      });
    }
  }

  // 5. Day-of-week pattern
  if (sessions.length >= 10) {
    const dayOfWeekMap = {};
    for (const s of sessions) {
      if (!s.timestamp) continue;
      const d = new Date(s.timestamp);
      const day = d.getDay();
      if (!dayOfWeekMap[day]) dayOfWeekMap[day] = { tokens: 0, sessions: 0 };
      dayOfWeekMap[day].tokens += s.totalTokens;
      dayOfWeekMap[day].sessions += 1;
    }
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const days = Object.entries(dayOfWeekMap).map(([d, v]) => ({ day: dayNames[d], ...v, avg: v.tokens / v.sessions }));
    if (days.length >= 3) {
      days.sort((a, b) => b.avg - a.avg);
      const busiest = days[0];
      const quietest = days[days.length - 1];
      insights.push({
        id: 'day-pattern',
        type: 'neutral',
        title: `You use Claude the most on ${busiest.day}s`,
        description: `Your ${busiest.day} conversations average ${fmt(Math.round(busiest.avg))} tokens each, compared to ${fmt(Math.round(quietest.avg))} on ${quietest.day}s. This could mean you tackle bigger tasks on ${busiest.day}s, or your conversations tend to run longer.`,
        action: null,
      });
    }
  }

  // 6. Model mismatch -- Opus used for simple conversations
  const opusSessions = sessions.filter(s => s.model.includes('opus'));
  if (opusSessions.length > 0) {
    const simpleOpus = opusSessions.filter(s => s.queryCount < 10 && s.totalTokens < 200_000);
    if (simpleOpus.length >= 3) {
      const wastedTokens = simpleOpus.reduce((s, ses) => s + ses.totalTokens, 0);
      const examples = simpleOpus.slice(0, 3).map(s => '"' + s.firstPrompt.substring(0, 40) + '"').join(', ');
      insights.push({
        id: 'model-mismatch',
        type: 'warning',
        title: `${simpleOpus.length} simple conversations used Opus unnecessarily`,
        description: `These conversations had fewer than 10 messages and used ${fmt(wastedTokens)} tokens on Opus: ${examples}. Opus is the most capable model but also the most expensive. For quick questions and small tasks, Sonnet or Haiku would give similar results at a fraction of the cost.`,
        action: 'Use /model to switch to Sonnet or Haiku for simple tasks. Save Opus for complex multi-file changes, architecture decisions, or tricky debugging.',
      });
    }
  }

  // 7. Tool-heavy conversations
  if (sessions.length >= 5) {
    const toolHeavy = sessions.filter(s => {
      const userMessages = s.queries.filter(q => q.userPrompt).length;
      const toolCalls = s.queryCount - userMessages;
      return userMessages > 0 && toolCalls > userMessages * 3;
    });
    if (toolHeavy.length >= 3) {
      const totalToolTokens = toolHeavy.reduce((s, ses) => s + ses.totalTokens, 0);
      const avgRatio = toolHeavy.reduce((s, ses) => {
        const userMsgs = ses.queries.filter(q => q.userPrompt).length;
        return s + (ses.queryCount - userMsgs) / Math.max(userMsgs, 1);
      }, 0) / toolHeavy.length;
      insights.push({
        id: 'tool-heavy',
        type: 'info',
        title: `${toolHeavy.length} conversations had ${Math.round(avgRatio)}x more tool calls than messages`,
        description: `In these conversations, Claude made ~${Math.round(avgRatio)} tool calls for every message you sent. Each tool call (reading files, running commands, searching code) is a full round trip that re-reads the entire conversation. These ${toolHeavy.length} conversations used ${fmt(totalToolTokens)} tokens total.`,
        action: 'Point Claude to specific files and line numbers when you can. "Fix the bug in src/auth.js line 42" triggers fewer tool calls than "fix the login bug" where Claude has to search for the right file first.',
      });
    }
  }

  // 8. One project dominates usage
  if (sessions.length >= 5) {
    const projectTokens = {};
    for (const s of sessions) {
      const proj = s.project || 'unknown';
      projectTokens[proj] = (projectTokens[proj] || 0) + s.totalTokens;
    }
    const sorted = Object.entries(projectTokens).sort((a, b) => b[1] - a[1]);
    if (sorted.length >= 2) {
      const [topProject, topTokens] = sorted[0];
      const pct = ((topTokens / Math.max(totals.totalTokens, 1)) * 100).toFixed(0);
      if (pct >= 60) {
        const projName = topProject.replace(/^C--Users-[^-]+-?/, '').replace(/^Projects-?/, '').replace(/-/g, '/') || '~';
        insights.push({
          id: 'project-dominance',
          type: 'info',
          title: `${pct}% of your tokens went to one project: ${projName}`,
          description: `Your "${projName}" project used ${fmt(topTokens)} tokens out of ${fmt(totals.totalTokens)} total. That is ${pct}% of all your usage. The next closest project used ${fmt(sorted[1][1])} tokens.`,
          action: 'Not necessarily a problem, but worth knowing. If this project has long-running conversations, breaking them into smaller sessions could reduce its footprint.',
        });
      }
    }
  }

  // 9. Conversation efficiency -- short vs long conversations cost per message
  if (sessions.length >= 10) {
    const shortSessions = sessions.filter(s => s.queryCount >= 3 && s.queryCount <= 15);
    const longSessions2 = sessions.filter(s => s.queryCount > 80);
    if (shortSessions.length >= 3 && longSessions2.length >= 2) {
      const shortAvg = Math.round(shortSessions.reduce((s, ses) => s + ses.totalTokens / ses.queryCount, 0) / shortSessions.length);
      const longAvg = Math.round(longSessions2.reduce((s, ses) => s + ses.totalTokens / ses.queryCount, 0) / longSessions2.length);
      const ratio = (longAvg / Math.max(shortAvg, 1)).toFixed(1);
      if (ratio >= 2) {
        insights.push({
          id: 'conversation-efficiency',
          type: 'warning',
          title: `Each message costs ${ratio}x more in long conversations`,
          description: `In your short conversations (under 15 messages), each message costs ~${fmt(shortAvg)} tokens. In your long ones (80+ messages), each message costs ~${fmt(longAvg)} tokens. That is ${ratio}x more per message, because Claude re-reads the entire history every turn.`,
          action: 'This is the single biggest lever for reducing token usage. Start fresh conversations more often. A 5-conversation workflow costs far less than one 500-message marathon.',
        });
      }
    }
  }

  // 10. Heavy context on first message (large CLAUDE.md or system prompts)
  if (sessions.length >= 5) {
    const heavyStarts = sessions.filter(s => {
      const firstQuery = s.queries[0];
      return firstQuery && firstQuery.inputTokens > 50_000;
    });
    if (heavyStarts.length >= 5) {
      const avgStartTokens = Math.round(heavyStarts.reduce((s, ses) => s + ses.queries[0].inputTokens, 0) / heavyStarts.length);
      const totalOverhead = heavyStarts.reduce((s, ses) => s + ses.queries[0].inputTokens, 0);
      insights.push({
        id: 'heavy-context',
        type: 'info',
        title: `${heavyStarts.length} conversations started with ${fmt(avgStartTokens)}+ tokens of context`,
        description: `Before you even type your first message, Claude reads your CLAUDE.md, project files, and system context. In ${heavyStarts.length} conversations, this starting context averaged ${fmt(avgStartTokens)} tokens. Across all of them, that is ${fmt(totalOverhead)} tokens just on setup -- and this context gets re-read with every message.`,
        action: 'Keep your CLAUDE.md files concise. Remove sections you rarely need. A smaller starting context compounds into savings across every message in the conversation.',
      });
    }
  }

  // 11. Cache efficiency
  if (totals.totalCacheReadTokens > 0) {
    const saved = totals.totalSaved;
    const hitRate = (totals.cacheHitRate * 100).toFixed(1);
    const withoutCaching = totals.totalCost + saved;
    insights.push({
      id: 'cache-savings',
      type: 'info',
      title: `Caching saved you an estimated $${saved.toFixed(2)}`,
      description: `Your cache hit rate is ${hitRate}% -- meaning ${hitRate}% of all input tokens were served from cache at a fraction of the input price (10x to 40x cheaper, depending on the model). Without caching, your estimated API-equivalent bill would be $${withoutCaching.toFixed(2)} instead of $${totals.totalCost.toFixed(2)}. Cache reads happen when Claude re-reads parts of the conversation that haven't changed since the last turn.`,
      action: 'Caching works best in longer conversations where context stays stable. Shorter sessions mean less cache reuse but also less context growth. The sweet spot is medium-length focused sessions on a single task.',
    });
  }

  // 12. Smart /clear suggestion based on inflection points
  const qualifyingSessions = sessions.filter(s => s.queries.length >= 10);
  if (qualifyingSessions.length >= 3) {
    const inflections = [];
    for (const s of qualifyingSessions) {
      const queries = s.queries;
      // Compute baseline: avg cost of first 5 turns
      const baselineSlice = queries.slice(0, 5);
      const baselineCost = baselineSlice.reduce((sum, q) => sum + q.cost, 0) / baselineSlice.length;
      if (baselineCost <= 0) continue;

      // Find inflection: rolling 3-turn avg exceeds 2x baseline
      let inflectionTurn = null;
      for (let i = 2; i < queries.length; i++) {
        const windowCost = (queries[i].cost + queries[i - 1].cost + queries[i - 2].cost) / 3;
        if (windowCost > baselineCost * 2) {
          inflectionTurn = i - 1; // 0-indexed turn where it starts
          break;
        }
      }
      if (inflectionTurn !== null) {
        const laterCost = queries.slice(inflectionTurn).reduce((s, q) => s + q.cost, 0) / (queries.length - inflectionTurn);
        inflections.push({ turn: inflectionTurn, multiplier: laterCost / baselineCost });
      }
    }

    if (inflections.length >= 2) {
      // Median inflection turn
      inflections.sort((a, b) => a.turn - b.turn);
      const medianTurn = inflections[Math.floor(inflections.length / 2)].turn;
      const avgMultiplier = (inflections.reduce((s, inf) => s + inf.multiplier, 0) / inflections.length).toFixed(1);

      insights.push({
        id: 'smart-clear',
        type: 'warning',
        title: `Use /clear after ~${medianTurn} turns to save tokens`,
        description: `Across ${inflections.length} conversations, messages started costing ${avgMultiplier}x more after turn ${medianTurn}. This happens because Claude re-reads the entire conversation history each turn, and the cost compounds as context grows.`,
        action: `Try using /clear after about ${medianTurn} turns. Before clearing, paste a brief summary of what you were working on so Claude has context for the next message. You can also use CONTEXT.md for handoff notes between conversations.`,
      });
    }
  }

  return insights;
}

function fmt(n) {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + 'B';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 10_000) return (n / 1_000).toFixed(0) + 'K';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toLocaleString();
}

module.exports = { parseAllSessions, loadUsage, buildReport, sessionQueries, resolveClaudeDirs, modelKey, getPricing };
