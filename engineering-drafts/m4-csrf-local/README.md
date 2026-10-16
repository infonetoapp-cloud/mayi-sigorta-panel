# F45: local-only canonical CSRF feasibility

Decision: retain canonical CSRF in the HTTP Worker. Reject delegation to the existing upload DO under the present availability contract. Do not promote this hand-written validation candidate into production.

The candidate is deliberately isolated. Only test mocks and the opt-in local bundler substitute it. No production import, binding, route, authentication authority or cache is added. `src/`, schema, Wrangler and dependencies remain byte-equivalent to the accepted commit.

Contract/rejection results:

- Existing upload runtime returns404 for CSRF with DOCUMENTS=false; canonical HTTP returns200 for a valid session without an upload binding. Reusing that runtime unchanged violates availability/response equivalence.
- Actual synchronous JPEG inspection completes before queued independent-auth-permit, abort and deadline callbacks run on the same JS event loop. Separate permits cannot create preemption. This is a deterministic same-event-loop characterization using the real inspector, not a measured production DO latency bound. The platform documents same-instance routing and possible shared global memory between DO instances; renaming an object does not establish isolate independence.
- Raw late D1 work retains admission custody after logical cancellation until settlement. No new auth-DO executor claims correct deadline or cancellation behavior; the rejected design would have to prove those requirements separately.
- Candidate substitution through the actual HTTP worker + real local D1 preserves OWNER/MEMBER revocation, permission/credential versions, suspension, expiry/idle expiry, origin/Host/path/method, canonical HEAD behavior, no-store/no-Set-Cookie, fresh nonce, session-bound subject and secret rotation. Existing login source/account throttling still precedes password work. CSRF GET itself has no new source-rate quota; no claim that the candidate adds one.
- An initial candidate incorrectly used UTF16 length. The normative installed Zod4.6.5 uses code-point length. The Unicode counterexample was retained and the isolated candidate corrected. Fixtures initially hit last-owner/lifecycle constraints and an empty outer403 body; those failures were preserved, not worked around in production.

Focused commands from repository root:

    node node_modules/vitest/vitest.mjs run tests/csrf.local-feasibility.test.ts tests/csrf.http-feasibility.test.ts tests/csrf.shared-do-feasibility.test.ts --maxWorkers=1 --no-file-parallelism

Explicit opt-in profile (never an automatic provider experiment):

    RUN_CSRF_LOCAL_PROFILE=1 node node_modules/vitest/vitest.mjs run tests/csrf.profile.workerd.test.ts

The profiler boots only local Miniflare/workerd, migrates local synthetic D1, uses local inspector/CDP and disposes it. It saves profiles under the OS temp directory, not the repository. Default test runs skip this expensive profiler; semantic/security tests remain active. The local bundler substitution is exact and RAM-only; production source is never rewritten.

Observed local workerd pairs (80 full HTTP CSRF requests each): baseline405.4701ms/candidate405.7602ms; final verification333.3184ms/326.0651ms. These are local total wall times, not Cloudflare CPU or a statistically sufficient performance win. Initial V8 samples130/129; only1 baseline sample had a parseCsrfConfig ancestor (candidate0). Sparse samples are not a precise cost decomposition, but they do not establish configuration validation as the dominant bottleneck. Both paired runs are retained, not cherry-picked. The hand-written validator's extra semantic maintenance is not justified by a demonstrated material end-to-end benefit.

No cloud account API, provider app request, telemetry requery, deploy, paid resource, document upload or capacity run is part of this study. Existing trace evidence is secondary and unchanged. F41/F42/F43/F44 accepted narrow evidence remains intact.

Minimum remaining evidence if Free headroom must be resolved: a separately authorized, bounded native CSRF reference with tracing disabled and idle-touch/cold/isolate effects distinguished. This study neither schedules nor authorizes it. It must establish the actual uninstrumented CPU distribution before requiring new isolation architecture or another risky optimization. Do not repeat the failed shared-DO or generic telemetry-probe cycle.
