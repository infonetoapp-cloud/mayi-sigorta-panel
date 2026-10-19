# Frontend Phase 4G-A — LOCAL GO / modern WON LINK_POLICY

Güncel karar: **LOCAL GO**, yalnız aşağıdaki nihai6ae769c-resume kabulü için. İlk iki investigation/STOP bölümü tarihsel FAILED/LOCAL NO-GO kayıtlarıdır; backend fixes ayrı commit'lerde kapanmıştır. Eski başarısızlıklar aşağıda aynen korunur; final sonuçlar en sondadır. Production kabulü veya Phase4G-B yetkisi değildir.

## Karar ve kapsam

Başlangıç HEAD/origin/main/uzak main: `80d11d38ed0007e6bcd5754820661e96a688f3f3`. Kullanıcının zorunlu backend preflight ve gerçek kusurda STOP kapısı uygulandı. **PHASE4G-A LOCAL NO-GO**: WON LINK_POLICY sırasında selected SENT quote'un geçerliliği preflight ile atomik batch arasında dolduğunda expired sürüm ACCEPTED olabiliyor.

Modern WON UI geliştirilmedi; selector, outcome workspace, legacy adapter, backend domain/validation/routes, schema/migration/config değiştirilmedi. CREATE_POLICY/EXISTING_LINKS/group/link grant/premium correction uygulanmadı. Production/Cloudflare/Paid/gerçek veri/dış mesaj/document/R2 aktivasyonu ve Phase4G-B yoktur. Bu görevde commit/push yapılmadı; başarısız preflight sonrası frontend yayın yetkisi kullanılmadı. Önceki Phase4F LOCAL GO geriye dönük değiştirilmez; yeni WON acceptance kapsamı ayrı engeldir.

Protected dirty `MayiSigorta_CRM_Planning_Pack_v2/UYGULAMA_DURUMU.md` aynı SHA256: `f272a14efce57f2ef47d960c2ac387e11cdaeda96aa6fda71db8585844e28930`. Edit/stage/commit yoktur.

## Kaynak incelemesi

- `src/server/renewals/validation.ts`: yeni single WON expectedPrimaryTaskId+expectedRenewalVersion+expectedTaskVersion; LINK_POLICY newPolicyId/expectedPolicyVersion/allocatedNewPremiumMinor/currency; optional acceptedQuoteVersionId ve quoteDifferenceReasonCode. Strict yeni-write ve receipt-only historical compatibility ayrımı korunur.
- `src/server/renewals/routes.ts`: current authentication, CSRF, idempotency, strict Request parsing ve mevcut close-won servisi.
- `src/server/renewals/commands.ts`: selected accepted quote için `Date.parse(quote.valid_until) <= Date.now()` erken ret var. `wonQuoteAcceptanceAssertion` current SENT quote/version/CAS, SENT event, WON renewal, ACTIVE policy link ve completed receipt'i SQL'de bağlıyor; valid_until ile gerçek SQLite clock şartı yoktur. Yeni frontend geçerlilik kontrolü bu atomik açığı kapatmaz.
- `TERMINAL_PRIMARY_TASK_IDENTITY_INTEGRITY.md`: exact original Task kimliği ayrı backend `599b3e1` ile sabittir; mevcut regression bu araştırmada ayrıca GREEN doğrulandı. Bu durum quote acceptance expiry güvenliği için kanıt değildir.

## Gerçek D1 negatif üretimi

Kalıcı test: `tests/renewal-won-quote-expiry-preflight.api.test.ts`.
Test adı: `rejects selected SENT quote expiry after WON LINK_POLICY preflight at the real atomic D1 boundary and rolls back every effect`.

