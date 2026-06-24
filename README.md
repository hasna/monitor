# open-monitor

> System monitor for AI agents and humans — watch multiple machines, detect problems, take action.

[![npm](https://img.shields.io/npm/v/@hasna/monitor)](https://www.npmjs.com/package/@hasna/monitor)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/runtime-bun-f9f1e1)](https://bun.sh)

## Features

- 🖥️ **Multi-machine** — monitor local, SSH, and EC2 machines from one place
- 📊 **Metrics** — CPU, memory, disk, GPU, load average, uptime, processes
- 🤖 **MCP server** — AI agents can query health, kill processes, manage cron jobs, and run doctor checks
- 🔍 **Doctor** — built-in health checks with actionable diagnostics and auto-remediation
- 💀 **Process manager** — detect zombies and orphans, smart kill policy with signal selection and safe list
- 📦 **Container monitoring** — inspect Docker/Podman/Nerdctl containers, resource usage, and logs
- 🚪 **Port scanner** — see which TCP/UDP ports are listening on one machine or across the fleet
- 🔄 **Cron jobs** — schedule actions per machine with full cron syntax
- 📨 **Fleet reports** — generate daily/weekly health summaries and deliver them via open-conversations or open-emails
- 🌐 **Web dashboard** — dark-themed real-time gauges served at `http://localhost:3848` (like NVIDIA DGX Dashboard)
- 🔎 **Full-text search** — search across machines, alerts, and processes
- 🔗 **Integrations** — open-todos, open-conversations, open-mementos, open-emails
- 💾 **SQLite by default** — zero-config persistence; optional PostgreSQL for production
- 🐚 **Shell completions** — zsh and bash completions included

## Install

```bash
bun install -g @hasna/monitor
```

Or with npm:

```bash
npm install -g @hasna/monitor
```

## Published entrypoints

After a global install, `@hasna/monitor` exposes four npm binaries:

| Binary | Description |
|--------|-------------|
| `monitor` | Main CLI for machines, metrics, doctor, cron, and integrations |
| `monitor-mcp` | MCP server for AI agents (stdio or HTTP) |
| `monitor-server` | Standalone REST API server (default port `3847`, SSE at `/api/stream`) |
| `monitor-web` | Standalone Vite web dashboard dev server (default port `3848`) |

Start the API and dashboard separately:

```bash
monitor-server
# REST API: http://localhost:3847

monitor-web
# Dashboard: http://localhost:3848
```

Or start the API through the main CLI:

```bash
monitor serve --port 3847
```

Override standalone bin ports with `PORT`, for example `PORT=9000 monitor-web`.

## Quick Start

```bash
# Check local machine
monitor status

# Add a remote SSH machine
monitor add linux-node-a --type ssh --host linux-node-a.example.com --user ubuntu --key ~/.ssh/id_ed25519

# Show all machines
monitor machines

# Run health checks
monitor doctor

# List processes, filter for zombies
monitor ps --filter zombies

# Search across everything
monitor search "high cpu"

# Start the web dashboard
monitor-web
```

## MCP Setup

```bash
# Claude Code (recommended)
claude mcp add --scope user monitor -- monitor-mcp

# Or manually add to ~/.claude.json mcpServers:
# "monitor": { "type": "stdio", "command": "monitor-mcp", "args": [] }

# Codex — add to ~/.codex/config.toml:
# [mcp_servers.monitor]
# command = "monitor-mcp"
```

## HTTP mode

Run a shared Streamable HTTP MCP server (stateless, `127.0.0.1` only):

```bash
monitor-mcp --http
# or: MCP_HTTP=1 monitor-mcp
# default port: 8826 (override with --port or MCP_HTTP_PORT)
```

Endpoints: `GET /health`, `POST /mcp` (Streamable HTTP).

### Available MCP Tools

MCP tools return compact JSON summaries by default to keep agent context small.
List-like tools accept `limit`, `cursor`, and `verbose`; pass `verbose: true`
to get the legacy full payload, including full rows and nested details.

| Tool | Description |
|------|-------------|
| `monitor_snapshot` | Get current metrics snapshot (CPU, memory, disk, GPU) |
| `monitor_health` | Run health checks and return pass/warn/fail status |
| `monitor_processes` | List running processes with optional filters |
| `monitor_apps` | List installed apps/packages or compare inventories across machines |
| `monitor_service` | List or control system services and detected dev servers |
| `monitor_containers` | List containers and resource usage on one or all machines |
| `monitor_container_logs` | Fetch recent logs for one container |
| `monitor_ports` | List listening TCP/UDP ports on one or all machines |
| `monitor_tailscale` | Show Tailscale peer status, IPs, health, and latency |
| `monitor_temperature` | Show CPU/GPU temperatures, fan speeds, and thermal alerts |
| `monitor_mcp_health` | Check Claude MCP registration health and dead tmux panes |
| `monitor_mcp_status` | Show MCP server health with best-effort matched process details |
| `monitor_mcp_restart` | Restart a matched MCP process and re-check health |
| `monitor_kill` | Kill a process by PID with configurable signal |
| `monitor_machines` | List all configured machines |
| `monitor_add_machine` | Add a new machine to monitor |
| `monitor_alerts` | List recent alerts for a machine |
| `monitor_cron_jobs` | List scheduled cron jobs |
| `monitor_doctor` | Run the doctor and get remediation suggestions |
| `monitor_search` | Full-text search across machines, alerts, processes |
| `monitor_register_agent` | Register an AI agent for heartbeat tracking |
| `monitor_heartbeat` | Send a heartbeat to indicate agent is alive |
| `monitor_set_focus` | Set current focus/task for an agent |
| `monitor_list_agents` | List all registered agents and their status |
| `monitor_configure_integrations` | Update integration settings |
| `monitor_send_feedback` | Submit feedback |

## CLI Reference

```
monitor <command> [options]
```

Human CLI output is compact by default for list/search/status-style commands:
long text is truncated, row counts are capped, and paged output prints a hint
with the next `--cursor` value. Use `--limit`, `--cursor`, and `--verbose` for
gradual disclosure, or `--json` for machine-readable output. Existing JSON
paths remain raw/stable unless a command already supported limit-based JSON
output, such as `monitor ps`.

| Command | Description |
|---------|-------------|
| `status [machine]` | Show current system snapshot (CPU, memory, disk, GPU) |
| `machines` | List all configured machines |
| `add <name>` | Add a machine to monitor |
| `doctor [machine]` | Run health checks with diagnostics |
| `ps [machine]` | List processes, with optional filter |
| `kill <pid>` | Kill a process by PID |
| `alerts [machine]` | Show recent alerts |
| `apps [machine]` | List installed apps/packages or compare them across machines |
| `compare-apps` | Compare installed apps across all configured machines |
| `service <action> [name]` | List or control system services and detected dev servers |
| `containers [machine]` | Show containers and resource usage |
| `ports [machine]` | Show listening TCP/UDP ports |
| `tailscale [machine]` | Show Tailscale peer status, IPs, health, and latency |
| `temperature [machine]` | Show CPU/GPU temperatures, fan speeds, and thermal alerts |
| `mcp-health [machine]` | Check Claude MCP registration health and dead tmux panes |
| `mcp-status [machine]` | Show MCP health plus best-effort matched process PIDs, memory, and uptime |
| `mcp-restart <name>` | Restart a matched MCP process if one is running, then re-check health |
| `report` | Build a daily fleet health report |
| `report --send` | Deliver the current report via configured integrations |
| `report --schedule daily|weekly` | Create or update a scheduled fleet report job |
| `cron list` | List scheduled cron jobs |
| `cron add <name> <schedule> <command>` | Add a cron job |
| `cron run <job-id>` | Run a cron job immediately |
| `search <query>` | Full-text search |
| `migrate` | Run database migrations |
| `integrations list` | List integration status |
| `integrations test <name>` | Test an integration |
| `serve` | Start the API server |
| `mcp` | Start the MCP server (stdio) |
| `sync push` | Push metrics to remote store |
| `sync pull` | Pull metrics from remote store |
| `sync status` | Show sync status |
| `completions zsh` | Print zsh completions |
| `completions bash` | Print bash completions |
| `completions install` | Auto-install shell completions |

`mcp-status` and `monitor_mcp_status` use live process snapshots, so stdio servers can report `connected` with `processCount: 0` when no long-lived child is present at the instant of collection.

### monitor add

```bash
# Local machine (default)
monitor add mybox

# SSH machine
monitor add linux-node-a \
  --type ssh \
  --host linux-node-a.example.com \
  --user ubuntu \
  --key ~/.ssh/id_ed25519 \
  --port 22

# EC2 machine (uses AWS SSM)
monitor add prod-api \
  --type ec2 \
  --instance-id i-0abc123def456789 \
  --region us-east-1 \
  --profile my-aws-profile
```

### monitor ps

```bash
monitor ps                     # compact top processes by CPU
monitor ps --filter zombies    # zombie processes only
monitor ps --filter orphans    # orphan processes
monitor ps --limit 20          # top 20 by CPU
monitor ps --cursor 20         # next compact page
monitor ps --verbose           # include command snippets
monitor ps --json              # raw JSON output
```

### monitor kill

```bash
monitor kill 1234              # SIGTERM (default)
monitor kill 1234 --signal SIGKILL
monitor kill 1234 --signal 9
```

### monitor apps

```bash
monitor apps                  # local package/app inventory
monitor apps macos-node-b          # one remote machine
monitor apps --all            # inventories for all configured machines
monitor apps --compare        # highlight missing/version-skewed/root-owned installs
monitor compare-apps          # dedicated cross-machine consistency report
monitor apps --limit 50       # show more rows
monitor apps --cursor 50      # continue from a previous page
monitor apps --verbose        # wider app/version detail
monitor apps --json
```

### monitor service

```bash
monitor service list                       # show system services plus detected dev servers
monitor service list --machine macos-node-b    # inspect one remote machine
monitor service start postgresql          # systemd / brew / launchctl start
monitor service restart nginx             # systemd / brew / launchctl restart
monitor service stop vite:12345           # stop a detected dev server by PID-backed name
monitor service list --limit 50 --verbose
monitor service list --json
```

### monitor temperature

```bash
monitor temperature            # local thermal snapshot
monitor temperature linux-node-a    # one remote machine
monitor temperature --all      # inspect all configured machines
monitor temperature --json
```

### monitor containers

```bash
monitor containers                 # local container list
monitor containers linux-node-a         # remote machine containers
monitor containers --all           # all configured machines
monitor containers --logs api      # recent logs for one container
monitor containers --logs api --tail 200
monitor containers --limit 50 --verbose
monitor containers --json
```

### monitor ports

```bash
monitor ports                # local listeners
monitor ports linux-node-a        # one remote machine
monitor ports --all          # scan all configured machines
monitor ports --protocol tcp # filter by protocol
monitor ports --limit 50 --cursor 50
monitor ports --verbose      # wider host/process columns
monitor ports --json         # raw JSON output
```

### monitor loop-check

Loop-ready deterministic checks emit compact heartbeats, bounded evidence, and
deduped task seeds without dispatching tmux prompts. Add `--upsert-tasks` with
an explicit `--todos-project` when a loop should create missing remediation
tasks directly.

```bash
monitor loop-check listening-ports local
monitor loop-check workspace-ports --workspace /home/hasna/workspace
monitor loop-check process-hygiene local
monitor loop-check quarantine-retention --apply --max-gb 100 --target-gb 80

monitor loop-check workspace-ports \
  --upsert-tasks \
  --todos-project /home/hasna/.hasna/loops \
  --max-task-actions 20
```

### monitor tailscale

```bash
monitor tailscale          # local Tailscale graph
monitor tailscale linux-node-a  # one remote machine
monitor tailscale --all    # inspect all configured machines
monitor tailscale --limit 50 --verbose
monitor tailscale --json   # raw JSON output
```

### monitor search

```bash
monitor search "high cpu"              # compact result snippets
monitor search "postgres" --limit 25   # show more matches
monitor search "postgres" --cursor 25  # next page
monitor search "postgres" --verbose    # include ranks and wider snippets
monitor search "postgres" --json       # raw search rows
```

### monitor report

```bash
monitor report                       # preview daily fleet report
monitor report --period weekly       # preview weekly fleet report
monitor report --send                # send via configured conversations/emails integrations
monitor report --schedule daily      # create/update a 9:00 daily cron report
monitor report --schedule weekly     # create/update a Monday 9:00 weekly cron report
monitor report --allow-live-cloud-polling  # include EC2/cloud machines only after explicit approval
```

### Cloud runtime diagnostics

`monitor health`, `monitor doctor`, and `monitor report` include metadata-only
cloud runtime diagnostics. These checks make the runtime boundary explicit:

- Local SQLite and local config files are always the default runtime store.
- `MONITOR_DATABASE_URL` switches package storage/sync diagnostics to remote
  Postgres/RDS metadata, but status output never prints the URL, host, user, or
  password.
- S3/object-store diagnostics are enabled by configuration environment names
  such as `MONITOR_S3_BUCKET`, `MONITOR_S3_PREFIX`, or
  `MONITOR_OBJECT_STORE_BUCKET`; reports show aggregate readiness only.
- EC2 machine configs remain on-demand/read-only through CloudWatch/SSM
  collectors when a machine is explicitly inspected.
- ECS and RDS health are modeled through provider-injected read-only
  observations. The default CLI path does not poll live AWS accounts, mutate AWS
  resources, create secrets, deploy services, run Terraform, or increase spend.

Cloud diagnostics are safe for task loops and reports because they expose only
configured/observed counts, statuses, and threshold percentages. Cloud
identifiers such as bucket names, ARNs, hostnames, private paths, and credential
values are intentionally excluded.

## Web Dashboard

```bash
monitor-web
# Opens: http://localhost:3848
```

The dashboard shows:
- Real-time CPU, memory, and disk gauges per machine
- Recent alerts with severity indicators
- Process table with sort and filter
- Doctor check results
- Cron job schedule

Default port is `3848`. Override it with `PORT=9000 monitor-web`.

## Configuration

Config is stored at `~/.hasna/monitor/config.json`. Set `MONITOR_CONFIG_DIR`
to use a different config/database directory for CI, tests, or isolated agent
runs.

```json
{
  "machines": [
    {
      "id": "local",
      "label": "Local Machine",
      "type": "local",
      "pollIntervalSecs": 30,
      "tags": ["dev"]
    },
    {
      "id": "linux-node-a",
      "label": "Spark Node 01",
      "type": "ssh",
      "ssh": {
        "host": "linux-node-a.example.com",
        "port": 22,
        "username": "ubuntu",
        "privateKeyPath": "~/.ssh/id_ed25519"
      },
      "pollIntervalSecs": 60,
      "tags": ["production", "spark"]
    },
    {
      "id": "prod-api",
      "label": "Prod API Server",
      "type": "ec2",
      "ec2": {
        "instanceId": "i-0abc123def456789",
        "region": "us-east-1",
        "profile": "my-aws-profile"
      }
    }
  ],
  "thresholds": {
    "cpuPercent": 90,
    "memPercent": 90,
    "diskPercent": 85,
    "loadAvg": 10
  },
  "dbPath": "~/.hasna/monitor/monitor.db",
  "apiPort": 3847,
  "webPort": 3848,
  "integrations": {
    "todos": {
      "enabled": true,
      "project_id": "my-project-id"
    },
    "conversations": {
      "enabled": true,
      "space_id": "my-space-id"
    },
    "emails": {
      "enabled": true,
      "to": "alerts@example.com"
    }
  }
}
```

### Alert Thresholds

| Field | Default | Description |
|-------|---------|-------------|
| `cpuPercent` | 90 | Alert when CPU exceeds this % |
| `memPercent` | 90 | Alert when memory exceeds this % |
| `diskPercent` | 85 | Alert when any disk exceeds this % |
| `loadAvg` | 10 | Alert when 1-min load average exceeds this |

## Integrations

open-monitor integrates with the open-* ecosystem to surface alerts where you're already working.

### open-todos

Creates tasks when critical alerts fire.

```json
"todos": {
  "enabled": true,
  "project_id": "your-project-id",
  "base_url": "http://localhost:3000"
}
```

### open-conversations

Posts alerts to a team space.

```json
"conversations": {
  "enabled": true,
  "space_id": "your-space-id",
  "base_url": "http://localhost:3001"
}
```

### open-mementos

Stores alert history as memories for AI agent context.

```json
"mementos": {
  "enabled": true,
  "base_url": "http://localhost:3002"
}
```

### open-emails

Sends email notifications for critical alerts.

```json
"emails": {
  "enabled": true,
  "to": "alerts@example.com",
  "from": "monitor@yourdomain.com",
  "base_url": "http://localhost:3003"
}
```

Test any integration:

```bash
monitor integrations test todos
monitor integrations test conversations
monitor integrations test emails
```

## Shell Completions

```bash
# Install automatically (detects your shell)
monitor completions install

# Or manually:
monitor completions zsh >> ~/.zshrc
monitor completions bash >> ~/.bashrc
```

## Database

By default uses SQLite at `~/.hasna/monitor/monitor.db`. For production or multi-agent setups, use PostgreSQL:

Set `MONITOR_DATABASE_URL` environment variable:

```bash
export MONITOR_DATABASE_URL="postgres://monitor-db.example.internal:5432/monitor"
monitor migrate
```

## Security

- The REST API binds to `127.0.0.1` by default. Use `monitor serve --host 0.0.0.0` or `HASNA_MONITOR_API_HOST=0.0.0.0` only behind a trusted network or reverse proxy.
- Mutating and diagnostic command REST routes require `Authorization: Bearer <token>` or `X-API-Key: <token>`. Set `HASNA_MONITOR_API_TOKEN` or `MONITOR_API_TOKEN` before using API routes that create/delete machines, run doctor diagnostics, kill processes, create cron jobs, or run cron jobs. The dashboard sends `VITE_MONITOR_API_TOKEN` or a browser `localStorage` value named `monitor.apiToken` when present.
- CORS is restricted to exact trusted origins. Local dashboard origins are allowed by default; add comma-separated origins with `HASNA_MONITOR_API_CORS_ORIGINS` or `MONITOR_API_CORS_ORIGINS`.
- Process command lines are automatically redacted before being returned to AI agents — passwords, tokens, API keys, and secrets are replaced with `***`
- See [SECURITY.md](SECURITY.md) for the security policy and responsible disclosure process

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
