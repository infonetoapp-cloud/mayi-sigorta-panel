# Focused dependency security remediation

## Scope and selected corrections

The eight-package npm audit finding was reproduced from the accepted lockfile. The correction uses only compatible patch updates, not `npm audit fix --force`, a framework replacement or a new Wrangler generation:

| Dependency              | Before       | Selected | Exposure / rationale                                                                                                                                               |
| ----------------------- | ------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Hono                    | 4.13.8       | 4.13.11  | Runtime dependency; patched double-decoding/static middleware advisory. Fix applied even though CRM serves assets through its Worker router, not Hono serveStatic. |
| Vite                    | 8.3.0        | 8.3.3    | Development/build server path, editor and cross-origin advisories; not an Edge runtime dependency.                                                                 |
| Vitest / @vitest/mocker | 5.0.1        | 5.0.3    | Test-server mock registration/path traversal; no externally exposed test server is authorized.                                                                     |
| Miniflare's sharp       | 0.35.4       | 0.35.5   | Development/local emulation native SVG/libvips/librsvg dependency; patch-scoped override under miniflare only.                                                     |
| Miniflare's undici      | nested7.29.0 | 7.29.1   | Development/local emulation HTTP/TLS/caching/DoS advisories; patch-scoped override under miniflare only. Root7.29.1 was already fixed; the nested copy was not.    |

Wrangler remains4.133.0, Miniflare remains5.20260916.0-alpha (already the accepted baseline), and workerd remains1.20260916.1. The latest Wrangler would change the emulator/native generation; that broader update was deliberately avoided. All advisory ranges and registry existence were checked before selecting the first compatible fixed patch for Hono/Vite/Vitest. Patched sharp/undici versions match the maintained emulator's fixed transitive versions without replacing its API generation. Existing esbuild override is unchanged.

Vite brings a compatible1.2.x rolldown update and matching platform bindings. Vitest's upstream patch depends on why-is-node-running3.2.1 and matching @vitest packages; these are upstream test-tool transitive requirements, not a CRM architectural upgrade. Sharp brings its matching native packages/libvips. Removed nested undici is deduplicated to the already fixed root version. Lockfile delta is inspected separately from source changes.

## Actual advisories

The exact package versions, vulnerable ranges, dependency paths, advisory IDs/URLs and fix suggestions are retained in the original `dependency-audit-before.json`. The eight affected packages are Hono, Vite, Vitest, @vitest/mocker, sharp, undici, Miniflare and Wrangler; the last two are meta-vulnerabilities inherited from the patched development dependencies, not eight independent runtime vulnerabilities.

- Hono: GHSA-5r4p-p66f-jhc7 (double path decoding with serveStatic).
- Vitest/mocker: GHSA-qxg6-89mg-rqv8 and GHSA-xp26-3454-mjgp (manual mock registration injection and Windows traversal).
- Sharp/librsvg: GHSA-wq5f-xc86-pv6w.
- Undici: GHSA-3wwx-pv8p-q78v, GHSA-pmjh-fq2x-6v4x, GHSA-r53p-7pc4-xj5r, GHSA-rfgv-xxqx-mfg5, GHSA-3xpg-4rpp-hhhm, GHSA-2jfj-6hjv-fm6j, GHSA-2gqq-gqf2-x968, GHSA-w293-vg96-wgc3, GHSA-8436-99hf-9mmv, GHSA-rx4f-c7p8-82vq (HTTP/TLS/cache/WebSocket denial-of-service and isolation flaws).
- Vite: GHSA-698v-4r3x-3vcv, GHSA-r825-w8mm-5pxw, GHSA-587h-7wmj-h5pm, GHSA-9jrq-w75r-8gcw, GHSA-rq7h-c2jc-7f22, GHSA-vfpm-58rq-9qcg (editor execution, cross-origin and file-serving flaws).

Advisory URLs use `https://github.com/advisories/<ID>`. No finding is suppressed, omitted via dev filtering, or dismissed only because it is development-only. Full npm audit after remediation reports0 HIGH/0 MODERATE/0 total. A clean audit does not prove the absence of unknown vulnerabilities or authorize deployment.

## Reproducibility and verification

Final accepted regression matrix:237 complete test files,3170 PASS/0 FAIL/3 pre-existing SKIP, using each file's latest complete verified result. The initial failed/timeout matrix remains unchanged in the retained archive. Corrected files were rerun in full, not credited from filtered cases. The restored-database authorization file retains all ten PASS cases.

Migration0020's remaining journal failure was an obsolete “prefix plus exactly one entry,0020 last” assumption:0021 and0022 legitimately followed it. Its test now requires the complete ordered journal tags to equal the SQL file inventory, contiguous exact indices, the original prefix's full objects unchanged,0020 in its exact first-new position, and the original39 historical Git-blob files unchanged. No migration/snapshot/journal bytes or historical pins were edited; the fix does not merely allow a larger arbitrary count.

Exact ranges from the reproduced advisory response (package-level HIGH/MODERATE totals include inherited findings; individual advisories can have a lower severity):

