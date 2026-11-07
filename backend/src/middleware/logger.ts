import pino from 'pino';

// Structured JSON logger (SECURITY.md §14).
//
// Writes to stderr to stay separate from the setup-token stdout stream (§5.2).
//
// ALLOWLIST POLICY: every call site must name fields explicitly.
// No serializer ever touches req.headers, req.body, req.cookies, req.socket,
// or any object that could carry credentials. This prevents accidental logging
// of Authorization headers, setup tokens, passwords, or session cookies.
//
// Field allowlist per event type (§14.2):
//   API request  — method, path, status, duration_ms, device_id
//   Auth failure — reason, ip (never the submitted credential)
//   Import reject— reason, file_size_bytes | depth | count (never file contents)
//   Rate limit   — endpoint, ip
//   DB error     — code (never SQL text, connection string, or parameter values)
//   Startup      — version, listen_address (never DB password or setup token)
//
// §14.3 hard invariants: the following values MUST NOT appear in any log entry:
//   API key, setup token, dashboard password, session cookie, DB password,
//   request body contents, stack traces (production), file contents.

export const logger = pino(
  { level: process.env.LOG_LEVEL ?? 'info' },
  process.stderr,
);
