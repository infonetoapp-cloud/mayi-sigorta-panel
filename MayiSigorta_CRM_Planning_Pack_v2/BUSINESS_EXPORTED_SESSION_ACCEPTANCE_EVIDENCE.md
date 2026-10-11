# Exported Worker native-session business acceptance — LOCAL

Recovery compatibility local checkpoint `eb42f1c5905f955f6ce3e59f4149b3d2a0964aef` sonrası yetkili tek readiness slice. Parent writer ve iki read-only specialist kullanıldı; default exported Worker'in NORMAL business auth composition kapsamı en yüksek değerli LOCAL boşluk seçildi. Production deploy veya business data acceptance değildir.

## Fresh readiness ranking

1. Exported Worker native-session business acceptance: gerçek kullanımı doğrudan etkiler; live identity/session/CSRF/permission/CAS/idempotency/audit atomikliğinin entry-point proof gap'i. Existing integration testleri createApp/createWorker dependency injection ağırlıklı; default export'ın başarısı ayrıca kanıtlanmalı. Küçük tests-only effort, gerçek insan/veri/provider gerektirmez.
2. M4 durable DEAD/backlog alarm composition: kalıcı failed jobs görünürlüğü gerçek data-loss/availability riskidir, fakat documents henüz disabled; kaynak evaluator/sink composition yok, ayrı bounded LOCAL uygulama uygundur. COMPLETED investigation dahil edilmelidir, yalnız DEAD count yetmez.
3. M4 backup/reconcile Worker composition: default Worker adapter'ları inject etmiyor; eksik capability retry fail-closed. Ayrı create/readback capability/IAM contract tanımlanmadan ham recovery bucket bind etmek mevcut mimariyi ihlal eder. Yeni RPC veya env capability uydurulmadı. D1 backup Worker scheduled-only, CRM D1 recovery bucket erişimi yok; bu slice güvenlik redesign yapmaz.

İlk sıranın nedeni M4'ü kozmetik nedenle ertelemek değil; güncel canlı employee auth ile normal core business kullanımının composition kanıtını provider/human girdisi olmadan tamamlayabilmektir. M4 COMPLETE=false, DOCUMENTS_ENABLED=false, M5 başlamadı.

## Narrow acceptance contract

`tests/business.exported-native-session.test.ts` doğrudan `src/server/worker.ts` default exported fetch'i çağırır. createApp/createWorker/auth verifier/resolver injection kullanılmaz. Existing LOCAL fixture yalnız native Miniflare D1 ve sentetik principal/credential/session seed sağlar. Fixture'ın app helper'ı isteklerde kullanılmaz; HTTP login/KDF uygulanmaz.

Node ortamı workerd-only `cloudflare:workers` DurableObject base class'ını resolve edemediğinden yalnız UNUSED re-exported DO base mock'u vardır. Auth/resolver/session/capability route'ları mock edilmez. Bu exported-handler + native D1 kabulüdür, bütün Worker workerd isolate/KDF runtime veya production business execution proof değildir.

Beş test grubu:

- NORMAL cookie → `/api/me` → issued session-bound CSRF → COMPANY create → contact create/read. Exact company ve contact replay'de tek effect/receipt/audit; conflicting payload key409; fresh PATCH200/stale CAS409; no-store response.
- Missing CSRF, başka session token'ı, PHP sibling origin ve alternate host403; customers/contacts/receipts/audit delta0.
- Missing/revoked/expired cookie401; gerçek constrained ACTIVATION seed ile business API401. Expired seed geçmiş clock ile yapılır, immutable session sütunları update edilmez; trigger bypass yok.
- MEMBER ASSIGNED dışındaki Customer ve other agency OWNER non-disclosure404. Permission-version değişimi eski cookie/replay401; create permission kaldırıldıktan sonra yeni geçerli session ile aynı receipt replay403; effect/receipt/audit delta0.
- Gerçek default fetch'in final mutation batch'i öncesi LOCAL session revoke: concurrent D1 state change simülasyonu, gerçek sessionBoundDatabase assertion ile409; business+receipt+SUCCESS audit birlikte rollback. DB spy yalnız race timing seam; auth dependency injection değil.

Cookie/hash/verifier/CSRF değerleri log/assertion diff'e yazılmaz; scalar status/count/bool kontrol edilir. Worker/runtime/schema/config/migrations/backup writer/source hiçbir şekilde değişmedi. Production D1 write0; remote resource/import0; deploy0; paid/secret/DNS/feature/Queue/Cron enablement0.

## Verification history

İlk import node cloudflare:workers resolution nedeniyle no-tests FAIL; sınırlı unused DO-base stub ile corrected4PASS1FAIL. Fail expired-test harness'in mevcut olmayan issued_at kolonunu kullanmasıydı; gerçek created_at+immutable-session contract incelenip trusted past-clock seeding ve proper ACTIVATION sessionInsert ile düzeltildi. Focused affected expired/activation1PASS4SKIP; skipped cases yeni PASS denmedi. Source bug veya production mutation yok. Typecheck/new-filelint/fullformat/boundaries/clientbuild/diff PASS. Coherent final relevant acceptance: `business.exported-native-session.test.ts`, `auth.session-policy.test.ts`, `customers.integration.test.ts` birlikte **61/61 PASS**,3files/186.34s/exit0. Typecheck/new-filelint/fullformat/boundaries/clientbuild/diffPASS; unrelated full-repo suites/lint yeniden çalıştırılmadı, tarihsel baseline durumları bu receipt'le supersede edilmez.

ONEfresh independent GPT-6.1Sol/openai-codex/HIGH session `20261011_110256_6d0dd2`: **BLOCKER0/IMPORTANT0/PASS**; independent new5/5PASS35.87s/typecheck/newlintformatdiffPASS. OPTIONAL1 contact replay-ID/GET contact ve stale-CAS persisted-value assertion eklenmesi nonblocking; bu dilimde polish edilmedi. Reviewer actual default fetch/live auth/D1 assertion/no bypass/scope sınırını doğruladı; parent61aggregate'i reviewer yeniden çalıştırmış sayılmadı. LOCAL checkpoint accepted; normal test/docs commit/push, no deployment. Sonraki exact gate manuel private Cloudflare support submission/provider guidance; yeni remote D1/import veya production write/deploy/feature enablement ayrı açık yetki gerektirir. Populated remote recovery OPEN kalır.
