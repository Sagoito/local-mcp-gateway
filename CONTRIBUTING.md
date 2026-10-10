# Contributing

Thanks for helping improve Weftly. Before opening a pull request, run the same checks used by CI:

```sh
npm ci --ignore-scripts
npm run check
```

The quality check covers formatting, linting, type checking, tests, and package validation. CI runs it on Ubuntu with Node.js 26.11.1 (the minimum supported version) and the latest Node.js 26 release, and on Windows and macOS with the latest Node.js 26 release. The development version is pinned in `.nvmrc`. The gateway is exercised without real OAuth credentials or live upstream services.

## Security checks

Run the dependency audit and the local source and secret scans with:

```sh
npm run security
```

The dependency audit checks production and development dependencies and fails on high or critical advisories. The Semgrep scan uses the repository's local `.semgrep.yml` rules and does not require an account or cloud token. The secret scan checks the working tree; CI also scans the full Git history.

For local security runs, install the pinned CLI versions used by CI: Semgrep 1.180.0 (`python -m pip install 'semgrep==1.180.0'`) and Gitleaks 8.30.1 from the [official Gitleaks release](https://github.com/gitleaks/gitleaks/releases/tag/v8.30.1). Verify the downloaded Gitleaks archive against the checksum file published with that release. Also install [actionlint 1.7.12](https://github.com/rhysd/actionlint/releases/tag/v1.7.12) for workflow validation and verify its release checksums. `npm run security` also tests the scanner rules and secret-scan exceptions before scanning source and files. Scanner metrics and version checks are disabled; no cloud scan service is used.

These tools are only needed for security scans; no hooks or scanners are installed into the gateway runtime.

## Dependency updates

Dependabot groups minor and patch updates and opens major upgrades separately. Every update must pass the same quality and security checks as other changes; QuickJS and validation-library updates also exercise the sandbox and input-validation regression tests.

Builds and type-checks use TypeScript 7.0.2. Typed ESLint currently uses TypeScript 6's API through a development-only compatibility alias (`typescript` → `@typescript/typescript6`); this bridge is not a runtime dependency and does not imply typed-lint support for the TypeScript 7 API. Revisit the bridge when typed ESLint supports TypeScript 7.

GitHub Actions also runs CodeQL's JavaScript and TypeScript `security-extended` query suite and dependency review on pull requests. Those checks report findings in GitHub and are not represented by the local `npm run check` command. Repository branch protection must be configured separately to make any workflow status a merge requirement.