1. Canonical opaque local-auth OWNER/session/CSRF, disposable Miniflare gerçek D1 ve aktif GENERAL sentetik katalog/customer hazırlanır.
2. Expiring policy'nin gerçek generated primary Task'ı authorized today queue'dan okunur. Aynı müşterinin uygun yeni dönem poliçesi normal create endpoint'inden oluşturulur. LINK_POLICY bu mevcut kaydı kullanır; WON içinde yeni policy yaratılmaz.
3. Gelecekteki canonical validUntil ile matching product/premium1000minor/TRY quote oluşturulur; corrected gerçek send endpoint'iyle SENT yapılır. Quote immutable version veya expiry SQL'i değiştirilmez.
4. WON exact request expectedPrimaryTaskId=orijinal Task, iki gerçek CAS, LINK_POLICY gerçek detail version/amount/currency ve explicit acceptedQuoteVersionId içerir. Difference reason gerekmez: ürün/prim/currency eşleşir.
5. Yalnız final db.batch çağrısı durdurulur. Batch'e ulaşılması başarılı normal preflight'ın kanıtıdır; barrier girişinde JS zamanı hâlâ validity'den öncedir. Gerçek saat validUntil+150ms olana kadar beklenir. SQLite `strftime('%Y-%m-%dT%H:%M:%fZ','now')` ile expiry ayrıca okunur. Sonra production statement'ları değiştirilmeden gerçek D1 batch'e gönderilir. Date.now/SQLite clock mock, SQL predicate replacement, row overwrite veya trigger disable yoktur.
6. Beklenen409, nonterminal renewal/orijinal OPEN Task/SENT quote,0link/ACCEPTED event/receipt/SUCCESS audit ve full-table snapshot eşitliğidir.

### Ölçülen RED

- validUntil: `2026-10-19T16:30:16.059Z`
- Batch öncesi gerçek SQLite now: `2026-10-19T16:30:16.305Z`; sqlExpired=true.
- **HTTP200**.
- Renewal **WON/version2**; original Task **COMPLETED/version2**.
- Quote **ACCEPTED/version3**, accepted_version_id selected immutable version'a bağlı.
- Policy link **1**, ACCEPTED event **1**, operation receipt **1**, SUCCESS audit **1**.
- Full business/evidence snapshot unchanged=false; rollback yoktur.

Başarısız assertion tüm gözlemleri ret kontrolünden önce toplar. Böylece receipt/audit/link etkileri yalnız kaynak yolundan çıkarım değil gerçek D1 readback'tir. Snapshot policies ve immutable quote versions dahil10 tabloyu içerir. Başarısız batch beklenmesine rağmen tüm WON business etkisi commit olmuştur.

## Komutlar ve test sayımları

İlk birleşik preflight:

`node.exe node_modules/vitest/vitest.mjs run tests/renewal-won-quote-expiry-preflight.api.test.ts tests/renewal-terminal-task-identity.api.test.ts -t 'rejects selected SENT quote expiry|rejects WON stale A identity|rejects pinned A without effects' --maxWorkers=1 --reporter=json --outputFile=node_modules/.cache/phase4ga-backend-preflight.json`

Sonuç exit1: **4PASS/1FAIL/21 filtre skip**. Dört kimlik case'i GREEN: stale WON A ve staleA→freshB LOST/VOIDED/WON. Skip'ler PASS sayılmaz. Expiry case varsayılan60000ms test bütçesine takıldı; bu timeout kusur üretimi veya PASS sayılmaz, tarihsel olarak korunur. Gerçek60s validity beklemesi setup/SQL süresiyle test bütçesini aştığından yalnız o case'in timeout'u180000ms yapıldı; business assertion/clock/barrier zayıflatılmadı.

Ayrı tamamlanmış expiry üretimi:

`node.exe node_modules/vitest/vitest.mjs run tests/renewal-won-quote-expiry-preflight.api.test.ts --maxWorkers=1 --reporter=json --outputFile=node_modules/.cache/phase4ga-won-expiry-real-boundary.json`

Sonuç **exit1,0PASS/1FAIL/0skip**, yukarıdaki gerçek expired acceptance RED. JSON assertion'ın ilk satırı state/version/link/event/receipt/audit sayılarını taşır; password/session/idempotency key yazdırılmaz. Test beklentisi200'e çevrilmez ve RED olarak korunur.

## Kapanış ve sonraki kapı

