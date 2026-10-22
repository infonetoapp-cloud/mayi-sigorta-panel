# OPS-001 — isolated Worker/Edge authorization acceptance

## Current verdict

LOCAL API: VERIFIED. DEPLOYED EDGE: NOT EXECUTED. PUBLICATION: SEALED.

The actual application Worker entrypoint, password SQLite DO binding/migration and both production-strength login rate limiters have a separate offline configuration at `scripts/recovery/edge-authorization/wrangler.json`. It deliberately has no account, real database UUID, route, production hostname, R2, Queue, service, assets or Cron. `workers_dev=false`, preview URLs off and an `.invalid` PANEL_ORIGIN make it inactive. Required CSRF secret is declared by name only. No test-auth endpoint, auth bypass or runtime change is introduced.

The one permanent configuration test fails if isolation defaults/resources change. The actual Worker bundle can be produced without deployment:

```text
npx wrangler deploy --dry-run --config scripts/recovery/edge-authorization/wrangler.json --outdir <private-output>/worker
```

The zero-like database UUID is an offline sentinel, not a resource. Never deploy this template as-is or use the root production configuration for an experiment. The existing remote recovery provider's builtin synthetic bundle rejects real scrypt credentials; neither this template nor the local API test changes that contract. A remote run must use a separately pinned, extended synthetic export and exact guarded import/verification adapter, not pass arbitrary SQL through or weaken that validator. The local application test already exercises the shared native decoder, query planner/executor and authority SQL on this extended source. No fully automated remote scenario runner is claimed here.

## Required fresh OWNER authorization (not granted by this file)

Proposed exact disposable labels, subject to read-only absence checks before creation:

- Worker `mayisigorta-ops001-auth-edge-01` on its own workers.dev hostname only.
- EU D1 `mayisigorta-ops001-auth-edge-db-01`; one fresh owned UUID, never an existing database.
- One new Worker-owned SQLite `PasswordKdfDurableObject` namespace/migration, at most one named KDF object. It must not bind another Worker's namespace.
- Login limiter namespace IDs48001/48002 must first be shown unused in the selected account; collision means STOP and a fresh exact proposal, not reuse. Limits remain10/minute/account and1000/minute/source.

OWNER must approve the exact account ID, resolved workers.dev origin, a UTC start/end window (proposed maximum60 minutes), maximum operations and verified deletion scope. The existing project account ID may be read from tracked configuration for the proposal but must not be treated as approved infrastructure access. Do not enable workers.dev account-wide or change plan/DNS; if that setup is absent, report a blocker instead.

Proposed limits: one D1 create; one Worker initial deployment and at most one deployment update; one Worker-owned DO namespace migration; one CSRF secret provisioning; at most four restore query batches and one bounded authority batch if performed separately; up to300 HTTPS application requests and500 control-plane/query calls; D1 at most50000 rows read/10000 rows written, total synthetic SQL/storage16MiB. Single owned Worker delete and single owned D1 delete, followed by read-only independent absence verification. If deletion requires further DO metadata operations, obtain exact approval rather than applying production migration/deletion commands. Do not alter any existing Cloudflare resource. These are authorization ceilings, not a measured Cloudflare Free capacity or cost guarantee. Current allowance/headroom must be verified read-only; unavailable Free capacity or any paid requirement is NO-GO.

The current OWNER permission covers local implementation and one Git commit/push only. A fresh remote approval and appropriate credentials through the approved secure mechanism are mandatory; never reuse expired approvals or read Desktop credential files.

## Execution prerequisites and sealing

