# Security Documentation

This document describes the security measures implemented in `@hasna/monitor`.

---

## Process Kill Safety

### PID Validation

All kill operations validate the target PID before execution:

- PID must be a positive integer.
- PIDs 1-9 are unconditionally rejected — these are reserved for system/init processes.
- Validation is enforced in three places: `ProcessManager.kill()`, the Zod `KillInputSchema`, and the REST API `/api/machines/:id/kill` endpoint.

### SIGKILL Requires Explicit Confirmation

- The MCP tool `monitor_kill` defaults to `SIGTERM` (graceful shutdown).
- `SIGKILL` (immediate termination) requires passing `force: true` AND `signal: "SIGKILL"`.
- This prevents accidental hard-kills by AI agents that may have set force=true for SIGTERM.

### Kill Rate Limiting

- At most 5 kill operations per machine per minute are allowed.
- The rate limiter lives in `src/process-manager/index.ts` (`checkKillRateLimit`).
- Requests exceeding the limit return an error without executing.
- This prevents runaway automation from killing large numbers of processes.

---

## Process Data Sanitization

All process `cmd` (command line) fields are sanitized before being returned by any MCP tool or REST API endpoint.

The `sanitizeCmd()` function redacts:

| Pattern | Redacted to |
|---------|-------------|
| `--password=<value>` | `--password=***` |
| `--passwd=<value>` | `--passwd=***` |
| `AWS_SECRET_ACCESS_KEY=<value>` | `AWS_SECRET_ACCESS_KEY=***` |
| `AWS_SESSION_TOKEN=<value>` | `AWS_SESSION_TOKEN=***` |
| `AWS_SECRET_KEY=<value>` | `AWS_SECRET_KEY=***` |
| `token=<value>` | `token=***` |
| `secret=<value>` | `secret=***` |
| `api_key=<value>` | `api_key=***` |
| `password=<value>` | `password=***` |

This prevents AI agents from reading secrets that may be passed as command-line arguments to running processes.

---

## SSH Key Handling

- Machine records store only the **path** to the SSH private key (`ssh_key_path`), never the key contents.
- The key path is never read or exposed by any API endpoint or MCP tool.
- SSH key paths should be restricted to the user's home directory — keys outside `~/` are used at the operator's risk.

---

## Shell Injection Prevention

The `monitor_kill` command constructs its kill command as:

```typescript
const sigNum = signal === "SIGKILL" ? 9 : 15;
const cmd = `kill -${sigNum} ${pid}`;
```

Both `sigNum` (derived from an enum, values 9 or 15) and `pid` (validated as an integer >= 10) are safe from shell injection. No user-supplied strings are interpolated into shell commands.

---

## Input Validation

All user-supplied inputs are validated with Zod schemas (`src/validation.ts`) before processing:

- Machine names, IDs, host fields, ports — all bounded and type-checked.
- Cron expressions validated with `cron-parser`.
- Search queries limited to 200 characters.
- PID validated as integer >= 10.
- Signal must be one of `SIGTERM` or `SIGKILL`.

---

## No Sensitive Data in Audit Logs

- The `logCronRun` function records cron job output, but cron commands that contain secrets (e.g. `--password=...`) should be reviewed before creation.
- Process snapshots stored in the DB include the sanitized `cmd` field.

---

## Configuration Security

- Config is stored in `~/.hasna/monitor/config.json` — a user-owned location.
- The SQLite database is stored in `~/.hasna/monitor/monitor.db`.
- No credentials are stored in the config file (only key paths, not key contents).

---

## Responsible Disclosure

If you discover a security vulnerability in `@hasna/monitor`, please report it responsibly:

1. **Do not** open a public GitHub issue for security vulnerabilities.
2. Email `security@hasna.com` with the subject `[monitor] Security Vulnerability`.
3. Include:
   - A description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Any suggested mitigations
4. You will receive a response within 72 hours.
5. Please allow 90 days for a fix before public disclosure.

We appreciate responsible disclosure and will credit reporters in release notes unless anonymity is requested.
