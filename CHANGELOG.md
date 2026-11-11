# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-11-11

Initial release.

### Added

- `pull`: export workflows as deterministic JSON files (`<slug>--<id>.json`) with a sync
  manifest; rename tracking, pruning, grouping by tag or project, tag and activity filters,
  dry-run, JSON output and `--fail-on-change`.
- `push`: create and update workflows with dry-run, conflict detection (exit code 4) and
  `--force`, id maps for promotion between instances, credential remapping by name and type,
  `--credential-map`, tag synchronisation and activation handling.
- `diff`: semantic diff between an instance and local files or between two directories, with
  rename detection, text and JSON output and a CI exit code.
- `lint`: rule engine with 14 rules, severities and options from `.n8nsyncrc.json`, `--rule`
  overrides, inline ignore directives, and text, JSON, SARIF 2.1.0 and GitHub annotation
  output.
- `redact`: detection of hard-coded secrets (token formats, sensitive key names, entropy)
  with mask and strip modes, in-place rewrite, redacted copies and `--check`.
- `validate`: structural validation of workflow files, including duplicate ids across files.
- `graph`: Mermaid and Graphviz DOT rendering.
- `docs`: Markdown catalogue of workflows with optional graphs and a `--check` mode.
- `backup` and `restore`: snapshot directories with a sha256 manifest, verification,
  retention by count and age, restore into a directory or onto an instance.
- HTTP client with timeout, retry and exponential backoff on 429/5xx and network errors,
  `Retry-After` support, cursor pagination and an injectable `fetch`.
- Configuration from flags, environment variables and `.n8nsyncrc.json`, including named
  environments.
- Example workflows, an example configuration file and a nightly pull workflow for GitHub
  Actions.

[Unreleased]: https://github.com/saizul/n8n-workflow-git-sync/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/saizul/n8n-workflow-git-sync/releases/tag/v0.1.0
