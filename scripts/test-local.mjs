// `npm run test:local` - fetch a session from the local dev server and run the
// contract tests with it, so there is no shell incantation to remember and no
// password written inside a test.
//
// Needs `npx wrangler dev` running in another terminal.

import { spawn } from 'node:child_process';

const base = process.env.SNAPIQ_API || 'http://127.0.0.1:8787';
const passphrase = process.env.OPERATOR_PASSPHRASE || 'local-development-only';

let token;
try {
  const response = await fetch(`${base}/v1/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ passphrase }),
  });
  if (!response.ok) {
    console.error(`\n  ${base} refused the passphrase (${response.status}).`);
    console.error('  Check OPERATOR_PASSPHRASE in .dev.vars matches the one being sent.\n');
    process.exit(1);
  }
  token = (await response.json()).token;
} catch {
  console.error(`\n  Nothing is answering at ${base}.`);
  console.error('  Start the server first, in another terminal:  npx wrangler dev\n');
  process.exit(1);
}

const vitest = spawn('npx', ['vitest', 'run', ...process.argv.slice(2)], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, SNAPIQ_TEST_JWT: token, SNAPIQ_API: base },
});
vitest.on('exit', (code) => process.exit(code ?? 1));
