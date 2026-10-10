# Security model

Local MCP Gateway is a single-user local tool proxy. Its configuration and the account running it are trusted. It is not a multi-tenant authorization service or an OS sandbox for upstream processes. There has been no independent security audit.

## Enforced controls

- Per-server `allowedTools` restricts exact tool names before connection or dispatch. An omitted list permits all tools; an empty list denies all. Guessed names and JavaScript bridge calls use the same policy. Discovery and native/inline exposure use the permitted catalogue.
- Native advertisements use conservative side-effect annotations. An upstream cannot make a proxied native tool advertise itself as read-only or idempotent to influence client approvals.
- `security.allowCode:false` rejects JavaScript execution and removes `code` from the advertised execute schema. Structured calls and retained JSON filtering remain available. JavaScript remains enabled when this setting is omitted for compatibility.
- Unknown configuration keys, invalid policies and out-of-range discovery limits fail validation. CLI configuration changes preserve policies and secret references.
- Every upstream call permits at most 64 KiB of UTF-8 JSON arguments. Enabled JavaScript has bounded code size, guest heap, upstream-call count, intermediate result size, final output and execution time. Queued host bridge work checks cancellation and expiry before dispatch.
- Discovery checks raw tool count, per-tool and aggregate metadata bytes, page count, repeated cursors, duplicate names and callable name lengths. Denied tools still count toward ingestion budgets. Cached and refreshed catalogues share aggregate admission accounting. Oversized upstream catalogues produce an explicit unavailable status.
- Resolved upstream URLs and browser authorization URLs require HTTPS, except HTTP on loopback, and reject URL user information. Endpoint validation runs after environment substitution. OAuth uses SDK PKCE and callback state checks. The fixed loopback callback handles a completed response once.
- Configuration files and OAuth files use restricted POSIX permissions. Retained results stay in one gateway process, have byte/entry/expiry limits, and are cleared on configuration replacement or client disconnection.

## Trust boundaries and remaining limitations

An allowed tool can still expose secrets or cause damage through its arguments. A tool named `read_file` is not intrinsically safe. Upstream annotations are hints, not permission grants. The gateway currently has no field-level argument constraints, trusted per-operation approval flow, or policy audit log. Use narrowly scoped upstream credentials and resource/path restrictions. Treat descriptions and results as untrusted input; these controls do not solve prompt injection.

QuickJS has no direct host filesystem, network or module capability. Its guest heap limit is not a bound on total Node/WASM memory. The SDK parses messages and the host serializes responses before application limits reject them. A very large or malformed transport message can consume host resources first. Discovery keeps at most four scheduled listings ahead of deterministic admission, in addition to retained generations; its metadata budget is not an aggregate RSS cap.

Upstream stdio processes run outside QuickJS with the gateway user's OS permissions. An empty tool allowlist does not stop startup or discovery. `disabled:true` prevents its connection. Executing a configured command trusts that executable and its dependencies. Use OS/container restrictions when the upstream itself needs isolation.

Cancellation cannot undo completed upstream effects. It prevents queued sandbox dispatch after expiry, but a tight synchronous guest loop blocks Node from receiving an external cancellation until it yields; the wall-clock interrupt deadline still applies. Builtin runtime operations and host parsing also need process-level supervision for stronger availability guarantees.

Policy reload happens before the next tool call. Existing in-flight operations may complete under their original policy. Native definitions can remain in a client's cached prompt until reload/notification or restart, even though their calls are checked against the current configuration. Config replacement clears retained handles; it cannot erase data already returned to a client or model.

OAuth tokens are plaintext on disk; there is no keychain integration or Windows ACL provisioning. The browser authorization URL's scheme and user information are checked, but OAuth metadata fetching does not implement a complete destination allowlist or DNS/IP pinning. HTTPS alone does not prevent SSRF to private addresses. Configure trusted HTTP upstreams; the gateway is not designed for accepting arbitrary remote server URLs from untrusted tenants. Browser opening and real vendor sign-in compatibility require separate end-to-end testing.

## Defaults and deployment choices

`setup` and `import` read a specified client file without launching upstreams or modifying that file. Unsupported settings or conflicting destination entries block the entire write; selective import requires explicit server names. Exact tool filters and disabled entries are preserved. New gateway configurations created by these commands disable JavaScript; existing policies remain unchanged. The import is a snapshot, not a bridge to client-private credentials, approvals, workspace trust, OS sandboxing, inherited configuration or enterprise controls. Explicit unsupported sandbox/permission rules in the file block migration. Review external client policies before switching to a gateway, since the client sees a different server and invocation boundary. OAuth-disabled entries do not create an auth provider or permit explicit login. Imported literal credentials remain plaintext in the restricted configuration file.

For workflows needing only structured operations, set `security.allowCode:false` and use explicit allowlists. Prefer tool-specific credentials and upstream restrictions on files, projects, repositories or resources. The README lists defaults and valid discovery-limit ranges. Increasing a limit makes more data eligible for ingestion; it is not a verified scale or memory guarantee. Existing unrestricted configurations remain unrestricted after upgrade until policies are added.

## Validation

Regression tests exercise real stdio discovery, denied-handler dispatch markers, guessed and nested calls, native exposure and revocation, code-disabled structured filtering, UTF-8 argument sizes, duplicate tool names/cursors, raw and cached discovery limits, fixed cache expiry, unchanged snapshot reuse, loopback callback state and duplicate responses, and sandbox cleanup after failures. Unit and fixture tests do not establish resistance to every attack or performance at each configurable limit.

## Prioritized follow-up

1. Argument policies for permitted tools, with explicit JSON path/resource constraints and rejection before dispatch.
2. Process/transport byte limits and supervised sandbox execution, including malicious oversized-message tests and hard termination behavior.
3. OS credential-vault integration, vendor OAuth interoperability and restricted OAuth discovery destinations.
4. An optional local policy audit log that records actions and decisions without arguments, results or credentials.
5. Any trusted approval mechanism must describe each nested action to the host and enforce its decision outside generated code.

## References

- [MCP security guidance](https://modelcontextprotocol.io/docs/2025-11-25/tutorials/security/security_best_practices)
- [MCP tool annotations and their limits](https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations/)
- [QuickJS runtime resource controls](https://github.com/justjake/quickjs-emscripten/blob/main/doc/quickjs-emscripten-core/classes/QuickJSRuntime.md)
