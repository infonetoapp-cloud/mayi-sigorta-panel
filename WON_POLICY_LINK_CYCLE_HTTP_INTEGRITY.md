# WON policy-link cycle HTTP sözleşmesi — BACKEND CLOSED / LOCAL VERIFIED

Taban: `3f157b4ae90e8d6809b0db818e79399cec6b1c70`. Yalnız dar backend error-classification yetkisi; Phase4G-A frontend resume/kabulü ve Phase4G-B yoktur. Phase4F LOCAL GO korunur; **Phase4G-A LOCAL NO-GO** kalır.

## Kök neden ve minimal düzeltme

`src/server/renewals/commands.ts:3025`, `mapWonBatchError` içine yalnız şu dal eklendi:

```ts
if (message.includes('RENEWAL_POLICY_LINK_CYCLE')) {
  throw new RenewalCommandError('RENEWAL_POLICY_LINK_CYCLE', 409);
}
```

SQLite `0012_m3_renewal_policy_links.sql:73–99` cycle guard'ı batch'i zaten ABORT/rollback ediyordu. Eksik mapping generic catch500'e ulaşıyordu. Şimdi domain code distinct kalır; `WON_ALLOCATION_INVALID` ile birleştirilmez. Route mevcut canonical envelope/message yolunu kullanır. Generic SQL/500→409 dönüşümü yoktur. `policy-links.ts:289` ayrı mapping'inde cycle zaten conflict'tir; bu dosya değiştirilmedi. Trigger/migration/link creation/premium/receipt/replay/Task identity/auth/quote expiry SQL'leri aynıdır.

## Orijinal RED → GREEN

Korunmuş `tests/renewal-won-modern.api.test.ts` byte-for-byte korunarak aynı komut çalıştırıldı:

`node.exe node_modules/vitest/vitest.mjs run tests/renewal-won-modern.api.test.ts -t 'cyclic LINK_POLICY' --maxWorkers=1 --reporter=json --outputFile=node_modules/.cache/won-cycle-original-{red|green}.json`

- Önce exit1,0PASS/1FAIL/4filter skip: gerçek D1 exception `RENEWAL_POLICY_LINK_CYCLE`, HTTP500,11-table unchanged=true.
- Yalnız mapping sonrası exit0,1PASS/0FAIL/4filter skip: aynı trigger cycle reddi, HTTP409,11-table unchanged=true. Test gevşetilmedi.

İki policy'den future policy renewal/primary Task'ı yalnız sentetik fixture ile hazırlanır; ters link gerçek HTTP WON LINK_POLICY ile oluşturulur. Original renewal'ın ileri link denemesi gerçek production trigger tarafından cycle nedeniyle reddedilir. Proxy yalnız gerçek exception'ı kaydedip rethrow eder; trigger veya production SQL mock değildir.

## Kalıcı backend-only regresyon

`tests/renewal-won-cycle-http.api.test.ts`: **8/8 PASS,0FAIL/0skip**, exit0 (`won-cycle-permanent.json`). Korunmuş frontend candidate testinden ayrı dosyadır; candidate stage edilmez.

- Cycle tam code `RENEWAL_POLICY_LINK_CYCLE`, canonical safe409 envelope, exact11-table snapshot rollback.
- Self-link409 `WON_ALLOCATION_INVALID`; yanlış müşteri/stale policy409 `WON_POLICY_TARGET_INVALID`; incomplete ve overflow requested amount409 `WON_ALLOCATION_INCOMPLETE` mevcut contract'ı korunur.
- Geçerli noncyclic LINK_POLICY selected SENT association ile200; createdPolicyId=null, exact original Task, WON. Same-key exact replay aynı historical sonucu yazımsız verir; changed same-key409. Tek link/receipt/SUCCESS audit ve initial+WON iki history.
- Disposable fixture'da yalnız WON audit INSERT'ine gerçek SQLite RAISE(ABORT,'ISOLATED_UNEXPECTED_AUDIT_FAILURE') failpoint'i kurulur. HTTP500/INTERNAL_ERROR ve safe message korunur;11-table snapshot tamamen rollback. Failpoint finally kaldırılınca aynı legitimate payload succeeds. Production audit trigger/schema değiştirilmez; tüm SQL hataları409 yapılmadığının gerçek D1 kanıtıdır.

Snapshot: renewal_opportunities, renewal_state_history, tasks, renewal_quotes, renewal_quote_versions, renewal_quote_events, renewal_policy_links, operation_receipts, audit_events, policies, d1_cas_assertions. Retlerde original renewal nonterminal/CAS ve Task OPEN/CAS, policy/quote/SENT/event ve önceki ters link dahil bütün satırlar aynıdır; yeni receipt/history/ACCEPTED/audit/link/orphan assertion yoktur. DB integrity bypass iddiası yoktur.

