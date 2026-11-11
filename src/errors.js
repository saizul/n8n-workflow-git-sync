/**
 * Error types used across the CLI. Every error carries an `exitCode` so the
 * command runner can translate failures into predictable process exit codes.
 */

/** Exit codes used by the CLI. */
export const EXIT = Object.freeze({
  OK: 0,
  /** Findings were reported (diff has changes, lint has errors, validation failed). */
  FINDINGS: 1,
  /** Usage or configuration error. */
  USAGE: 2,
  /** Remote API or network failure. */
  API: 3,
  /** Push refused because of a conflict. */
  CONFLICT: 4,
  /** Unexpected internal failure. */
  INTERNAL: 70,
});

export class CliError extends Error {
  /**
   * @param {string} message
   * @param {number} [exitCode]
   */
  constructor(message, exitCode = EXIT.INTERNAL) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}

export class UsageError extends CliError {
  /** @param {string} message */
  constructor(message) {
    super(message, EXIT.USAGE);
    this.name = 'UsageError';
  }
}

export class ConfigError extends CliError {
  /** @param {string} message */
  constructor(message) {
    super(message, EXIT.USAGE);
    this.name = 'ConfigError';
  }
}

export class ApiError extends CliError {
  /**
   * @param {string} message
   * @param {{status?: number, method?: string, url?: string, body?: unknown, attempts?: number, cause?: unknown}} [details]
   */
  constructor(message, details = {}) {
    super(message, EXIT.API);
    this.name = 'ApiError';
    this.status = details.status ?? 0;
    this.method = details.method ?? '';
    this.url = details.url ?? '';
    this.body = details.body;
    this.attempts = details.attempts ?? 1;
    if (details.cause !== undefined) this.cause = details.cause;
  }
}

export class ConflictError extends CliError {
  /**
   * @param {string} message
   * @param {Array<{id: string, name: string, reason: string}>} [conflicts]
   */
  constructor(message, conflicts = []) {
    super(message, EXIT.CONFLICT);
    this.name = 'ConflictError';
    this.conflicts = conflicts;
  }
}

export class ValidationError extends CliError {
  /**
   * @param {string} message
   * @param {unknown[]} [issues]
   */
  constructor(message, issues = []) {
    super(message, EXIT.FINDINGS);
    this.name = 'ValidationError';
    this.issues = issues;
  }
}