- Frontend UI/Edge acceptance ve geniş4A–4F suite'i başlatılmadı: mandatory backend gate başarısızken frontend geliştirmesine geçilmedi.
- Yalnız yeni negatif test ve bu preflight kanıtı worktree'de; eski runtime/committed kaynaklar korunur. Odaklı typecheck/lint/format/diff ve protected hash kapanışta doğrulanır; yeni production build/deployment gerekmez.
- Ayrı reviewer/ajan çalıştırılmadı. Backend düzeltmesi için yeni açık dar yetki gerekir: WON selected quote acceptance'ında gerçek SQL-time strict-future expiry'yi aynı atomik transaction'da zorunlu kılmak, tüm etkileri ret durumunda rollback etmek, historical exact replay ve mevcut task/policy/quote CAS/authority kurallarını korumak. Bu rapor böyle bir değişikliği uygulamaz veya yeni API alanı önererek kapsamı genişletmez.
- Yeni backend gate GREEN olmadan Phase4G-A frontend resume/commit/push ve Phase4G-B başlatılmaz. Korunan Phase4F/legacy işlevler değiştirilmez.

## Ayrı backend kapanışı ve frontend resume — 3f157b4 sonrası

Yukarıdaki expiry kusuru tarihsel RED kaydıdır; `3f157b4ae90e8d6809b0db818e79399cec6b1c70` ile ayrı backend fix CLOSED / LOCAL VERIFIED oldu. Ayrıntı `WON_QUOTE_EXPIRY_ATOMIC_INTEGRITY.md` dosyasındadır. Yeni frontend yetkisiyle resume bu commit'te başladı; önceki failure metinleri silinmedi. Yeni frontend halen **LOCAL NO-GO / tamamlanmamış aday**.

### Korunan frontend adayı

- Yeni `WonPolicyOperation.tsx`: yalnız LINK_POLICY, authorized customer-filtered list ve full detail, original-policy agency/customer doğrulaması, tam prim tahsisi+ayrı onay, explicit SENT seçimi/difference reason, immutable original Task+iki CAS+policy CAS/body/key, belirsizlik exact retry ve accepted HTTP sonrası GET-only readback taslağı.
- `RenewalOutcomesSection.tsx`: WON risk'ini LOST/VOIDED ile mutual exclusion ve mevcut parent terminal navigation lock'una bağlayan entegrasyon.
- `TodayWorkPage.tsx`: WON mevcut-poliçe akışını klasik dallardan ayıran bilgi metni.
- `tests/renewal-won-modern.ui.test.tsx`: ilk missing-component RED sonrası3/3 PASS; full-allocation/final confirmation/exact body, ambiguous exact retry, confirmed-write GET-only recovery.
- Bunlar yalnız başlangıç checkpoint'idir; kapsamlı quote/UI/navigation/Edge kabulü yapılmadı. Aday kabul edilmiş veya production-ready sayılmaz. Legacy selector ve backend domain kaynakları değiştirilmedi.

### Yeni gerçek D1 cycle hata-sözleşmesi blocker'ı

`tests/renewal-won-modern.api.test.ts` ilk4 target case **4/4 PASS** (`phase4ga-api-targets.json`): self-link, stale-policy CAS, wrong customer, incomplete premium409 ve11-table unchanged snapshot. İlk typecheck yalnız yeni testin unused copied import'u yüzünden FAIL verdi; import kaldırıldı.

Cycle case: iki policy için normal eski policy'nin gerçek generated renewal+Task'ı kullanıldı. Diğer policy için yalnız sentetik future renewal/initial history/OPEN primary Task fixture'ı oluşturuldu. Gerçek close-won route'u ile önce ters yöndeki existing policy link'i başarıyla oluşturuldu. Ardından original Task snapshot'ıyla ileri LINK_POLICY gerçek route'tan gönderildi; bu yeni link cycle oluşturacaktı.

- D1 batch'in gerçek exception'ı **RENEWAL_POLICY_LINK_CYCLE**.
- DB guard cycle'ı doğru reddetti; **11 tablo snapshot'ı unchanged=true**, yanlış link/WON/task closure/receipt/history/SUCCESS audit commit olmadı.
- Ancak dış API **HTTP500 / INTERNAL_ERROR** verdi; beklenen definitive conflict409 değil.
- `mapWonBatchError` (`src/server/renewals/commands.ts:3023`) link-required/allocation/target-invalid durumlarını409'a map ediyor, cycle kodunu kapsamıyor; generic `mapBatchError` bunu yeniden fırlatıyor, route generic catch500 üretiyor.
- Bu **expiry kusuru veya veri bütünlüğü bypass'ı değildir**. Yeni doğrulanan domain-error/public API classification sorunudur. UI protokolü5xx'i belirsiz write saydığı için kesin cycle reddi kullanıcıya karşılaştırılabilir409 olarak ulaşmıyor; exact retry ile aynı kesin ret500 olarak tekrar eder. İstemcide INTERNAL_ERROR'u409 saymak veya arbitrary500 retry protokolünü gevşetmek doğru çözüm değildir.

