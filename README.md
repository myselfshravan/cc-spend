# claude-spend

See where your Claude Code tokens go. One command, zero setup.

## Problem

 I've been using Claude Code every day for 3 months. I hit the usage limit almost daily, but had zero visibility into which prompts were eating my tokens. So I built claude-spend. One command, zero setup. 

## How does it look


<img width="1910" height="966" alt="Screenshot 2026-02-18 092727" src="https://github.com/user-attachments/assets/11cc7149-d4dd-4e44-a3a0-0b48e935b7bc" />

<img width="1906" height="966" alt="Screenshot 2026-02-18 093529" src="https://github.com/user-attachments/assets/537c3611-5794-41d2-864e-e368e6949812" />

<img width="1908" height="969" alt="Screenshot 2026-02-18 093647" src="https://github.com/user-attachments/assets/aaaa8ce5-2025-407d-8596-ea1965748691" />

<img width="1908" height="969" alt="Screenshot 2026-02-18 093647" src="https://github.com/user-attachments/assets/a9fde5e2-6e52-4bae-9b96-03655109aef6" />



## Install

```
npx github:myselfshravan/claude-spend
```

That's it. Opens a dashboard in your browser.

This is a maintained fork of [writetoaniketparihar-collab/claude-spend](https://github.com/writetoaniketparihar-collab/claude-spend).
See [What this fork fixes](#what-this-fork-fixes).


## What it does

- Reads your local Claude Code session files (nothing leaves your machine)
- Shows token usage and API-equivalent cost per conversation, per day, and per model
- Filters by date range and by account when you run several Claude Code configs
- Surfaces insights like which prompts cost the most and usage patterns


## Options

```
claude-spend --port 8080                 # custom port (default: 3456)
claude-spend --no-open                   # don't auto-open browser
claude-spend --days 30                   # open on the last 30 days
claude-spend --from 2026-10-01 --to 2026-10-15
claude-spend --account personal          # open filtered to one account
claude-spend --dir work=~/.claude --dir personal=~/.claude-personal
```

By default it reads `~/.claude`, `$CLAUDE_CONFIG_DIR`, and every `~/.claude-*` directory
that has a `projects/` folder, so separate work and personal configs show up as separate
accounts. Use `--dir` (repeatable, optional `label=` prefix) to choose exactly which to read.
The date range and account can also be changed in the dashboard; the URL keeps the current view.


## What this fork fixes

- **Duplicate rows counted repeatedly.** Claude Code writes one response as several JSONL rows
  and copies rows into resumed sessions. Usage is now deduplicated by `requestId` + `message.id`,
  which removed more than half the rows on real data.
- **Current pricing.** Prices come from the official pricing page, including Opus 5.x,
  Sonnet 5.x, Haiku 5.5 (with its 100K-token prompt tier), and Fable 5.x. Models without
  a known price (other providers, new releases) are reported as unpriced instead of being
  billed as Opus 4.0.
- **1-hour cache writes** are priced at their own rate (2x base input) instead of the 5-minute rate.
- **Subagent transcripts** (`<session>/subagents/*.jsonl`) are included and attributed to the
  turn that started them.
- **Local timezone** for daily grouping instead of UTC.
- **Loopback only:** the server binds to `127.0.0.1`, not every network interface.
- Cost is shown on the dashboard: totals, a cost-per-day chart, and per-session and per-prompt cost.

Run the tests with `npm test`.


## Privacy

All data stays local. claude-spend reads your Claude Code data directories on your machine and serves a dashboard on 127.0.0.1. No data is sent anywhere.

## License

MIT
