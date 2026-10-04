// Prints a session token for the local dev server, so the contract tests can run:
//   SNAPIQ_TEST_JWT=$(node scripts/token.mjs) npm test
const base = process.env.SNAPIQ_API || 'http://127.0.0.1:8787';
const response = await fetch(`${base}/v1/session`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ passphrase: process.env.OPERATOR_PASSPHRASE || 'local-development-only' }),
});
if (!response.ok) {
  console.error(`could not get a session: ${response.status} ${await response.text()}`);
  process.exit(1);
}
process.stdout.write((await response.json()).token);
