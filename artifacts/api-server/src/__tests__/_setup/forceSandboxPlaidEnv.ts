// (#654) Force PLAID_ENV=sandbox for the api-server test suite. The
// real .env in this repl is `PLAID_ENV=Production`, but virtually
// every integration test seeds Plaid items with `access-sandbox-…`
// access tokens (and mocks the Plaid client to return canned
// responses, so the env never actually matters). The env-mismatch
// guard added in #654 would otherwise short-circuit those flows
// before the mocks are exercised, breaking dozens of pre-existing
// tests that have nothing to do with #654.
//
// Tests that specifically need a non-sandbox PLAID_ENV (the
// plaidEnvMismatchToken integration test, the plaidEnv unit test)
// override `process.env.PLAID_ENV` themselves at module load and
// restore it in afterAll, which composes correctly with this default.
process.env.PLAID_ENV = "sandbox";
