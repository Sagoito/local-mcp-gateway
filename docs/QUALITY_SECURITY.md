# Quality and security checks

The project uses layered checks so routine changes catch correctness, dependency, secret, and high-confidence security regressions before merge. Run `npm run check` before review; it covers linting, formatting, type checking, tests, and package verification. The security scripts run a dependency audit, actionlint, targeted Semgrep rules, and Gitleaks, including regression tests for scanner rules and exceptions. Pull requests also receive dependency review. CI also runs CodeQL with the `security-extended` query suite over the repository. The custom Semgrep rules supplement CodeQL with project-specific policy and are not a complete audit or a claim that all vulnerabilities are detected.

| Check                    | Local command                   | What it covers                                                                                      |
| ------------------------ | ------------------------------- | --------------------------------------------------------------------------------------------------- |
| Project quality          | `npm run check`                 | Lint, format, types, tests, and package contents                                                    |
| Dependencies             | `npm run security:deps`         | Known vulnerabilities in installed dependencies                                                     |
| Targeted static analysis | `npm run security:sast`         | Host dynamic evaluation, Node `vm`, shell-based child processes, and disabled TLS verification      |
| Secret detection         | `npm run security:secrets`      | Gitleaks default credential patterns, extended by repository config                                 |
| Workflow validation      | `npm run security:workflows`    | actionlint validates workflow syntax, expressions, and shell snippets where ShellCheck is installed |
| Secret exception tests   | `npm run security:secret-rules` | Positive and negative probes ensure historical digests do not hide credentials                      |
| Rule regression fixtures | `npm run security:rules`        | Positive and negative samples for each maintained Semgrep rule                                      |

Semgrep applies to first-party JavaScript and TypeScript. The host must not evaluate dynamic code or use Node's `vm` module to isolate it; user programs belong in the QuickJS guest runtime. `exec` and `execSync` always invoke a shell and are disallowed; `spawn` and `spawnSync` are only flagged when `shell: true` is explicit. `execFile` and shell-free `spawn` remain allowed. The TLS rule catches explicit `rejectUnauthorized: false` and setting `NODE_TLS_REJECT_UNAUTHORIZED` to `0`. It intentionally does not attempt broad token-flow or credential-logging inference.

A clean scan means only that these checks found no matching issue. It does not prove code is safe, eliminate supply-chain risk, or replace careful review. Keep findings enabled in source and tests; generated dependencies, build output, local state, coverage, and generated benchmark runs/fixtures are excluded by scanner config. Secret scanning still covers tracked first-party source, tests, examples, and benchmark definitions/results outside those generated paths. CI should scan full Git history for secrets so credentials removed from the current tree are still detected.

When a finding is a false positive, first make the code clearer or narrower so the rule can distinguish the safe case. If a real exception remains necessary, add a line-scoped suppression with a brief reason and a regression fixture proving the intended scope. Review rule changes alongside fixtures and avoid global rule disables, broad path exclusions, or suppressing whole files. Rotate and revoke any credential that was exposed; deleting it from the working tree does not invalidate it.

Update this guide and the fixtures whenever rule scope or scan commands change. Review dependency alerts and security findings as part of the normal code review, and record any accepted residual risk with its owner and follow-up date.

The secret scanner keeps historical benchmark results in scope. Four published auth-module SHA-256 fingerprints are allowed only for their exact metadata assignment inside those results; rule-level exceptions avoid skipping whole files. Nine synthetic regression cases verify the allowed digests and detection of other keys, unknown values, out-of-scope paths, and a separate value on the same line.

CodeQL excludes generated and vendored files, frozen benchmark results, and the deliberately unsafe scanner regression fixtures. Product source, product tests, scripts, examples, benchmark programs, and workflow definitions remain in scope. CodeQL runs on GitHub; the local security command does not claim to reproduce that analysis.