1. Freeze committed code, clean lockfile install, migration hashes and extended synthetic source/authority hashes. Generate real KDF verifiers and source login cookies before backup. Keep passwords, verifier SQL, cookies and journals private outside Git/logs. Source becomes quiescent for native export; independent offboarding, permission narrowing and session changes happen after backup on the separate source.
2. Read-only account inventory must establish name absence and free allowance. Persist create INTENT before mutation; accept only a uniquely proved returned resource. Unknown create response is STOP/readback, never blind retry/adoption by name. Record exact Worker version, D1 UUID, account and namespace ownership.
3. On a private copy of the offline config, bind only the newly owned D1. Use production APP_ENV, a new short-lived CSRF secret and exact isolated origin. Enable only the approved workers.dev URL for the bounded test, with no custom domain, production binding, document jobs or Cron. The experiment DB never becomes a production resource; exposing synthetic authenticated test routes is not production publication.
4. Prepare and locally verify the extended real-scrypt source transport against schema/migration fingerprints and expected post-authority state. Existing strict provider CLI is NOT an arbitrary extended-fixture importer. Its isolated adapter, exact code/config/source/authority plan hashes and request budgets must be finalized before the remote mutation approval is consumed. Do not patch verifiers into the restored DB after backup or use a session/evaluator bypass.
5. Restore, verify all-table/source/schema/migration/financial/receipt/audit equality, then apply independent pinned authority and revoke old sessions before enabling the test endpoint. Never serve the historical backup between restore and reconciliation. Journal every mutation and reconcile ambiguous results with exact effects; do not replay unknown writes.

## Remote evidence required for PASS

Run HTTPS requests against the deployed Worker, with normal TLS/hostname verification, redirects refused and cookies handled privately. Observe the real KDF DO and configured limiter behavior; a local callback or fabricated response is not evidence. Capture status, bounded non-sensitive assertion results and version/plan hashes, not bodies containing customer details or passwords/tokens.

- Active OWNER and MEMBER can log in, get secure/HttpOnly/SameSite cookies and read authorized customer/policy records; unknown/wrong passwords deny without identifier disclosure.
- Correct password of offboarded staff denies. Every known pre-backup cookie, explicitly revoked cookie and new logout cookie denies on auth and protected APIs. Fresh login must not resurrect a removed grant or widened scope.
- Source formerly allowed quote/HEALTH reads deny after post-backup revocation. OWNER without explicit HEALTH denies too. Both direct IDs and full cursor pagination filter unauthorized/foreign/HEALTH records; successful own/assigned positive controls prevent vacuous deny results.
- Private Task list/context/complete denial is tested while the same member can read the parent customer/policy/renewal and has legacy AGENCY Task grants. Own Task access is positive. Failed mutations create no business effect/receipt duplication; legitimate security audit appends are separated from immutable historical audit evidence.
- Post-backup independent SOURCE authority and restored membership/grant sets and HTTP decisions agree. Current customer/policy ASSIGNED narrowing and permission-version/credential/session revocation remain enforced.
- Wrong/missing Origin or CSRF rejects authenticated mutation; no token in URL/logs; cross-origin isolation and no-store responses are observed. No public provisioning/reset/recovery backdoor is added. Rate-limit test accounts/requests stay inside the approved budget; security controls are not disabled to make the test pass.
- Read back all financial, task, renewal, quote/version, receipt/history/audit and migration fingerprints after probing. Preserve original audits exactly and classify only expected new security events. Require FK0 and SEALED result. Include lost-ack/checkpoint negative controls where separately approved; do not induce ambiguous remote mutations without a bounded reconciliation plan.

## Cleanup is part of acceptance

Stop routing and delete only the proved experiment Worker and D1 within the approved window. Explicitly verify Worker/URL404, D1 exact UUID404, full paginated inventory absence by name/UUID and namespace cleanup semantics; a provider success response alone is insufficient. No unowned resource may be deleted. If namespace disappearance is not provable or the allowance/time window is exhausted, report FAIL/UNKNOWN and request only the missing exact cleanup authority. Preserve failed evidence. Real Edge PASS requires the remote authorization matrix AND verified owned cleanup; it does not close monitoring, production RPO/RTO, custody or production publication.