Komut: `node.exe node_modules/vitest/vitest.mjs run tests/renewal-won-modern.api.test.ts -t 'cyclic LINK_POLICY' --maxWorkers=1 --reporter=json --outputFile=node_modules/.cache/phase4ga-cycle-confirmed-red.json`.

Sonuç **0PASS/1FAIL/4filter skip, exit1**: `{httpStatus:500,unchanged:true,dbCycleRejected:true}` yerine `{httpStatus:409,unchanged:true,dbCycleRejected:true}` beklenir. Test proxy'si yalnız real batch exception'ını kaydedip aynen rethrow eder; SQL, assertion veya hata mapping'i değiştirilmez. Historical `phase4ga-cycle-contract.json` ilk fixture CHECK fail'idir (renewal Task policy_id NULL olmalıydı); bu iş kusuru kanıtı sayılmaz. NULL fixture düzeltmesi sonrası `phase4ga-cycle-real.json` gerçek500/unchanged RED, son confirmed dosya exact cycle exception'ını da kanıtlar.

### STOP kapısı

STOP sonrası korunmuş adayın odaklı kalite checkpoint'i: typecheck/lint/format-check/diff-check PASS; üç UI dosyası **46/46 PASS,0FAIL/0skip** (`phase4ga-stop-ui-checkpoint.json`): terminal modern36, terminal workspace7, yeni WON3. Bu sayı tam Phase4G-A kabulü veya tüm-repo regresyonu değildir. Gerçek cycle RED `0PASS/1FAIL/4filter skip` olarak aynen korunur. HEAD/origin/main/uzak main3f157b4 eşit; stage boş ve src/server diff yoktur.

Backend hata mapping'i bu frontend yetkisiyle değiştirilmedi. Tüm aday dosyalar worktree'de korundu; reset/clean/stash yok. Commit/push yok; HEAD/origin/main/remote başlangıç3f157b4'te kalır. Tam UI/API/Edge9cell/final build kabulü çalıştırılmadı; bu belge GO ilan etmez. Ayrı dar backend error-classification düzeltmesi yetkisi olmadan cycle hatasını client-side gizleyerek ilerlenmez. Sonraki frontend resume korunmuş adaydan devam etmelidir, yeniden üretilmemelidir. Phase4G-B başlamadı.

Protected status SHA256 halen `f272a14efce57f2ef47d960c2ac387e11cdaeda96aa6fda71db8585844e28930`. Hiç edit/stage/commit yok. Production/Cloudflare/migration/Paid/gerçek müşteri/dış mesaj/document/R2 yok. Bağımsız reviewer yok.

## Korunmuş aday resume — 6ae769c tabanı

Yeni yetkiyle HEAD/origin/main `6ae769ccf0f5e896dfbdded079bd5031086c386f`, altı adayın SHA256 ve protected status doğrulandı. Cycle HTTP mapping ayrı `WON_POLICY_LINK_CYCLE_HTTP_INTEGRITY.md` kanıtıyla kapanmıştır. Yukarıdaki STOP kayıtları tarihsel kalır; yeniden üretilmedi. Frontend adayı yeniden yazılmadı; mevcut WonPolicyOperation, outcome/parent risk guards ve ilk testler genişletildi. Bu bölümdeki checkpoint'ler final kabul yerine geçmez.

### Tamamlanan client davranışı

