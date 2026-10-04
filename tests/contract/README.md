# Contract tests

These are the specification in [docs/api.md](../../docs/api.md), written as tests. They talk
to the API over HTTP and know nothing about how it is built, so the implementation has to
satisfy them rather than the other way round.

They were written **before** the implementation, on purpose. Until a server exists they fail
on a refused connection, which is the right failure for a specification.

## Running them

```bash
npm install
SNAPIQ_API=http://127.0.0.1:8787 SNAPIQ_TEST_JWT=<session for the seeded account> npm test
```

| variable | |
|---|---|
| `SNAPIQ_API` | base URL of the API (default `http://127.0.0.1:8787`) |
| `SNAPIQ_TEST_JWT` | a signed-in session for the seeded test account |

## What is in which file

| file | what it pins down |
|---|---|
| `pairing.test.js` | a phone is paired once by QR, listed, and revoked for good; a used claim token is worthless |
| `delivery.test.js` | a page lands on the waiting computer in under two seconds; a scan sent with nothing open waits; **polling returns exactly what the stream delivered** |
| `scope.test.js` | what each credential *cannot* do — the phone key reads nothing, a computer sees only its own channel, no error ever echoes a credential |
| `scanning.test.js` | four pages become one document; the size and resolution caps; a wrong checksum leaves nothing behind; retries are idempotent |

`scope.test.js` is the one to read first. It is the reason a long-lived key can sit on a phone
at all: lose the phone and someone can send documents *in*, never pull documents *out*.

## One thing deliberately not covered

Proof 10 of `docs/api.md` §10 asks that no log line contains a token, a file name or image
bytes. That cannot be observed over HTTP, so it is checked against the implementation when
logging is written. It is left unasserted here rather than covered by a test that only
appears to check it.
