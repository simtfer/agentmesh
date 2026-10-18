# Test TLS fixtures — throwaway, never trust these

Two independent certificate authorities, each with a server certificate, used
only by `test/deploy.test.ts` to exercise the TLS and mutual-TLS paths without
depending on `openssl` being installed or on any network.

| directory     | contents                                            | used for                       |
| ------------- | --------------------------------------------------- | ------------------------------ |
| `trusted/`    | `ca.pem`, `server.pem`, `server-key.pem`, `client.pem`, `client-key.pem` | the daemon's cert and a valid mTLS client |
| `untrusted/`  | `ca.pem`, `server.pem`, `server-key.pem`            | a second CA: proves a cert from the *wrong* CA is refused |

Both server certificates carry `SAN = DNS:localhost, IP:127.0.0.1`, so they only
work for loopback tests. They are valid for 825 days from generation and are
regenerated with:

```bash
bash deploy/certs/make-certs.sh --out test/fixtures/tls/trusted   --prefix agentmesh-test
bash deploy/certs/make-certs.sh --out test/fixtures/tls/untrusted --prefix agentmesh-test-rogue --no-client
```

**These private keys are committed on purpose so the test suite stays hermetic.
They protect nothing: never use them, or any certificate signed by them, for a
real deployment.** Generate your own with `deploy/certs/make-certs.sh`.