- Yalnız LINK_POLICY: full authorized old/new PolicyDetailDto, customer/agency/ACTIVE/nonarchived/not-self identity, explicit search/pagination/detail ve exact policy CAS.
- İki ayrı onay: primin tamamını bu yenilemeye tahsis etme ve final WON. Tutar safe integer minor'dır; politika DTO'su kalan tahsisi kanıtlamaz. Existing allocation409'da otomatik azaltma veya premium değişikliği yoktur; kısmi/paylaşımlı tahsis desteklenmez.
- İsteğe bağlı explicit current SENT immutable version seçimi. Independent authorized quote GET, canonical unexpired validity, SENT event/current pointer, product/minor/currency karşılaştırması; fark varsa kullanıcı belirlediği gerçek3–64 character reason code. No difference → reason field yok. No quote → acceptance ima edilmez. SENT mesaj teslimi değildir.
- Frozen request original TaskId/renewal/customer/iki CAS/policyID/policyCAS/fullminor/currency/optional quote+reason/URL/method/body/key içerir. Network/408/429/5xx exact retry;409 definitive compare ve explicit same-Task adoption + policy/quote re-selection + tekrar onay. A→B aynı numeric CAS olsa da otomatik retarget edilmez.
- Accepted HTTP yazımından sonra response proof exact identities/increments/canonical timestamp/WON/createdPolicyId=null/single selected link+amount+currency kontrol edilir; recovery yalnız GET. Authorized bounded customer-renewals state/version + exact policy detail, quote seçildiyse actual ACCEPTED version/event/acceptedPolicyId okunur. GET tamamlanmış Task veya link satırlarını bağımsız kanıtlıyor iddiası yoktur; gerçek D1 atomik testleri bu kapsamı sağlar. Çelişkide unverified kalır.
- Mevcut terminal risk'e WON dahil: LOST/VOIDED ve interaction/task/quote/SENT draft'ları korunur; unresolved WON queue/selection/paging/sidebar/native-history değişikliklerini engeller. Browser storage veya URL'ye payload/key yazılmaz. Controller abort/epoch gecikmiş401/detail yanıtlarını scope değişiminden sonra bastırır.
- Gerçek Edge session probe canlı WON401'in mevcut session-ended event'ini göndermediğini buldu. Bu yeni frontend aday kusurudur, backend kusuru değildir. `phase4ga-session-ui-red.json` named case RED sonrası mevcut parseAppError401 yolu bağlandı; `phase4ga-session-ui-green.json` focused UI GREEN. Sırf masked ayrıntı göstermek yerine aktif AuthShell session'ı kapanır; aborted eski request event göndermez.

### Bu resume'daki tarihsel FAIL/checkpoint kayıtları

- `phase4ga-ui-expanded.json`: yeni genişletilmiş case'ler runtime PASS; sonraki typecheck test DOM cast'ında explicit unknown bridge istedi, düzeltildi.
- `phase4ga-ui-final.json`:298PASS/1FAIL; `phase4ga-ui-accepted.json`:300PASS/1FAIL. Tek yeni workspace testi nested risk effects settle olmadan queue refresh'e basıyordu: guard unresolved mesajı gösterdi, draft kaybolmadı. Async risk propagation act ile settle edilip aynı dirty guard beklentisi korundu; isolated test PASS. Son birleşik UI koşusu aşağıda ayrıca esas alınır.
- İlk lint yeni testte prefer-const uyarısı verdi; yalnız copied cookieBefore binding const yapıldı. Eski domain assertion veya fixture timestamp gevşetilmedi.
- `phase4ga-edge-first.log`: OWNER1440 native select label selector timeout; semantic combobox selector'a geçildi. `phase4ga-edge-second.log`: OWNER üç genişlikten sonra stale-task fixture'ın legacy completion ile artmış Task version'ını v1 sanması; actual authorized queue'dan version1 Task açık seçildi. `phase4ga-edge-third.log`: OWNER session401 cleanup timeout; yukarıdaki gerçek frontend session bug'ı RED→GREEN düzeltildi.
- `phase4ga-edge-final.log`: OWNER768'de collapsed tablet sidebar link'i click timeout; nav probe için açıkça desktop viewport'a geçilip cell viewport'u retry'dan önce geri yüklendi. Bu failed/partial run'lar9/9 sayılmaz. Client confirmation/layout ve screenshot hücreleri kendi1440/768/360 genişliğinde çalışır.
- Yeni API difference reason required/unexpected testleri mevcut backend'in400 sözleşmesini yanlışlıkla409 bekleyerek RED verdi. commands.ts:3480–3485 gerçek400 + exact reason error code ile expectations düzeltildi; ret ve full rollback assertion'ları korunur. Bu backend domain kusuru değildir. Önceki expiry/cycle regression'ları değiştirilmedi; uzun gerçek-clock expiry araştırması yeniden çalıştırılmadı.

