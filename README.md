# open-monitor

> System monitor for AI agents and humans — watch multiple machines, detect problems, take action.

[![npm](https://img.shields.io/npm/v/@hasna/monitor)](https://www.npmjs.com/package/@hasna/monitor)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

## Features

- **Multi-machine** — monitor local, SSH, and EC2 machines from one place
- **Metrics** — CPU, memory, disk, GPU, load average, uptime, processes
- **MCP server** — AI agents can query health, kill processes, manage cron jobs, and run doctor checks
- **Doctor** — built-in health checks with actionable diagnostics
- **Cron jobs** — schedule actions per machine with full cron syntax
- **Process manager** — detect zombies and orphans, smart kill policy with signal selection
- **Web dashboard** — dark-themed real-time gauges served at `http://localhost:3848`
- **Full-text search** — search across machines, alerts, and processes
- **Integrations** — open-todos, open-conversations, open-mementos, open-emails
- **SQLite by default** — zero-config persistence; optional PostgreSQL for production
- **Shell completions** — zsh and bash completions included

## Install

```bash
bun install -g @hasna/monitor
```

Or with npm:

```bash
npm install -g @hasna/monitor
```

## Quick Start

```bash
# Check local machine
monitor status

# Add a remote SSH machine
monitor add spark01 --type ssh --host spark01.example.com --user ubuntu --key ~/.ssh/id_ed25519

# Show all machines
monitor machines

# Run health checks
monitor doctor

# List processes, filter for zombies
monitor ps --filter zombies

# Search across everything
monitor search "high cpu"

# Start the web dashboard
monitor serve --web
```

## MCP Setup (Claude Code)

Add to `~/.claude/mcp.json`:

```json
{
  "mcpServers": {
    "monitor": {
      "command": "monitor-mcp",
      "args": []
    }
  }
}
```

### Available MCP Tools

| Tool | Description |
|------|-------------|
| `monitor_snapshot` | Get current metrics snapshot (CPU, memory, disk, GPU) |
| `monitor_health` | Run health checks and return pass/warn/fail status |
| `monitor_processes` | List running processes with optional filters |
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

| Command | Description |
|---------|-------------|
| `status [machine]` | Show current system snapshot (CPU, memory, disk, GPU) |
| `machines` | List all configured machines |
| `add <name>` | Add a machine to monitor |
| `doctor [machine]` | Run health checks with diagnostics |
| `ps [machine]` | List processes, with optional filter |
| `kill <pid>` | Kill a process by PID |
| `alerts [machine]` | Show recent alerts |
| `cron list` | List scheduled cron jobs |
| `cron add <name> <schedule> <command>` | Add a cron job |
| `cron run <job-id>` | Run a cron job immediately |
| `search <query>` | Full-text search |
| `migrate` | Run database migrations |
| `integrations list` | List integration status |
| `integrations test <name>` | Test an integration |
| `serve` | Start the API server |
| `serve --web` | Start the API + web dashboard |
| `mcp` | Start the MCP server (stdio) |
| `sync push` | Push metrics to remote store |
| `sync pull` | Pull metrics from remote store |
| `sync status` | Show sync status |
| `completions zsh` | Print zsh completions |
| `completions bash` | Print bash completions |
| `completions install` | Auto-install shell completions |

### monitor add

```bash
# Local machine (default)
monitor add mybox

# SSH machine
monitor add spark01 \
  --type ssh \
  --host spark01.example.com \
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
monitor ps                     # all processes
monitor ps --filter zombies    # zombie processes only
monitor ps --filter orphans    # orphan processes
monitor ps --limit 20          # top 20 by CPU
monitor ps --json              # raw JSON output
```

### monitor kill

```bash
monitor kill 1234              # SIGTERM (default)
monitor kill 1234 --signal SIGKILL
monitor kill 1234 --signal 9
```

## Web Dashboard

```bash
monitor serve --web
# Opens: http://localhost:3848
```

The dashboard shows:
- Real-time CPU, memory, and disk gauges per machine
- Recent alerts with severity indicators
- Process table with sort and filter
- Doctor check results
- Cron job schedule

Default port is `3848`. Override in config: `"webPort": 9000`.

## Configuration

Config is stored at `~/.hasna/monitor/config.json`.

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
      "id": "spark01",
      "label": "Spark Node 01",
      "type": "ssh",
      "ssh": {
        "host": "spark01.example.com",
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

Set `DATABASE_URL` environment variable:

```bash
export DATABASE_URL="postgres://user:pass@localhost:5432/monitor"
monitor migrate
```

## Security

- Process command lines are automatically redacted before being returned to AI agents — passwords, tokens, API keys, and secrets are replaced with `***`
- See [SECURITY.md](SECURITY.md) for the security policy and responsible disclosure process

## License

MIT — see [LICENSE](LICENSE) for details.
