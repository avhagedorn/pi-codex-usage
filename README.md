# pi-codex-usage

A Codex usage extension for [pi](https://pi.dev).

What it does:

- Shows your current ChatGPT Codex usage windows from the local Codex CLI app-server.
- Prints a compact transcript card with used/left percentages, reset times, plan, credits, and banked resets.
- Keeps itself hidden by default; nothing appears until you run a command.
- Can update a compact footer status on demand.
- Registers a `codex_usage` tool so the agent can answer usage-limit questions directly.

Example output:

```text
Codex usage — updated 7/9/2026, 11:08:00 PM
Plan: plus
5h limit:     [██████████░░] 82% used · 18% left · resets Fri, Jul 10, 2:28 AM (in 3h 21m)
Weekly limit: [██░░░░░░░░░░] 13% used · 87% left · resets Thu, Jul 16, 9:28 PM (in 7d)
Banked resets: 2 available, next expires Sun, Jul 26, 4:38 PM (in 17d)
```

## Requirements

- Codex CLI on `PATH`.
- Codex signed in with ChatGPT auth:

```bash
codex login
```

This extension calls:

```text
codex app-server --listen stdio://
account/rateLimits/read
```

If Codex auth is expired, run `codex login` or `codex logout && codex login` and retry.

## Install

```bash
pi install npm:pi-codex-usage
```

Or from GitHub:

```bash
pi install git:github.com/avhagedorn/pi-codex-usage
```

Or try it for one run:

```bash
pi -e git:github.com/avhagedorn/pi-codex-usage
```

Reload or restart pi after installing:

```text
/reload
```

## Commands

```text
/codex-usage          # fetch usage and print it into the transcript
/codex-usage status   # fetch usage and show compact footer status only
/codex-usage hide     # clear footer/widget leftovers
/codex-usage help     # show command help
```

By default the extension is hidden: it does not show a footer item or widget until you ask for usage.

## Agent tool

The package also registers a `codex_usage` tool. The agent should use it when you ask things like:

- “How much Codex usage do I have left?”
- “When does my 5h Codex window reset?”
- “What is my weekly Codex usage?”
- “Do I have banked resets or credits?”

## Notes

- The data is account-level Codex usage, not pi-session-specific usage.
- The Codex app-server protocol is experimental and may change in future Codex CLI releases.
- API-key-only Codex setups may not expose ChatGPT subscription usage windows.
