# n8n-workflow-git-sync

Keep the workflows of a self-hosted [n8n](https://n8n.io) instance under version control.

`n8n-sync` is a small command-line tool that talks to the n8n public REST API. It exports
workflows as stable, diff-friendly JSON files, pushes them back (to the same instance or to
another one), and adds the tooling you want around a workflow repository: a semantic diff, a
linter, secret redaction, structural validation, graphs, a Markdown catalogue and checksummed
backups.

- Node.js 22 or newer
- No runtime dependencies
- MIT licensed

## Contents

- [Features](#features)
- [Install](#install)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Commands](#commands)
- [Lint rules](#lint-rules)
- [Promoting workflows from dev to prod](#promoting-workflows-from-dev-to-prod)
- [Continuous integration](#continuous-integration)
- [Security notes](#security-notes)
- [Limitations](#limitations)
- [Verification status](#verification-status)
- [Using it as a library](#using-it-as-a-library)

## Features

| Command | What it does |
| --- | --- |
| `pull` | Exports every workflow to `<slug>--<id>.json` with sorted keys and volatile fields removed, so that a re-pull of an unchanged instance produces no diff. |
| `push` | Creates or updates workflows from files. Dry-run, conflict detection, id mapping between instances, credential remapping by name, tag sync, activation handling. |
| `diff` | Semantic diff (nodes added/removed/renamed, parameter paths, connections, settings, tags) between files and an instance or between two directories. Text or JSON, CI exit code. |
| `lint` | 14 rules for security, reliability, structure and style. Severities configurable, inline ignores, output as text, JSON, SARIF or GitHub annotations. |
| `redact` | Finds hard-coded secrets in node parameters and masks or strips them. `--check` mode for CI. |
| `validate` | Structural checks: required fields, node shape, dangling connections, duplicate ids. |
| `graph` | Renders a workflow as a Mermaid flowchart or Graphviz DOT. |
| `docs` | Generates a Markdown catalogue of all workflows (triggers, nodes, credentials, tags, optional graphs). `--check` fails when the file is stale. |
| `backup` / `restore` | Timestamped snapshot directories with a sha256 manifest, retention pruning, verification, and restore to a directory or back onto an instance. |

## Install

The package is not published to the npm registry yet. Install it from GitHub:

```sh
npm install --global github:saizul/n8n-workflow-git-sync
n8n-sync --version
```

Or run it from a clone:

```sh
git clone https://github.com/saizul/n8n-workflow-git-sync.git
cd n8n-workflow-git-sync
node bin/n8n-sync.js --help
```

## Quick start

Create an API key in n8n (Settings, then n8n API), then:

```sh
export N8N_BASE_URL=https://n8n.example.com
export N8N_API_KEY=YOUR_API_KEY

n8n-sync pull                 # writes ./workflows/*.json and a manifest
git add workflows && git commit -m "Import workflows"

# ...edit a workflow in the n8n editor...
n8n-sync diff                 # what differs between the instance and the files?
n8n-sync pull                 # bring the files up to date

# ...or edit a file and send it back...
n8n-sync push --dry-run
n8n-sync push
```

## Configuration

Settings are resolved in this order, first match wins:

1. Command-line flags (`--base-url`, `--api-key`, `--dir`, ...)
2. Environment variables: `N8N_BASE_URL`, `N8N_API_KEY`, `N8N_SYNC_ENV`, `N8N_SYNC_DIR`
3. `.n8nsyncrc.json`, searched upwards from the working directory (or given with `--config`)

One deliberate exception: when you select a named environment explicitly with `--env <name>`,
the base URL and key of that environment win over the generic `N8N_BASE_URL` / `N8N_API_KEY`
variables. Otherwise `n8n-sync push --env prod` could silently talk to whatever instance a
leftover shell variable points at. Explicit `--base-url` / `--api-key` flags still win.

A complete example lives in [`examples/.n8nsyncrc.json`](examples/.n8nsyncrc.json):

```json
{
  "dir": "workflows",
  "defaultEnvironment": "dev",
  "environments": {
    "dev": { "baseUrl": "https://n8n-dev.example.com", "apiKeyEnv": "N8N_DEV_API_KEY" },
    "prod": {
      "baseUrl": "https://n8n.example.com",
      "apiKeyEnv": "N8N_PROD_API_KEY",
      "idMap": ".n8n-sync/prod.idmap.json",
      "credentialMap": { "CRM API": "CRM API (production)" }
    }
  },
  "lint": {
    "rules": {
      "missing-error-workflow": ["warning", { "onlyActive": true }],
      "no-disabled-nodes": "off"
    }
  },
  "backup": { "dir": "backups", "keep": 14 }
}
```

`apiKeyEnv` names the environment variable that holds the key for that environment. Keeping
keys out of the file is strongly recommended; see [Security notes](#security-notes).

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Findings or differences (lint errors, a non-empty diff, secrets found by `redact --check`, stale docs, a failed verification) |
| 2 | Usage or configuration error |
| 3 | The n8n API returned an error or could not be reached |
| 4 | Conflict: a workflow changed remotely since the last sync |
| 70 | Internal error |

## Commands

Every command accepts `--help`. The global options are `--config`, `--env`, `--base-url`,
`--api-key`, `--timeout`, `--retries`, `--verbose` and `--quiet`.

### pull

```sh
n8n-sync pull
n8n-sync pull --dir automation --group-by tag
n8n-sync pull --tag billing --active-only
n8n-sync pull --dry-run --json
n8n-sync pull --fail-on-change        # exit 1 when anything changed (drift detection)
```

- Files are named `<slug-of-name>--<id>.json`. Renaming a workflow renames its file.
- Keys are sorted and volatile fields (`updatedAt`, `versionId`, `staticData`, sharing metadata, ...) are
  removed; pass `--no-strip-volatile` to keep them. Pinned data is dropped unless
  `--keep-pin-data` is given.
- Files of workflows that no longer exist remotely are deleted (`--no-prune` keeps them).
- A manifest, `n8n-sync.manifest.json`, records the content hash of each workflow at the time
  of the last sync. `push` uses it to detect remote edits.

### push

```sh
n8n-sync push --dry-run
n8n-sync push
n8n-sync push "Order intake" --force
n8n-sync push --env prod --id-map env/prod.idmap.json --activate never
n8n-sync push --credential-map "CRM API=CRM API (production)"
```

- A workflow with a known id is updated; one without is created. After a create on the
  source instance the file is renamed to carry the new id.
- **Conflict detection:** if the remote workflow no longer matches the hash recorded at the
  last sync, nothing is written and the command exits with code 4. Pull and merge, or pass
  `--force` to overwrite.
- **Credentials** are referenced by id inside workflow JSON. Before writing, `push` looks up
  the credentials on the target instance and rewrites each reference to the id of the
  credential with the same name and type. `--credential-map from=to` (or `credentialMap` in an
  environment) renames on the way. A credential that cannot be found produces a warning and
  the reference is pushed unchanged.
- **Activation** (`--activate`): `keep` mirrors the `active` flag of each file, `never` leaves
  activation alone, `always` activates everything.
- **Tags** are synchronised by name and created when missing (`--no-tags` to skip).

### diff

```sh
n8n-sync diff                                  # instance vs ./workflows
n8n-sync diff --format json
n8n-sync diff --env prod --match-by name --ignore-credential-ids
n8n-sync diff exports/dev exports/prod         # two directories, no API needed
```

```text
~ workflow "Order intake" (101)
    ~ node "Look up customer" (httpRequest)
        ~ parameters.url: "https://crm.example.com/v1" -> "https://crm.example.com/v2"
    + connection Look up customer -> Notify sales

0 added, 0 removed, 1 changed, 1 unchanged
```

Node positions are ignored unless `--position` is given. The command exits with 1 when
differences are found; `--no-exit-code` turns that off.

### lint

```sh
n8n-sync lint
n8n-sync lint workflows/ --format github
n8n-sync lint --format sarif --output n8n-lint.sarif
n8n-sync lint --rule no-disabled-nodes=off --rule naming-convention=warning
n8n-sync lint --fail-on warning
n8n-sync lint --list-rules
```

The command exits with 1 when a finding at or above `--fail-on` exists (default: `error`).
See [Lint rules](#lint-rules) for the rule set, configuration and inline ignores.

### validate

```sh
n8n-sync validate
n8n-sync validate workflows/ --strict --json
```

Checks that every file is a workflow n8n can import: name, node list, node shape,
connections that point at existing nodes, duplicate workflow ids across files. `--strict`
turns warnings into failures.

### redact

```sh
n8n-sync redact --check                          # CI: exit 1 when secrets are present
n8n-sync redact --write                          # rewrite the files in place
n8n-sync redact workflows/ --mode strip --out-dir public-export/
n8n-sync redact workflows/billing--7.json > billing.redacted.json
```

Detection combines known token formats, sensitive key names (`password`, `apiKey`,
`authorization`, ...) and an entropy heuristic. n8n expressions (`={{ ... }}`) and obvious
placeholders are left alone. Detected values are never printed in full.

### graph

```sh
n8n-sync graph "Order intake"
n8n-sync graph workflows/order-intake--101.json --format dot | dot -Tsvg > order-intake.svg
n8n-sync graph 101 --direction TB --markdown --output docs/order-intake.md
```

### docs

```sh
n8n-sync docs --output WORKFLOWS.md --graphs
n8n-sync docs --output WORKFLOWS.md --graphs --check   # CI: fail when the file is stale
```

### backup and restore

```sh
n8n-sync backup                           # backups/20260301T100000Z/
n8n-sync backup --label pre-upgrade --keep 14 --max-age-days 90
n8n-sync backup --list
n8n-sync backup --verify latest
n8n-sync backup --prune-only --keep 7

n8n-sync restore --to-dir restored/       # latest snapshot into a directory
n8n-sync restore 20260301T100000Z --dry-run
n8n-sync restore 20260301T100000Z         # back onto the instance
```

A snapshot is a plain directory, with no archive format involved:

```text
backups/20260301T100000Z/
  snapshot.json          name, creation time, source, and a sha256 per file
  workflows/*.json
```

`restore` always verifies the checksums first and refuses a snapshot that fails. Restoring
onto an instance updates workflows that still exist and recreates the ones that were deleted.

## Lint rules

| Rule | Default | What it checks |
| --- | --- | --- |
| `valid-structure` | error | The workflow JSON is structurally valid (same checks as `validate`). |
| `no-hardcoded-secrets` | error | Node parameters do not contain literal credentials. |
| `webhook-authentication` | error | Webhook and form trigger nodes require authentication. |
| `duplicate-node-names` | error | Node names are unique; connections are keyed by name. |
| `no-pinned-data` | warning | No pinned test data is committed; it can contain production records. |
| `node-error-handling` | warning | Nodes that call external systems retry, continue on failure, or are covered by an error workflow. |
| `missing-error-workflow` | warning | Workflows that run unattended set `settings.errorWorkflow`. |
| `http-timeout-retry` | warning | HTTP Request nodes set a timeout and retry on failure. |
| `deprecated-node-versions` | warning | Deprecated node types and outdated type versions (the list is configurable). |
| `no-orphan-nodes` | warning | Every node is connected and reachable from a trigger. |
| `no-cycles` | warning | No connection cycle exists that does not pass through a loop node. |
| `no-disabled-nodes` | warning | No disabled nodes are left in the workflow. |
| `naming-convention` | info | Workflows and nodes have meaningful names, optionally matching configured patterns. |
| `sticky-note-documentation` | info | Large workflows are documented with at least one sticky note. |

### Configuring rules

In `.n8nsyncrc.json`, a rule is set to a severity (`error`, `warning`, `info`, `off`) or to a
`[severity, options]` pair:

```json
{
  "lint": {
    "ignoreWorkflows": ["Scratch *"],
    "rules": {
      "no-disabled-nodes": "off",
      "http-timeout-retry": ["error", { "maxTimeoutMs": 60000 }],
      "naming-convention": ["warning", { "workflowPattern": "^[A-Z]" }],
      "sticky-note-documentation": ["info", { "minNodes": 8 }]
    }
  }
}
```

`--rule id=severity` on the command line overrides the file for one run.

### Inline ignores

Put a directive in the **notes** of a node to silence findings for that node:

```text
n8n-sync-ignore: http-timeout-retry, node-error-handling
```

`n8n-sync-ignore` without a list silences every rule for the node. To skip a whole workflow,
put `n8n-sync-ignore-workflow` (optionally followed by `: rule, rule`) in a sticky note.

### Output formats

- `text` for people
- `json` for scripts (`findings` plus a `summary`)
- `sarif` (2.1.0) for code-scanning dashboards
- `github` for workflow command annotations on pull requests

## Promoting workflows from dev to prod

Workflow ids and credential ids differ between instances. The id map and the credential
lookup by name bridge that gap, so the same files can be pushed to several instances.

```sh
# 1. Export from dev and commit.
n8n-sync pull --env dev
git add workflows && git commit -m "Update workflows"

# 2. Review what would change in prod.
n8n-sync diff --env prod --match-by name --ignore-credential-ids
n8n-sync push --env prod --id-map env/prod.idmap.json --dry-run

# 3. Promote.
n8n-sync backup --env prod --label pre-release
n8n-sync push --env prod --id-map env/prod.idmap.json --activate never
git add env/prod.idmap.json && git commit -m "Record prod workflow ids"
```

What happens during a promotion push:

- The id map file (`{"version": 1, "workflows": {"<dev id>": "<prod id>"}, ...}`) is read. A
  workflow with a mapped id is updated on prod; an unmapped one is created and the new id is
  written to the map. **Commit the id map**; without it the next push would create duplicates.
- The source directory is never modified in promotion mode. The files keep their dev ids.
- References to other workflows (Execute Workflow nodes, `settings.errorWorkflow`) are
  rewritten through the id map.
- Credential references are rewritten to the prod credential with the same name and type.
  Create the credentials on prod first; credential secrets are never transferred.
- `--activate never` leaves activation to a person. Use `keep` to mirror the files.

With `idMap` set on the `prod` environment in `.n8nsyncrc.json`, `--id-map` can be omitted.

## Continuous integration

Checks that need no access to an instance, suitable for pull requests:

```yaml
- run: n8n-sync validate workflows --strict
- run: n8n-sync redact workflows --check
- run: n8n-sync lint workflows --format github
- run: n8n-sync docs workflows --output WORKFLOWS.md --check
```

[`examples/github-actions/nightly-pull.yml`](examples/github-actions/nightly-pull.yml) is a
complete scheduled workflow that pulls every night and commits when something changed.

## Security notes

- **The API key is sent only in the `X-N8N-API-KEY` header** and is never written to logs,
  error messages or debug output. The logger additionally masks the configured key should it
  ever appear in a message.
- **Prefer environment variables for keys.** `--api-key` ends up in shell history and process
  listings. `apiKey` in `.n8nsyncrc.json` is supported but should not be committed; use
  `apiKeyEnv` instead.
- **Workflow JSON does not contain credential secrets**, only credential ids and names. It can
  still contain secrets that someone typed directly into a node parameter. Run
  `n8n-sync redact --check` in CI and before the first commit of an existing instance.
- **Secret detection is heuristic.** It will miss some secrets and flag some harmless
  strings. Treat a clean result as a good sign, not as proof.
- **Pinned data may contain production records.** `pull` drops it by default.
- **Use HTTPS** for the base URL; the key is sent with every request.
- **Give the key no more access than needed.** A key used only for `pull`, `diff` and `backup`
  needs read access to workflows. `push` and `restore` need write access, and read access to
  credential metadata for the remapping.
- `--env` takes precedence over the generic environment variables, as described under
  [Configuration](#configuration), so that a stale `N8N_BASE_URL` cannot redirect a
  production push.

## Limitations

- Only workflows and tags are synchronised. Credentials (beyond the metadata used for
  remapping), executions, variables, users and projects are out of scope.
- Credential secrets are never read or transferred; the n8n API does not expose them.
- Listing credentials is not available on every n8n version or licence. When the instance
  refuses, `push` prints a warning and leaves credential ids unchanged.
- Conflict detection relies on the manifest written by `pull` and `push`. A workflow that was
  never synced has no baseline; it is pushed without a conflict check and with a warning.
- `push` does not delete remote workflows that have no local file.
- The diff recognises a renamed node by its node id, or by otherwise identical content. A
  node without an id that was renamed and edited at once shows up as a removal plus an
  addition.
- The deprecated node list of `deprecated-node-versions` is a small built-in table plus your
  own configuration; it is not synchronised with n8n releases.
- Snapshots are plain directories and are not encrypted. Protect the backup directory
  like the instance itself.

## Verification status

The HTTP client and all commands are tested against an in-memory mock of the n8n public API
v1 (`/api/v1/workflows`, `/api/v1/tags`, `/api/v1/credentials`, cursor pagination,
activation endpoints, error responses) that was written from the public API documentation.
The tool has **not** been verified against a live n8n instance as part of this repository's
test suite. n8n changes endpoint behaviour between versions (for example which fields a
workflow update accepts, and whether credentials can be listed), so confirm the behaviour
against your n8n version before relying on it: start with `pull`, `diff` and
`push --dry-run`, and take a `backup` before the first real `push`.

## Using it as a library

Everything the CLI does is exported from the package entry point:

```js
import { createClient, pullWorkflows, lintWorkflow, diffWorkflows, toMermaid } from 'n8n-workflow-git-sync';
```

The API follows the CLI closely but is not yet covered by a stability promise before 1.0.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Changes are listed in [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE). Copyright (c) 2026 Saizul Amin.
