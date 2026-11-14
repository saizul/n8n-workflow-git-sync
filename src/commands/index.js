import { backupCommand } from './backup.js';
import { depsCommand } from './deps.js';
import { diffCommand } from './diff.js';
import { docsCommand } from './docs.js';
import { graphCommand } from './graph.js';
import { lintCommand } from './lint.js';
import { pullCommand } from './pull.js';
import { pushCommand } from './push.js';
import { redactCommand } from './redact.js';
import { restoreCommand } from './restore.js';
import { validateCommand } from './validate.js';

/** All commands in the order they appear in the help text. */
export const COMMANDS = Object.freeze([
  pullCommand,
  pushCommand,
  diffCommand,
  lintCommand,
  validateCommand,
  redactCommand,
  graphCommand,
  docsCommand,
  depsCommand,
  backupCommand,
  restoreCommand,
]);

/** @param {string} name */
export function getCommand(name) {
  return COMMANDS.find((command) => command.name === name) ?? null;
}
