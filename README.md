# Approved V4 source-only backup candidate

This standalone repository preserves the approved product source snapshot without importing its Git history. It is a local backup candidate, not a release or deployment authorization.

## Provenance and exact differences

Original approved commit: `ce487627b7ed012afe0a2dc9f9260c27a864d396`.

`SOURCE_BACKUP_MANIFEST.json` enumerates every original tracked file, its Git blob ID and SHA-256, and whether it was retained or excluded. All 692 retained original files are byte-identical to their approved Git blobs. No application logic, UI, security, permission, money, test, migration or configuration content was edited.

The 125 excluded files are historical acceptance/planning/agent documents, provider/account evidence, generated evidence and unaccepted experiments. Their contents and history remain in the original repository and original recovery archives. Only the imported `engineering-drafts/m4-csrf-local/config-candidate.ts` helper is retained from engineering drafts because existing tests require it.

The only added files are this README and `SOURCE_BACKUP_MANIFEST.json`. Manifest hashes and the textual provenance SHA do not introduce original Git objects or ancestry.

Required font files and the OFL license are retained. File eligibility is based on product/test/build dependencies, not a blanket image-extension exclusion. No approved application PNG was present in this source snapshot.

## Local reproduction

Use the exact Node/npm-compatible toolchain and dependency versions in `package-lock.json`. A clean machine requires dependency installation before execution. No credentials belong in this repository.

    npm ci
    npm run build:client
    npm run typecheck
    npm run lint
    npm run verify:boundaries
    npm run demo

The demo uses locally generated synthetic users and data, not production accounts. Build artifacts, dependencies, temporary databases and test logs are not backup source files.

The preparation verification uses offline esbuild bundles for the API, Worker, D1-backup Worker and private document-backup leaf. It deliberately does not invoke `npm run build`/`build:worker`, Wrangler deployment, Cloudflare account access, or production operations.

## Privacy and configuration boundary

Historical real OWNER names, email addresses and identity/state evidence are excluded. Known personal OWNER identifiers are checked against every retained file. Test-only synthetic secrets and deliberately repetitive cryptographic fixtures remain required test data, not operational credentials. The environment example contains a synthetic marker, not a real secret.

Existing non-secret infrastructure account/resource IDs, public hostnames, binding names, safety pins and deployment configuration are retained where present in approved source/config/tests. Removing or replacing safety-pinned identifiers would change approved source and is not part of this backup preparation. Retention does not grant deployment authority or verify the current production environment.

Gitleaks raw detections are retained in the external verification directory with fully redacted values. Ten detections were reviewed: nine synthetic test fixtures and one non-secret schema checksum. No scanner suppression or source allowlist was added. Content scanning reduces risk; it is not a mathematical proof of absence of all unknown sensitive values.

## Ancestry and test limitations

This repository is initialized independently, not cloned, and its single root commit has no parent, object alternates, original-history refs or original historical commits. Product blobs intentionally match approved source blobs; excluded evidence blobs are not reachable.

Six unchanged historical tests depend on `git show` of original commits: `auth.production-config`, `auth.scrypt.config`, `documents.private-config`, and migration tests `0018`, `0019`, `0020`. Those original commits are intentionally unavailable here. These tests remain as source; their historical comparisons cannot run unchanged in an ancestry-free backup. Their presence is not a claim that the complete historical suite passes.

The external verification directory records the exact selected current-product regression inventory, actual results, build/lint/typecheck results, content review, original-repository preservation, and independent bundle restore checks. Only executed, passing gates are reported as passing.

## Restore and stop boundary

The preparation directory also contains a standalone Git bundle and committed-source ZIP. Restore the bundle into a new empty location, install lockfile dependencies, and rerun the relevant local gates. These same-machine artifacts are not an off-machine backup.

No remote is configured in this candidate. No GitHub write, push, pull request, merge, deployment, production, Cloudflare or OPS-001 operation is authorized by this document. The GitHub Apps deployment-trigger review remains unresolved and must pass before any separately authorized push.
