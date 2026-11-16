# What My DSH does

The settings page has nine tabs: Overview, Interface, Usage & billing, Backups, Retry, Personalize, Capabilities, Remote access, About. Everything except Overview and About can be hidden from the Interface tab.

## Overview

Two questions in one screen: is anything wrong, and what has this cost lately. Range cards and a trend sit on top, subsystem status on the right, the enabled capability modules and three shortcuts below.

## Interface

Three groups:

1. **Brand and shell** — hide the New-session row, the sidebar mark, the sidebar wordmark (mark and text are separate switches), the sidebar toggle; move the sidebar account area into the title bar as an avatar only.
2. **List and density** — whether clicking the sidebar's Workspaces/Sessions button switches the list grouping, the default grouping, and three density levels.
3. **Entries** — which entry appears where. A disabled entry registers nothing at all, so it costs no render, no subscription and no poll.

## Usage & billing

- **Dashboard**: requests, total tokens, input, output, cache hit rate and token speed for the selected range, with a trend chart, a heat map and four rankings (provider / model / workspace / session).
- **Geek request metrics**: TTFT, decode speed and token count. The pill in the composer dock opens the recent-request table.
- **Context insight**: window occupancy with seven buckets, evolution per turn, and per-category drill-down.
- **Balance**: the DeepSeek endpoint, or a custom HTTP endpoint per provider read through dotted paths.
- **Budgets**: a cap per scope and period. At 90% the page warns; past the cap a pause budget refuses the next model request and names the reason, without cutting an answer that is already streaming.
- **Price table**: built-in prices for mainstream models, plus your own overrides marked as `override`.

## Backups

A status bar (running, 7z availability, last run, estimate) above five sections:

- **Items**: seven categories. Credentials are only collected when encryption is on; otherwise the run refuses them and says why.
- **Destinations**: several targets, one active. Each can be tested on its own.
- **Triggers**: daily, weekly, fixed interval, at startup, after a session, or manual only.
- **Type and compression**: full or incremental; zip, 7z or none; split size; retention count; per-file size cap.
- **Encryption**: AES-256-GCM. A wrong password or a tampered file fails loudly.
- **Sync**: aligns with the destination's backup index; conflicts resolve as newer, local or remote.
- **History**: every run, with failures in red and a reason.

## Retry

- **Rules**: match a status or error code, then retry, switch route, or fail. Attempts, delay and backoff are configurable.
- **Chain**: the provider/model order to try on failure.
- **Dry run**: feed a synthetic failure and see what the current rules would decide, without waiting for a real one.
- **Log**: recent attempts, retries, switches and failures.

## Personalize

Nickname, assistant name, reply style, standing instructions, persona, scope — plus two sub-features:

- **Long-term memory**: entries you curate, recalled by a deterministic keyword-and-recency score with no extra model call.
- **Discipline**: three nudges — claiming completion with no action, claiming completion with no verifiable evidence, and the same tool failing repeatedly.

The preview on the right shows exactly what would be injected, and whether the current session would receive it.

## Capabilities

Fourteen cards, each stating what it does, its risk level and whether this environment can run it. High-risk items ask for confirmation the first time. Expanding a card shows its own settings: desktop capabilities, the MCP server list with a connectivity test, image generation endpoint and size, custom roles, config-management permissions, and read-only skills and team views.

## Remote access

Enter the relay server address, register or sign in, then connect. Once connected this page shows the public URL, traffic counters and request counts. The relay server is yours to deploy (deployment steps ship with the plugin); the plugin never forwards your data to a third party.
