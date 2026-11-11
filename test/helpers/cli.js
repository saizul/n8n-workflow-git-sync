import { run } from '../../src/cli.js';
import { BASE_URL, TEST_API_KEY } from './mock-n8n.js';

/**
 * Drive the CLI in-process and capture its output.
 * @param {string[]} argv
 * @param {{cwd: string, mock?: {fetch: typeof fetch}, env?: Record<string, string>, now?: () => Date}} context
 * @returns {Promise<{code: number, out: string, err: string}>}
 */
export async function cli(argv, context) {
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  const err = [];
  const env = context.env ?? (context.mock ? { N8N_BASE_URL: BASE_URL, N8N_API_KEY: TEST_API_KEY } : {});
  const code = await run(argv, {
    env,
    cwd: context.cwd,
    fetch: context.mock?.fetch,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    sleep: async () => {},
    now: context.now,
  });
  return { code, out: out.join(''), err: err.join('') };
}
