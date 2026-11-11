# Contributing

Thanks for taking the time to improve n8n-workflow-git-sync. Bug reports, rule ideas and pull
requests are all welcome.

## Getting started

You need Node.js 22 or newer. The project has no runtime dependencies and no build step.

```sh
git clone https://github.com/saizul/n8n-workflow-git-sync.git
cd n8n-workflow-git-sync
npm ci
npm test
node bin/n8n-sync.js lint examples/
```

Run a single test file while you work on it:

```sh
node --test test/push.test.js
node --test --test-name-pattern "conflict" test/push.test.js
```

## Project layout

```text
bin/n8n-sync.js        executable entry point
src/cli.js             argument dispatch, exit codes, error reporting
src/commands/          one module per command: options, help text, wiring
src/sync/              pull, push, id and credential remapping
src/workflow/          normalisation, file store, validation, graph, rendering
src/lint/              rule engine, formatters, rules/
src/secrets/           secret detection and redaction
src/diff/              semantic diff and its formatters
src/docs/              Markdown catalogue
src/backup/            snapshots
src/http.js            HTTP client (timeout, retry, backoff)
src/api.js             n8n public API v1 client
src/config.js          flags, environment variables, .n8nsyncrc.json
test/helpers/          in-memory mock of the n8n API, fixtures, CLI driver
```

## Guidelines

- **Plain ESM JavaScript with JSDoc types.** No transpiler, no runtime dependencies. Think
  twice before adding a development dependency.
- **Every change needs a test.** Tests use `node:test` and `node:assert/strict`. Anything
  that talks to n8n goes through the mock in `test/helpers/mock-n8n.js`; tests never open a
  network connection.
- **No secret-shaped literals in the repository.** Tests that need something that looks like
  a token build it at runtime with `fakeSecret()` from `test/helpers/fixtures.js`. Example
  workflows use `example.com` hosts and placeholders such as `YOUR_API_KEY`.
- **Never log the API key or a detected secret.** There are tests for this; keep them green.
- **Deterministic output.** Files written by `pull`, `docs` and `backup` must be byte-for-byte
  reproducible for the same input.
- **Exit codes are part of the interface.** See the table in the README before changing one.

## Adding a lint rule

1. Add the rule to the matching file under `src/lint/rules/` (`security.js`,
   `reliability.js`, `structure.js` or `style.js`). A rule is an object with `id`,
   `description`, a default `severity` and a `check({ workflow, graph, options, nodes })`
   function that returns findings (`{ message, node?, path? }`).
2. Register it in `src/lint/rules/index.js`.
3. Add tests to `test/lint-rules.test.js`: at least one workflow that triggers the rule and
   one that does not.
4. Add a row to the rule table in the README and a line to the changelog.

## Behaviour against real n8n versions

The test suite runs against a mock that models the public API v1. If you find that a real
n8n version behaves differently (a rejected field, a different status code, a changed
pagination detail), please open an issue with the n8n version and the request and response,
with the API key and any private data removed. A failing test against the mock that
reproduces the real behaviour is the most helpful form of bug report.

## Pull requests

- Keep a pull request focused on one change.
- Run `npm test` and `node bin/n8n-sync.js lint examples/` before pushing; CI runs both on
  Node.js 22 and 24.
- Update `CHANGELOG.md` under "Unreleased".

## Reporting security issues

Please do not open a public issue for a vulnerability. Use GitHub's private vulnerability
reporting on the repository instead.

## License

By contributing you agree that your contributions are licensed under the MIT License.
