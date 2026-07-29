# REST API Reference

Start the API with either entrypoint:

```bash
monitor serve --host 127.0.0.1 --port 3847
monitor-server --host 127.0.0.1 --port 3847
```

The default base URL is `http://127.0.0.1:3847`. `monitor serve` reads its
port from the CLI option (default `3847`) and its host from the CLI/configured
API defaults. `monitor-server` also accepts `PORT`. Both honor
`HASNA_MONITOR_API_HOST` or `MONITOR_API_HOST` when no host argument is given.

## Authentication

Read routes are public on the listening interface. Mutating routes and explicit
doctor execution require a token configured through
`HASNA_MONITOR_API_TOKEN` or `MONITOR_API_TOKEN`. If no token is configured,
protected routes remain disabled and return `401`.

Send the token in one of these headers:

```http
Authorization: Bearer <token>
X-API-Key: <token>
X-Monitor-Token: <token>
```

Protected routes are marked **Auth** below.

## Routes

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/health` | No | Service liveness with timestamp and service name |
| `GET` | `/api/machines` | No | List machine records, with `ssh_key_path` redacted |
| `POST` | `/api/machines` | **Yes** | Create a machine |
| `GET` | `/api/machines/:id` | No | Get one machine or `404`, with `ssh_key_path` redacted |
| `DELETE` | `/api/machines/:id` | **Yes** | Delete one machine |
| `GET` | `/api/machines/:id/snapshot` | No | Live sanitized snapshot, doctor report, and runtime health |
| `GET` | `/api/machines/:id/metrics` | No | Stored metric history |
| `GET` | `/api/machines/:id/processes` | No | Live sanitized process list, with stored fallback |
| `GET` | `/api/machines/:id/alerts` | No | Stored alerts merged with live diagnostics |
| `POST` | `/api/machines/:id/doctor` | **Yes** | Run diagnostics and runtime-health checks |
| `POST` | `/api/machines/:id/kill` | **Yes** | Send `SIGTERM` or `SIGKILL` to a validated PID |
| `GET` | `/api/alerts` | No | List alerts across machines |
| `GET` | `/api/cron` | No | List cron jobs |
| `POST` | `/api/cron` | **Yes** | Create a cron job |
| `GET` | `/api/cron/:id` | No | Get one cron job or `404` |
| `POST` | `/api/cron/:id/run` | **Yes** | Run a cron job immediately |
| `GET` | `/api/search` | No | Full-text search |
| `GET` | `/api/stream` | No | Server-Sent Events stream |

Unknown routes return `404`; unsupported methods return the route miss response.
Validation errors use status `400` and include field-level details. Protected
routes return `401` with a Bearer challenge when authorization fails.

The machine read routes are unauthenticated, so credential-bearing fields are
redacted before they are serialized: `ssh_key_path` comes back as `***`
whenever a key is configured (and `null` when one is not), and the
config-sourced fallback used when the database cannot be opened redacts both
`ssh.privateKeyPath` and `ssh.password`. `GET /api/search` returns the whole
source row, so a `machines` hit is redacted the same way. See
[docs/security.md](security.md#ssh-key-handling).

## Query Parameters

| Route | Parameters |
|-------|------------|
| `/api/machines/:id/metrics` | `since`: Unix seconds (default: one hour ago); `limit`: maximum rows (default `100`) |
| `/api/machines/:id/processes` | `sortBy=cpu|mem` (default `cpu`), `filter=all|zombies|orphans|high_mem` (default `all`), `limit` (default `50`) |
| `/api/machines/:id/alerts` | `unresolved_only=false` includes resolved alerts; every other value means unresolved only |
| `/api/alerts` | `unresolved_only=false` includes resolved alerts; every other value means unresolved only |
| `/api/cron` | `machine_id` filters jobs by machine |
| `/api/search` | Required `q` (1–200 characters); optional comma-separated `tables` |

Search table names are passed to the search layer; the standard indexed tables
are `machines`, `alerts`, and `processes`.

## Request Bodies

### Create a machine

`POST /api/machines` accepts:

```json
{
  "name": "build-node",
  "id": "build-node",
  "type": "ssh",
  "host": "build-node.example.com",
  "port": 22,
  "ssh_key_path": "/home/user/.ssh/id_ed25519",
  "aws_region": null,
  "aws_instance_id": null,
  "tags": "{\"role\":\"build\"}"
}
```

`name` is required. `id` is optional and otherwise derived from the name.
`type` defaults to `local` and must be `local`, `ssh`, or `ec2`. Connection
fields are optional/nullable and bounded by the API validation schema.

### Kill a process

`POST /api/machines/:id/kill` accepts:

```json
{ "pid": 1234, "signal": "SIGTERM" }
```

`pid` must be an integer of at least 10. `signal` defaults to `SIGTERM` and may
be `SIGTERM` or `SIGKILL`. Process command lines in API responses are sanitized.

### Create a cron job

`POST /api/cron` accepts:

```json
{
  "name": "daily-report",
  "schedule": "0 9 * * *",
  "command": "monitor report --send",
  "machine_id": null,
  "action_type": "send_report",
  "action_config": "{\"period\":\"daily\"}",
  "enabled": 1
}
```

`name`, a valid cron `schedule`, and `command` are required. `action_type`
defaults to `shell`; accepted values are `shell`, `kill_process`,
`restart_process`, `doctor`, `prune_metrics`, `cleanup_zombies`,
`cleanup_caches`, `send_report`, and `custom`. `enabled` is `0` or `1`.

## SSE

`GET /api/stream` returns `text/event-stream`, emits an initial comment
heartbeat, and broadcasts periodic monitor updates while the connection stays
open. Clients should reconnect using normal EventSource behavior.

## CORS

The exact local dashboard origins `http://localhost:3848` and
`http://127.0.0.1:3848` are allowed by default. Add comma-separated exact
origins with `HASNA_MONITOR_API_CORS_ORIGINS` or
`MONITOR_API_CORS_ORIGINS`. A configured `*` is ignored; wildcard origins are
not enabled. Allowed preflight methods are `GET`, `POST`, `PUT`, `DELETE`, and
`OPTIONS`.

See [Security](security.md) for process safety and redaction details, and the
[CLI reference](cli.md) for command-line equivalents.