Bu resume sırasında final API/Edge beklenirken checkpoint GO sayılmadı. Backend/src-server/migration değişikliği yoktur; bağımsız reviewer/ajan yoktur. Phase4G-B başlatılmadı.

## Nihai kabul — Phase4G-A LOCAL GO

### Gerçek D1/API: tek birleşik131/131 PASS

`node_modules/.cache/phase4ga-api-final.json`: **131PASS/0FAIL/0skip**, süreç exit0. Sekiz dosya bütün halinde:

| Dosya                                      | PASS |
| ------------------------------------------ | ---: |
| renewal-won-modern.api.test.ts             |   19 |
| renewal-terminal-modern.api.test.ts        |   24 |
| renewal-terminal-task-identity.api.test.ts |   25 |
| renewal-won-cycle-http.api.test.ts         |    8 |
| renewals.m3-t03-terminal.test.ts           |   19 |
| renewal-policy-links.m3.test.ts            |   12 |
| renewal-quotes-modern.api.test.ts          |   13 |
| renewal-quote-identity.api.test.ts         |   11 |

Modern19: original4 target negatif+cycle409; with/without quote success/fullminor/link/task/history/receipt/SUCCESS/no created policy; same-key replay/changed payload; reason required/unexpected400 ve explicit valid reason; expired selected version409 snapshot rollback; foreign actor/HEALTH/session/permission deny; actual final-batch barrier'lı WON/WON, WON/VOIDED, WON/Task completion tek outcome; başka renewal aynı target premium'u önceden tahsis ettiğinde full-policy-premium409/WON_ALLOCATION_INCOMPLETE ve exact rollback.

İlk modern18 tüm-dosya checkpoint'i16PASS/2FAIL idi (yukarıdaki400/409 yanlış test beklentileri). Doğru backend contract sonrasında modern18 tüm-dosya18PASS; ek allocation case1PASS/18filter skip ayrıca odaklı geçti. **Nihai birleşik131 JSON'u son modern19 case'in tamamını da içerir; final toplam aggregation değil, gerçek whole-file sonuçtur.** Odaklı tekrarlar toplama ikinci kez eklenmedi. İlk16/2 ve filtre skip'ler final PASS değildir.

Cycle ayrı code409 ve real unknown audit failure500/rollback existing permanent8 test ile korunur. Önceki clock-boundary/SENT/WON-expiry fix'leri bu frontend task'ta değiştirilmedi; `QUOTE_EXPIRY_ATOMIC_INTEGRITY.md`, `WON_QUOTE_EXPIRY_ATOMIC_INTEGRITY.md` ve `WON_POLICY_LINK_CYCLE_HTTP_INTEGRITY.md` kabul kanıtları tekrar lengthy real-wait deney yapılmadan kullanıldı. Yeni before-POST expiry testi full rollback'i ayrıca gösterir. User-facing quote difference code sentVersion identity'yi değiştirmez.

### UI:16 dosya302/302 PASS

`node_modules/.cache/phase4ga-ui-closure.json`: **302PASS/0FAIL/0skip**, exit0. Yeni WON30, terminal workspace12, LOST/VOIDED modern36, SENT59, quotes-modern35, task operations19, interactions23, today-work18, statistics6, native quote-navigation2, auth8, legacy completion13, legacy renewal-workspace6, legacy quote14, legacy today14, WhatsApp7.

Yeni30: explicit fullallocation/final confirmation, exact request/no unsupported fields, customer-filtered exact pagination retry, full policy foreign/customer/self/archived/inactive/version ret, SENT explicit selection/no auto acceptance, reason only when difference, expired options ret, wrong Task/renewal/policy/created-policy/amount/currency/version/timestamp success proof fail-closed, lost-response exact retry, HTTP408/429/500/503 unresolved,409 compare/no B retarget/explicit same Task+fresh policy selection+new key, authorized GET-only recovery, delayed detail401/200 after scope-unmount suppression, live POST401 session-ended event. Parent yeni5 case WON dirty/LOST/VOIDED/interaction/task karşılıklı guard'ları doğrular; önceki native navigation/SENT/quote guards korunur.

API131 + UI302 = **433 ayrı otomatik test PASS**. Tam repo suite'i çalıştırıldığı iddia edilmez.

### Gerçek Microsoft Edge:9/9 PASS

