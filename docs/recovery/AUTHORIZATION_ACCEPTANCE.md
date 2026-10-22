# OPS-001 restored authorization — acceptance and reproduction

## Evidence boundary

The accepted local gate runs the default `createApp()` login, identity resolver, session verifier, CSRF, services and authorization against a freshly restored LOCAL D1. The password implementation is the real scrypt SQLite Durable Object through a local workerd bridge. The test does not inject a session verifier or evaluator. HTTP-shaped requests use `app.fetch`, not a deployed public Edge endpoint. Local PASS is not remote Worker/Edge PASS or production publication authority.

`tests/recovery.restored-api.test.ts` contains the ten accepted cases, copied byte-exact from the isolated authorization gate:

- Active OWNER/MEMBER login and authorized customer/policy access.
- Correct offboarded password and all pre-backup cookies denied.
- Quote/HEALTH permissions removed after backup remain denied after fresh login.
- OWNER also needs explicit HEALTH access; policy lists filter HEALTH.
- Tenant and current ASSIGNED policy direct-ID/list boundaries.
- Private Task context/list/complete isolation even with legacy AGENCY Task grants and readable parents; own-Task positive control.
- Independently changed SOURCE authority and restored membership/grant sets/API decisions match.
- A newly logged-out recovered session is denied.
- Current customer ASSIGNED scope and permission-version cookie invalidation.
- Business, financial, quote versions, receipt, migration and historical audit integrity.

A native source export precedes independent source-side authority changes. The four-phase query executor performs restoration and reconciliation into an empty target. A lost authority acknowledgement is reconciled by exact checkpoint without another authority write. All 46 source tables are compared before reconciliation; historical business/audit rows survive later HTTP probes. New security denial audit entries are legitimate append-only evidence. The source contains real synthetic credentials and a second synthetic tenant; it is not the historical fixed114-row remote bundle.

## Clean-checkout reproduction

Prerequisites: Node24 with `node:sqlite`, npm lockfile, and a host supported by the pinned Wrangler/workerd binaries. No Desktop folders, retained archive, Cloudflare login/token, previously generated SQL or local password files are needed. Install from the lockfile:

```text
npm ci
npx vitest run tests/recovery.restored-api.test.ts tests/auth.local.test.ts tests/auth.restore-proof.test.ts tests/recovery.query-phase-executor.test.ts tests/boundaries.test.ts tests/recovery.edge-preparation.test.ts --maxWorkers=1
npm run typecheck
npm run lint
npm run format:check
npm run build
```

Do not run native Wrangler suites concurrently with builds. The original five-file authorization gate was142 PASS/0 FAIL/0 SKIP, including ten new end-to-end cases. `recovery.edge-preparation` adds one separate offline configuration guard, not a deployed Edge result. Final closeout counts/logs are retained externally; historical failures are not rewritten as PASS. Fixtures use fresh OS-temp storage and random synthetic passwords/cookies, which must not be printed or committed.

## Protected status document

The isolated `MayiSigorta_CRM_Planning_Pack_v2/UYGULAMA_DURUMU.md` edit was reviewed. Its meaningful new evidence is preserved here, while the exact prior version and its edited copy remain in the retained archive/isolated worktree. The protected document is not copied into the recovery branch and is not part of this commit. The original142-test, local-only, SEALED qualification is retained; the previous next-task statement is superseded by this authorized integration, not by editing that protected file.

## External gates remain open

Historical authorization closeout stopped at eight affected packages (four high, four moderate), including runtime Hono and development tooling; that FAIL record is preserved. The separately authorized focused [dependency remediation](DEPENDENCY_SECURITY.md) now applies compatible patches and narrowly scoped emulator overrides, with full npm audit reporting zero findings. No blanket force fix or Wrangler/workerd generation upgrade was used. This resolves that dependency blocker, not the remaining deployed Edge or production acceptance requirements.

See [EDGE_AUTHORIZATION_GATE.md](EDGE_AUTHORIZATION_GATE.md) for the runnable offline deployment configuration, exact proposed disposable resource scope, approval requirements and remote acceptance matrix. Native remote import, independent authority authenticity/custody, populated tombstone/single-use sensitive-grant reconciliation, monitoring/alarm delivery, measured production RPO/RTO and sealed-to-publication authorization remain distinct. No remote resource, deployment, production mutation or main merge is authorized by these documents.