| Package        | Advisory            | Affected versions       | Advisory severity |
| -------------- | ------------------- | ----------------------- | ----------------- |
| @vitest/mocker | GHSA-qxg6-89mg-rqv8 | `>=5.0.0-beta.1 <5.0.3` | moderate          |
| @vitest/mocker | GHSA-xp26-3454-mjgp | `>=5.0.0-rc.2 <5.0.3`   | moderate          |
| hono           | GHSA-5r4p-p66f-jhc7 | `>=4.12.4 <4.13.11`     | moderate          |
| sharp          | GHSA-wq5f-xc86-pv6w | `<0.35.5`               | high              |
| undici         | GHSA-3wwx-pv8p-q78v | `>=7.28.0 <7.29.1`      | moderate          |
| undici         | GHSA-pmjh-fq2x-6v4x | `>=7.11.0 <7.29.1`      | moderate          |
| undici         | GHSA-r53p-7pc4-xj5r | `>=7.0.0 <7.29.1`       | low               |
| undici         | GHSA-rfgv-xxqx-mfg5 | `>=7.0.0 <7.29.1`       | high              |
| undici         | GHSA-3xpg-4rpp-hhhm | `>=7.15.0 <7.29.1`      | moderate          |
| undici         | GHSA-2jfj-6hjv-fm6j | `>=7.0.0 <7.29.1`       | moderate          |
| undici         | GHSA-2gqq-gqf2-x968 | `>=7.1.0 <7.29.1`       | low               |
| undici         | GHSA-w293-vg96-wgc3 | `>=7.24.1 <7.29.1`      | high              |
| undici         | GHSA-8436-99hf-9mmv | `>=7.0.0 <7.29.1`       | low               |
| undici         | GHSA-rx4f-c7p8-82vq | `>=7.0.0 <7.29.1`       | moderate          |
| vite           | GHSA-698v-4r3x-3vcv | `>=8.3.0 <=8.3.2`       | moderate          |
| vite           | GHSA-r825-w8mm-5pxw | `>=8.3.0 <=8.3.2`       | moderate          |
| vite           | GHSA-587h-7wmj-h5pm | `>=8.3.0 <=8.3.2`       | high              |
| vite           | GHSA-9jrq-w75r-8gcw | `>=8.3.0 <=8.3.2`       | low               |
| vite           | GHSA-rq7h-c2jc-7f22 | `>=8.3.0 <=8.3.2`       | moderate          |
| vite           | GHSA-vfpm-58rq-9qcg | `>=8.3.0 <=8.3.2`       | moderate          |

The original failed `npm ci` attempts are preserved: package-lock-only resolution missed optional `@emnapi/wasi-threads`. A normal, non-force `npm install --include=optional` resolved the complete lockfile; subsequent plain `npm ci --prefer-offline` succeeded. The independent dependency tree was outside Desktop and was preserved before replacement. No shared Desktop node_modules tree was mutated.

`tests/dependencies.security.test.ts` persists the patch/override/native-generation invariants and runs the real patched sharp/libvips SVG-to-PNG path. The version invariant failed on the baseline (RED) before the package edit, then both cases passed (GREEN). Existing real KDF/LOCAL D1/recovery and application tests remain the behavior contract; audit alone is not functional acceptance.

Full per-file regression and final typecheck/lint/format/client/Worker-dry-run/boundary evidence are retained under `dependency-security/` outside Git. Each full test file runs in a separate native Node process to bound Windows emulator/resource accumulation; skips are reported separately. No prior partial/failed run is relabeled PASS. Final publication is conditional on this gate's actual results and exact source/remote verification.

The broad gate also exposed stale baseline test infrastructure in unchanged application/schema code: the database inventory omitted the four immutable/binding triggers already installed by migration0021, and the closed document canary's exact health DTO omitted the existing `overdueUploads` counter. Those exact expectations were corrected, requiring all four guards/the counter at zero. The exported-queue gate fixture also predated the real upload dispatcher: it lacked the source rate limiter and upload DO, and sent JSON to a now multipart-only endpoint. Its local native bindings and multipart probe were corrected; its strict unauthenticated401 assertion was retained rather than accepting an infrastructure503. No migration, business effect, health/auth implementation or security check was removed or relaxed. The first failures remain preserved; complete corrected test files must pass again before acceptance.

The six authorization integration files are preserved. The protected planning/status document is excluded. No CRM runtime source, migration, production configuration or existing evidence is changed. The isolated Edge template stays unrouted, default-off and bound to an offline sentinel; actual Edge resource/deployment approval is still a separate gate.

Historical migration tests also compared Windows checkout CRLF bytes against immutable LF Git-blob pins or prior-commit SQL/snapshot bytes. The original pins and historical commit identifiers are not changed. A test-only helper now checks that Git's configured clean-filter object ID of the current SQL/snapshot equals HEAD's object ID, then returns/hashes the exact committed blob. A real edit still fails before the historical bytes/hash are accepted; malformed paths are rejected before any Git/file read. No SQL file, snapshot, journal, migration history, backup fingerprint, Git attribute or historical receipt is rewritten or normalized. The new guard has positive, tamper-denial and path-denial regressions. Tests require an actual Git checkout, not a source ZIP without repository metadata.

The completion UI's old EUR text expectations were aligned with the already committed canonical currency-symbol formatter (`420,50 €`/`430,00 €`). Only exact display expectations changed; premium minor units, policy/renewal versions, EUR payloads and conflict/reselection assertions remain enforced. No UI implementation or Phase3 candidate was edited. A full legacy document-restore run also exceeded the first15-minute outer test-driver budget; that incomplete run remains a timeout, and only a later complete isolated-file result can replace it in the accepted matrix. Product/decoder/security limits are not increased.