Komut: `node.exe tests/browser/today-work.smoke.mjs --won-only`, son closure süreç exit0. `phase4ga-edge-closure.log` yalnız son tam koşudur; eski first/second/third/final adlı başarısız koşular tarihsel FAIL olarak kalır. Browser **155.0.4283.45**, Windows `channel:msedge`, canonical synthetic logins, disposable real local D1.

Kanıt dizini: `C:\Users\sinan\Desktop\panel\node_modules\.cache\phase4ga-edge-acceptance-Dwixy6`. result.json scope `PHASE4GA_LINK_POLICY_ONLY`; üç actor × üç width unique cell toplamı9 ve9 screenshot Python ile sayılarak doğrulandı. Runtime/CSP error0; plaintext credential/key/payload log yoktur.

| Aktör | 1440 | 768  | 360  | Gerçek yetki bulgusu                                                                                                              |
| ----- | ---- | ---- | ---- | --------------------------------------------------------------------------------------------------------------------------------- |
| OWNER | PASS | PASS | PASS | Seçili yetkili Task'ta WON; implicit NORMAL authority. Session revoke sonrası401/korunan DOM cleanup                              |
| Ahmet | PASS | PASS | PASS | Kendi Task'ında WON; başka çalışanın private Task'ında403/404; canlı close_won grant kaybında ret; session revoke sonrası cleanup |
| Ayşe  | PASS | PASS | PASS | Kendi Task'ında WON; başka çalışanın private Task'ında403/404; canlı close_won grant kaybında ret; session revoke sonrası cleanup |

Her aktörde üç width: mevcut policy numarası arama/explicit choice/fresh detail/fullminor ayrı confirmation;1440'da açık SENT association+actual ACCEPTED event/policy readback;768'de server gerçekten commit olduktan sonra kayıp yanıt ve aynı serialized body/key replay;360'ta kabul sonrası policy GET503 ve GET-only recovery/ikinci POST0;9 screenshot ve horizontal overflow0. Tablet sidebar intentionally collapsed olduğundan sidebar/nav extra probe desktop viewport'ta çalışır, retry öncesi768'e geri dönülür.

Her aktörde ek real A1→B1 ordinary task completion sonrası frozen A request409, renewal/B/link/history/receipt/SUCCESS snapshot unchanged; compare B'yi benimsemez. Her aktörde real reverse LINK_POLICY kurulup ileri cycle409/full rollback UI conflict'e yansır,500/uncertain sayılmaz. Dirty WON sırasında LOST düğmesi kapalı ve sidebar leave-stay draft korunur; unresolved queue refresh/sidebar/native back bloklanır. Existing quote-navigation UI testleri back/forward boundary'sini de korur. Browser storage toplam0; logout sonrası outcome forms0. OWNER için private-task/grant-deny test uygulanmadı; result.json false değerleri OWNER'a ret beklenmesi değildir.

### Kalite, sınırlar ve yayın kapsamı

Son typecheck/lint/format-check/client build/Worker **yalnız dry-run**/security boundaries/diff-check PASS. Kaynak backend, migration, dependency ve Wrangler config no-diff. Mevcut Wrangler multi-environment uyarısı vardır; production deploy yapılmadı. Bağımsız reviewer kullanılmadı.

Dokuz dosyalık frontend/test/evidence scope: WonPolicyOperation; RenewalOutcomesSection; TodayWorkPage; modern WON API/UI; terminal workspace UI; today-work browser harness ve yeni won-policy walkthrough; bu belge. Legacy selector yeniden yazılmadı. Status belgesi stage/commit dışıdır; SHA256 `f272a14efce57f2ef47d960c2ac387e11cdaeda96aa6fda71db8585844e28930`.

Remaining limits: yalnız mevcut policy LINK_POLICY ve tüm prim allocation. CREATE_POLICY/EXISTING_LINKS/group/cross-policyholder/partial allocation/reopening/correction/rejection UX yoktur. Yetkili GET yeterli değilse unverified ve GET-only recovery kalır; tamamlanan Task/link DB satırlarını public GET sağlıyor iddiası yoktur. Production/Cloudflare mutation/migration/Paid/gerçek müşteri/dış mesaj/document/R2 yoktur. Phase4G-B başlatılmadı. LOCAL GO yalnız bu yerel kabulün sonucudur.
