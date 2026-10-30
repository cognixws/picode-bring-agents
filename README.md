# Bring agents

A COGNIX[WS] extension that brings assistants you set up in **OpenClaw** or
**Hermes Agent** into COGNIX[WS]: their instructions, skills, notes and
scheduled tasks. It only reads the other app's files. COGNIX[WS] shows a
review of everything before it saves anything, and keys never come along.

## What it reads

| | OpenClaw | Hermes Agent |
|---|---|---|
| Where | `~/.openclaw` (and `~/.openclaw-<profile>`, `$OPENCLAW_STATE_DIR`) | `~/.hermes` (or `$HERMES_HOME`) and each `profiles/<name>` |
| Assistants | One per agent in `openclaw.json` (`agents.entries`, or the older `agents.list`) with a workspace folder | The home's persona, and one per profile with a `SOUL.md` |
| Instructions | `SOUL.md`, then `AGENTS.md` as operating instructions; the name from the config or `IDENTITY.md` | `SOUL.md` |
| Notes | `MEMORY.md` (facts) and `USER.md` (preferences) | `memories/MEMORY.md` and `memories/USER.md` |
| Skills | `skills/` shared by every agent (filtered by an agent's `skills` list) and each workspace's `skills/` | Your own skills under `skills/`. Skills Hermes ships, and skills from the Skills Hub, are listed, not copied |
| Scheduled tasks | The older `cron/jobs.json` (cron schedules) | `cron/jobs.json`: cron schedules, and intervals that divide an hour or a day |
| Connectors | `mcp.servers` | `mcp_servers` in `config.yaml` |
| Model | Shown in the review; COGNIX[WS] uses its own default | Same |

Left out, and listed in the review: secret files (`.env`, `auth*.json`,
keys, tokens), daily memory logs, one-off and script tasks, and OpenClaw's
newer task database (`state/openclaw.sqlite`, since OpenClaw 2026.9).
Connector keys never travel: each one becomes a slot you fill in the
assistant's Connectors.

## Use

1. Install it from Extensions in COGNIX[WS] and turn it on.
2. Open **Assistants ▸ All assistants ▸ Bring from another app**. What it
   finds on this computer is listed under *On this computer*; choose
   **Review**, or **Choose a folder…** for a copy somewhere else. A `.zip`
   of the other app's folder works too.
3. Untick what you do not want and choose **Bring**. Scheduled tasks
   arrive off.

## How it talks to COGNIX[WS]

It declares the `assistantImporter` door (manifest apiVersion 18). COGNIX[WS]
calls `GET /scan` and `POST /read` (`{source, path}`) on its process, with
its own secret header; the answer is a format 4 manifest that COGNIX[WS]
checks and redacts again. Node.js 20 or newer, no packages.

```bash
node --test test/*.test.mjs
```

Apache-2.0.
