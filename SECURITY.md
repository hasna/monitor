# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in `@hasna/monitor`, please **do not** open a public GitHub issue.

Instead, report it via email:

**Email:** security@hasna.com
**Subject:** `[monitor] Security Vulnerability`

Please include:
- A clear description of the vulnerability
- Steps to reproduce
- Potential impact assessment
- Any suggested mitigations

You will receive a response within **72 hours**. We ask that you allow **90 days** for a patch before any public disclosure. We will credit you in the release notes unless you prefer anonymity.

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | Yes       |

## Security Measures

See [docs/security.md](docs/security.md) for a full description of the security controls implemented in this project.

Key measures include:
- PID validation — PIDs 1-9 (system processes) are unconditionally rejected
- Kill rate limiting — max 5 kills per machine per minute
- SIGKILL requires explicit `force: true`
- Process command lines are sanitized to redact secrets before being returned to callers
- SSH key paths are stored — key contents are never read or exposed
- All user inputs are validated with Zod schemas