## Mevcut regresyon ve kalite

Mevcut4 D1 dosyasının tek birleşik gate'i **57/57 PASS,0FAIL/0skip**, exit0: `won-cycle-existing-final.json`.

- `renewal-policy-links.m3.test.ts`:12PASS; ayrı secure allocation endpoint/service, audit rollback, grants/permission/HEALTH/identity, real clock ve concurrency/replay korunur. Ayrı cycle mapper kaynakta aynıdır; bu12 case'in yeni cycle-specific route testi olduğu iddia edilmez.
- `renewal-terminal-task-identity.api.test.ts`:25PASS; original A→B WON/LOST/VOIDED, CAS/receipt replay/authority ve task completion yarışları.
- `renewal-won-quote-expiry-preflight.api.test.ts`:1PASS; gerçek preflight→batch expiry barrier409 ve rollback, saat/SQL mock yoktur.
- `renewals.m3-t03-terminal.test.ts`:19PASS; mevcut WON LINK/CREATE/EXISTING_LINKS, WON/LOST yarışı, legacy LOST/VOIDED, quote acceptance ve HEALTH.

Yeni kalıcı8 ile **65 ayrı backend D1/API test PASS**,0FAIL/0skip. Korunmuş orijinal cycle GREEN case'i duplicate senaryodur; toplam65'e tekrar eklenmez (orijinal odaklı koşu1PASS/4filter skip). RED0PASS/1FAIL/4skip tarihsel kanıttır, başarı sayılmaz. Bu görevde fixture düzeltmesi, timeout veya unexpected test failure yoktur; yalnız beklenen orijinal RED exit1 vardır. Background wait penceresinin dolması test timeout'u değildir; birleşik süreç normal exit0 ile tamamlandı.

**Backend HTTP contract fix CLOSED. Phase4G-A halen LOCAL NO-GO**, ayrı frontend tamamlama ve Edge kabulü gerekir. Eski investigation NO-GO kaydı geriye dönük PASS'a çevrilmedi; ayrı kanıt budur.

Typecheck, lint, format-check, client build, Worker **yalnız dry-run**, security boundaries, diff-check PASS. Wrangler mevcut multi-environment uyarısı vardır, deploy yoktur. Client build korunmuş unfinished frontend adayını da derler; bu Phase4G-A UI/Edge kabulü değildir. Browser/tüm-repo suite tekrar edilmedi. Bağımsız reviewer kullanılmadı.

## Byte-preservation ve commit sınırı

Başlangıç7 dirty/untracked path SHA256 baseline `node_modules/.cache/won-cycle-preservation.json` içinde. Altı Phase4G-A candidate dosyası ve protected belge **7/7 byte-for-byte aynı** olarak doğrulandı; stage/commit dışında kalır.

| Korunan path                                        | Başlangıç SHA256                                                 |
| --------------------------------------------------- | ---------------------------------------------------------------- |
| src/app/pages/today-work/WonPolicyOperation.tsx     | 00779a04e3973b65a2ceaa6a1c41fd18aaa960f1e1e9d26411ee2b5f07f78890 |
| src/app/pages/today-work/RenewalOutcomesSection.tsx | aadcc379b8f9596fea1675b9ff0ed89dac1f49fad42f583fcb543a9f3f8a5eb7 |
| src/app/pages/today-work/TodayWorkPage.tsx          | 3d78b68fd39c51980357f6f81878206f1a999b67ecf68adbb949826b5db8dddc |
| tests/renewal-won-modern.ui.test.tsx                | 4e82f983d4c714026afb7b88cbe6e8e89562262145bc6f6328055aa6729308e9 |
| tests/renewal-won-modern.api.test.ts                | f5148822e1422323b322c5ca9843191179c8df7c19c4ce53a405837d22895dc8 |
| FRONTEND_PHASE4G_A.md                               | 7550574b2456d03000891a621087ffd4a00a147cfb9fd26a44a0ce6d923686d3 |
| MayiSigorta_CRM_Planning_Pack_v2/UYGULAMA_DURUMU.md | f272a14efce57f2ef47d960c2ac387e11cdaeda96aa6fda71db8585844e28930 |

Commit allowlist yalnız commands.ts, yeni backend-only regression ve bu evidence'dır. Frontend candidate, historical NO-GO investigation ve protected belge stage/commit dışında kalır. Reset/clean/stash/production/Cloudflare/migration/Paid/gerçek veri/dış mesaj/document/R2 yoktur. Frontend resume ayrıca yetkilendirilmeden yapılmaz.
