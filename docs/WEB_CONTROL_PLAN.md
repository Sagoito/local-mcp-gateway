# Weftly local web control plane

Weftly's web service is a single-user local control plane. It binds only to `127.0.0.1`; remote hosting, multi-user access, and TLS administration are not implemented. The local user and configuration are trusted. Configured stdio commands execute on the machine running Weftly with that user's operating-system permissions.

## Implemented behavior

The dashboard reads current server and catalog status and offers explicit refresh. It can add, edit, enable or disable, and remove stdio and HTTP servers; edit allowlists and code-execution policy; preview and atomically apply supported client JSON/JSONC imports; and start or inspect an OAuth sign-in. Import reads the selected source and does not rewrite it. Issues or destination-name conflicts prevent application. New configurations set `security.allowCode` to false; an existing configuration without that setting retains its legacy effective behavior.

The service owns upstream connections and discovery. A shared pool serves the dashboard and all MCP sessions. Tool catalogs are immutable snapshots. Each MCP session owns its retained-result handles. A configuration reload replaces the upstream generation, clears retained results, and applies the new policy to future dispatches; calls already in flight may finish. Upstream process startup and SDK parsing are not fully bounded by the application-level response limits.

Agents connect through the Streamable HTTP endpoint at `/mcp` or the stdio-to-HTTP bridge. The bridge reads a private connection file containing the endpoint and a persistent random MCP bearer token. The MCP token is distinct from the administrator credential. The bridge does not receive upstream configuration, credentials, or executable commands.

## Administrator and network boundary

The service binds to `127.0.0.1` and requires the exact expected Host. It rejects a present Origin unless it matches the service origin, validates request paths, and sends no CORS permission. These checks happen before administrator authentication and request-body parsing. Administrator responses use a restrictive CSP, `Cache-Control: no-store`, and `Referrer-Policy: no-referrer`.

At startup, Weftly generates a random administrator token and places it in the dashboard URL fragment. The page removes the fragment immediately and exchanges the token with `POST /api/session`. The exchange sets an `HttpOnly`, `SameSite=Strict`, `/api` cookie. Cookie-authenticated API calls must also include `X-Weftly-Request: 1`; the browser does not store credentials in local storage. The token exchange and APIs require same-origin access. This is local browser-session protection, not multi-user identity or a remote authentication system.

Administrator JSON requests require `application/json` and are limited to 1 MiB. The service allows at most 32 MCP sessions, including pending initializations, and closes an idle session after 30 minutes when it has no active request. Each request refreshes the idle timer. These limits do not bound memory used while the MCP SDK parses an incoming message or an upstream response.

## Configuration and OAuth

Configuration mutations are serialized and require the current SHA-256 revision. Public state exposes policy and server settings while masking literal environment/header values, omitting URL query and fragment contents, and reporting key names and recognized environment references for editing. If a user edits an unchanged redacted argument value, the store preserves its saved value. Configuration files and OAuth state/token files contain plaintext credentials and use restrictive POSIX permissions. Windows ACL hardening is not guaranteed, and there is no OS credential vault.

Only one web OAuth login can be pending at a time. The callback is fixed at `http://127.0.0.1:43127/callback`; login completion checks state and accepts a completed response once. The dashboard receives generic failure text. OAuth protocol code uses the MCP SDK's PKCE flow, but real-vendor sign-in compatibility has not been established by browser or vendor end-to-end testing.

## Implemented API

- `GET /api/state`
- `POST /api/servers` with `{revision,name,server}`
- `DELETE /api/servers/:name` with `{revision}`
- `POST /api/policy` with `{revision,security}`
- `POST /api/import` with `{revision,text,format,workspaceDir,names?,apply}`
- `POST /api/refresh`
- `POST /api/login/:name` and `GET /api/logins`
- `GET /api/connection?client=generic|copilot|vscode|opencode`
- `POST /api/session` to exchange the startup token for the administrator cookie
- `/mcp` for MCP clients authenticated by the independent connection-file token

The administrator API does not expose general tool execution. `GET /api/connection` returns client configuration that references the private connection file; it does not return either bearer token.

## Verification status

Automated tests cover configuration defaults and private connection-file handling, Host/Origin rejection, administrator session-cookie and request-marker checks, content type and body-size limits, independent MCP bearer authentication, real HTTP and stdio-bridge calls, reuse of a single upstream process, per-session retained-result isolation, and policy revocation in an existing session. Control-store tests cover revision conflicts, credential redaction, edit preservation, validation, policy defaults, and atomic import behavior. Existing OAuth tests cover callback state and duplicate responses. These tests do not establish browser UI quality, real-provider OAuth interoperability, or resilience to all oversized SDK-parsed upstream messages. Frozen benchmark results remain unchanged; transport-overhead comparisons are separate from agent inference.
