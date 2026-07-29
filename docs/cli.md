# CLI Reference

`monitor` is the human-facing command-line interface for `@hasna/monitor`.
Run `monitor --help` or `monitor <command> --help` for generated help.

## Global Options

| Option | Description |
|--------|-------------|
| `-V, --version` | Print the package version |
| `-h, --help` | Print help |

List-oriented commands use compact output by default. Where supported,
`--limit` sets the page size, `--cursor` is a zero-based row offset,
`--verbose` widens details, and `--json` returns machine-readable output.

## Monitoring Commands

| Command | Options and behavior |
|---------|----------------------|
| `status [machine]` | Collect a live CPU, memory, disk, GPU, load, uptime, and process snapshot. Defaults to `local`; supports `--json`. |
| `health` | Return metadata-only package, machine, service, alert, cron, and cloud-runtime counts. Supports `--probe-services` and `--json`. |
| `machines` | List configured/registered machines. Supports `--limit`, `--cursor`, `--verbose`, and `--json`. |
| `doctor [machine]` | Run live diagnostics and remediation recommendations. Supports `--limit`, `--cursor`, `--verbose`, and `--json`. |
| `ps [machine]` | List live processes. Supports `--sort cpu|mem`, `--filter all|zombies|orphans|high_mem`, paging, `--verbose`, and `--json`. |
| `alerts [machine]` | List alerts; `--all` includes resolved alerts. Supports paging, `--verbose`, and `--json`. |
| `search <query>` | Search `machines`, `alerts`, and `processes`; `--tables` accepts a comma-separated subset. Queries are limited to 200 characters. Supports paging, `--verbose`, and `--json`. |

## Machine Management

```bash
monitor add <name> --type local|ssh|ec2 [options]
```

`--type` is required. SSH records accept `--host`, `--port` (default `22`),
and `--key`; CLI-created SSH records use the collector's default `root` user.
EC2 records accept `--aws-region` and `--aws-instance-id`.
The generated machine ID is the lowercase name with spaces replaced by `-`.

```bash
monitor kill <pid> [--machine <id>] [--force] [--dry-run]
```

The default signal is `SIGTERM`; `--force` selects `SIGKILL`. PIDs below 10
are rejected. `--dry-run` validates and reports the action without killing.

## Runtime Commands

| Command | Options and behavior |
|---------|----------------------|
| `exec [target] <command>` | Send keys to a tmux pane/window. Use `--all` instead of a target to broadcast, `--machine` to select a machine, `--no-enter` to avoid pressing Enter, and `--timeout-ms` (`100`–`30000`, default `3000`). Supports `--json`. |
| `apps [machine]` | Inventory Homebrew, dpkg, Snap, or Flatpak packages. Supports `--all`, `--compare`, paging, `--verbose`, and `--json`. |
| `compare-apps` | Compare package presence, versions, and root ownership across configured machines. Supports paging, `--verbose`, and `--json`. |
| `service <action> [name]` | `action` is `list`, `start`, `stop`, or `restart`; non-list actions require a name. Supports `--machine`, paging, `--verbose`, and `--json`. |
| `containers [machine]` | List Docker, Podman, or Nerdctl containers. Use `--logs <container>` and `--tail <n>` for logs, or `--all` for the fleet. Supports paging, `--verbose`, and `--json`. |
| `ports [machine]` | List listening TCP/UDP sockets. Supports `--all`, `--protocol tcp|udp`, paging, `--verbose`, and `--json`. |
| `tailscale [machine]` | Show Tailscale status, peers, addresses, health, and latency. Supports `--all`, paging, `--verbose`, and `--json`. |
| `temperature [machine]` | Show CPU/GPU thermals, fan speeds, and thermal alerts. Supports `--all`, paging, `--verbose`, and `--json`. |
| `mcp-health [machine]` | Inspect Claude MCP registration and dead tmux panes. Supports `--all`, paging, `--verbose`, and `--json`. |
| `mcp-status [machine]` | Match configured MCP servers to live processes and report PIDs, memory, and uptime. Supports `--all`, paging, `--verbose`, and `--json`. |
| `mcp-restart <name>` | Terminate matched MCP process IDs and re-check status. Supports `--machine` and `--json`. |

## Loop Checks

`monitor loop-check` runs bounded diagnostics without dispatching tmux work:

| Check | Specific options |
|-------|------------------|
| `listening-ports [machine]` | Repeat `--allow <host:port>` for accepted exposures |
| `workspace-ports` | `--workspace` (default `/home/hasna/workspace`), `--machine`, `--max-repos`, `--max-files` |
| `process-hygiene [machine]` | `--high-mem-mb`, `--stuck-hours` |
| `quarantine-retention` | `--root`, `--max-gb` (default `100`), `--target-gb` (default `80`), `--apply` |

Every check supports `--json`, `--evidence-dir`, `--no-evidence`,
`--max-evidence-items`, `--max-task-seeds`, and optional deduplicated todos
creation via `--upsert-tasks`, `--todos-project`, `--task-list`, `--todos-bin`,
and `--max-task-actions`. Quarantine deletion is restricted to eligible cache
payloads under the canonical root; the default behavior is dry-run inspection.

## Reports, Cron, and Retention

```bash
monitor report [--period daily|weekly] [--send]
monitor report --schedule daily|weekly
```

Daily reports cover 24 hours and schedule at `0 9 * * *`; weekly reports cover
seven days and schedule at `0 9 * * 1`. `--send` uses enabled conversations
and emails integrations. EC2/cloud live collection remains disabled unless
`--allow-live-cloud-polling` is passed. `--json` returns the report object.

| Command | Options and behavior |
|---------|----------------------|
| `cron list` | List jobs; supports `--machine`, paging, `--verbose`, and `--json`. |
| `cron add <name> <schedule> <command>` | Add an enabled job. Supports `--machine`, `--action-type`, and JSON `--action-config`. |
| `cron run <job-id>` | Run a job immediately, regardless of schedule. |
| `retention` | Downsample/prune stored data. Defaults: `--full-res-hours 24`, `--hourly-days 7`, `--daily-days 30`; `--dry-run` only displays those settings. |

Built-in cron action types are `shell`, `kill_process`, `restart_process`,
`doctor`, `prune_metrics`, `cleanup_zombies`, `cleanup_caches`, `send_report`,
and `custom`.

## Administration

| Command | Options and behavior |
|---------|----------------------|
| `migrate` | Move supported legacy config and database files into `~/.hasna/monitor/`. |
| `integrations list` | Show open-* integration settings; supports `--json`. |
| `integrations test <name>` | Send a test through `todos`, `conversations`, `mementos`, or `emails`. |
| `serve` | Start the REST API on `127.0.0.1:3847`; supports `--host` and `--port`. |
| `mcp` | Start the MCP server over stdio. |
| `sync push` / `sync pull` | Sync all or comma-separated `--tables` with PostgreSQL from `MONITOR_DATABASE_URL`. |
| `sync status` | Show cloud configuration, last sync, and local table status. |
| `completions zsh` / `completions bash` | Print a completion script. |
| `completions install` | Install completions for the detected shell or `--shell zsh|bash`. |

The standalone binaries `monitor-mcp`, `monitor-server`, and `monitor-web` are
documented in the [README](../README.md). See the [REST API reference](api.md)
for `monitor serve` and `monitor-server` routes.
