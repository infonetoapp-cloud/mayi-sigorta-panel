# WON quote acceptance atomik süre bütünlüğü — BACKEND CLOSED / LOCAL VERIFIED

Taban: `80d11d38ed0007e6bcd5754820661e96a688f3f3`. Dar backend yetkisi; modern WON frontend geliştirme/kabulü değildir. **Phase4F LOCAL GO korunur. Phase4G-A LOCAL NO-GO kalır; ayrı frontend yetkisi ve kabulü gerekir.** Phase4G-B başlatılmadı.

## Runtime değişikliği: yalnız üç SQL koşulu

`src/server/renewals/commands.ts:2538` — mevcut `wonQuoteAcceptanceAssertion` EXISTS predicate'ine, zaten join edilmiş immutable version alias `v` için:

```sql
AND length(v.valid_until)=24
AND strftime('%Y-%m-%dT%H:%M:%fZ',v.valid_until)=v.valid_until COLLATE BINARY
AND v.valid_until COLLATE BINARY > strftime('%Y-%m-%dT%H:%M:%fZ','now')
```

Canonical UTC/ms text binary karşılaştırması gerçek SQLite statement clock kullanır; equality expired'dır. JS timestamp bind'i, yeni endpoint/migration/trigger/schema veya yeni hata mapping'i yoktur. JavaScript erken ret, agency/renewal/quote/version/current pointer/CAS/SENT/previous acceptance/policy ACTIVE link/receipt koşulları ve bind sırası aynıdır.

Assertion aynı `db.batch` içinde policy-link/terminal/task yazımlarından sonra ve ACCEPTED event'ten önce kalır. ABORT, önceki link/task/renewal/receipt dahil bütün batch'i rollback eder. `RENEWAL_QUOTE_ACCEPTANCE_CONFLICT` kodu korunur. Yerel fixture'ın gerçekten kurulmuş `sqlite_master.d1_cas_assertions_guard` SQL'i incelenir; tanınmayan mismatch fallback'i `OPTIMISTIC_CONCURRENCY_CONFLICT` üretir; mevcut `mapBatchError` HTTP409'a çevirir. Orijinal route regresyonu409 doğrular;500'e dönüş yoktur.

Guard yalnız explicit acceptedQuoteVersionId acceptance yolunda kullanılır. LINK_POLICY/CREATE_POLICY/eligible EXISTING_LINKS aynı helper'ı kullanır; mali/prim/identity/ownership/link kuralları ve business batch sırası değiştirilmez. Quote association'sız WON bu assertion'ı eklemez. Başarılı historical replay yeni batch/expiry gate öncesinde mevcut receipt yolundan döner.

## Orijinal gerçek D1 RED → GREEN

Korunmuş `tests/renewal-won-quote-expiry-preflight.api.test.ts` byte-for-byte aynıdır:

`e389dd1580e0bda92617333a17080ba218d5cb2493f297e518cb13e1db1f1166`

Komut iki defa aynı testte çalıştırıldı:

`node.exe node_modules/vitest/vitest.mjs run tests/renewal-won-quote-expiry-preflight.api.test.ts --maxWorkers=1 --reporter=json --outputFile=node_modules/.cache/won-expiry-original-{red|green}.json`

- Düzeltme öncesi gerçek RED: exit1,0PASS/1FAIL/0skip. validUntil `2026-10-19T16:48:10.322Z`, gerçek SQLite batch öncesi now `2026-10-19T16:48:10.553Z`, sqlExpired=true. HTTP200, renewal WON/v2, orijinal Task COMPLETED/v2, quote ACCEPTED/v3;1link/1ACCEPTED event/1receipt/1SUCCESS audit, unchanged=false.
- Yalnız üç SQL satırı sonrası aynı regresyon GREEN: exit0,1PASS/0FAIL/0skip. HTTP409, renewal CONTACT_PENDING/orijinal CAS, original Task OPEN/orijinal CAS, quote SENT/v2/accepted_version_id=null,0link/0ACCEPTED event/0receipt/0SUCCESS audit, full snapshot unchanged=true.
- Bu regresyonun10-table snapshot'ı policies ve immutable quote versions dahil bütün satırları karşılaştırır. Yeni companion test snapshot'ı ayrıca `renewal_state_history` içerir. Assertion tablosu0 kalır. Orijinal testin real60s barrier'ı ve180s timeout'u zayıflatılmadı; eski investigation60s timeout'u business RED/PASS sayılmadı.

## Kalıcı ek test yaklaşımı

`tests/renewal-won-quote-expiry-atomic.api.test.ts` disposable Miniflare gerçek D1 + gerçek auth/CSRF/idempotency route'larını kullanır. Production assertion SQL'i ve sekiz bind gerçekten route çalışırken yakalanır; testte expiry predicate'i yeniden yazılmaz.

- Exact ms boundary: disposable fixture control trigger'ının aynı sqlite3_step'ında yeni immutable version real SQLite now−1ms/now/now+1ms ile INSERT edilir, orijinal SENT receipt/event ve mevcut WON/link/receipt ilişkilerini sağlayan ayrı fixture quote bağlanır; yakalanmış production assertion aynen çalışır. Trigger'lar yalnız disposable test tablosuna kurulur; guard kaldırılmaz, immutable version UPDATE/DELETE edilmez, SQL clock mock değildir. +1ms case persisted now/validity farkını tam1 olarak doğrular; −1ms ve eşitlik ABORT + snapshot rollback doğrular.
- Aynı production SQL invalid, olmayan gün, eksik ms ve timezone-offset valid_until retlerini fail-closed doğrular.
- Wrong agency/quote/renewal/missing or noncurrent version/current quote CAS/policy/receipt bind'leri ret. Yanlış bind testlerinde gerçek production batch'in assertion öncesi statement'ları da aynı test transaction'ında çalıştırılır; bu link/task/state/history/receipt değişikliklerinin assertion hatasında tümüyle rollback olduğunu gösterir. Ardından doğru orijinal batch normal200 alır; dolayısıyla ret unrelated eksik WON/link önkoşulundan çıkarılmaz.
- Gerçek süre dolduktan sonra aynı key/body WON orijinal historical result'ı döndürür; changed same-key payload ve new key409;11-table snapshot değişmez.
- Son batch'te barrier ile aynı-key ve farklı-key WON yarışları, tek logical policy-link ve ACCEPTED event üretir.
- LINK_POLICY/CREATE_POLICY/EXISTING_LINKS quote association'sız başarılıdır; quote SENT kalır. CREATE_POLICY201, diğerleri200 mevcut response contract'tır.
- CREATE_POLICY ve eligible single EXISTING_LINKS için valid selected quote acceptance ile real-wait expired acceptance rollback ayrı doğrulanır. EXISTING_LINKS fixture'ı mevcut allocation receipt+ACTIVE link'i kurar; runtime allocation/financial rules veya grant yolu değiştirilmez, yeni frontend yetkisi değildir.
- Başarılı preflight sonrası quote CAS/current pointer/policy CAS değişikliği409 ve mutation öncesi raced snapshot korunumu.
- MEMBER için açık gerçek grants ve kendi Task atamasıyla selected-quote WON success; quote.manage kaybı/HEALTH/foreign agency/revoked session/suspended membership deny. OWNER success diğer route testlerinde. Session veya revoked epoch yeniden canlandırılmaz.

## Tarihsel denemeler ve final kapı

- İlk companion bütün koşu foreground300s sınırında kesildi; final JSON yoktur, tamamlanmış PASS sayılmaz.
- İlk odaklı diagnostic:1PASS/3FAIL/22filter skip. Yeni fixture yanlış event sütun adları ve allocation receipt FK'si kullanıyordu; CREATE_POLICY201 beklenmesi gerekirken helper200 bekliyordu. Bunlar yeni test fixture/response beklenti hatalarıdır; üretim domain kusuru veya expiry gate'i gevşetme nedeni değildir.
- İkinci diagnostic:1PASS/2FAIL/23filter skip. SENT event insertion guard'ı fixture quote'un DRAFT/READY olmasını, link gerçek receipt FK'sini gerektiriyordu. Fixture bunları mevcut şemaya uygun kuracak şekilde düzeltildi; trigger/guard disable edilmedi. Yanlış bound CAS case'i bu koşuda GREEN idi.
- Sonraki foreground bütün companion denemesi tool420s sınırında kesildi; logda22 tamamlanmış case PASS görünür ancak nihai suite sonucu yoktur. Aynı suite kalıcı test ekleriyle daha sonra background'da tamamlanacak; kesilmiş deneme final PASS sayılmaz.
- Yeni testte unused type import typecheck hatası giderildi; runtime ek değişikliği yapılmadı. Bu task'ta eski happy-path fixture timestamp'i veya domain beklentisi değiştirilmedi.
- Tarihsel loglar: `won-expiry-focused-first.json` üretilmedi; `won-expiry-diagnostic.log`, `won-expiry-diagnostic-second.log`, `won-expiry-focused-complete.log` cache'dedir. Original RED/GREEN JSON'ları ayrı tutulur.

Tam companion koşusu `won-expiry-permanent-final.json`: **32PASS/1FAIL/0skip**. Tek FAIL yeni MEMBER positive fixture'ında yalnız Task assignee değiştirilip renewal assignee eşleşmesinin korunmamasıydı. Mevcut backend'in normal reassignment invariant'ı gevşetilmedi; yalnız yeni fixture'da renewal ve Task aynı üyeye atandı. İzinler genişletilmedi. Bunu izleyen authorization-only koşu **6PASS/0FAIL/27filter skip** (`won-expiry-authorization-final.json`).

Ek son odaklı gate, düzeltilmiş6 authorization case'i + güçlendirilmiş2 concurrency case'i + gerçek historical-v1/current-v2 case'ini birlikte çalıştırdı: **9PASS/0FAIL/24filter skip**, exit0 (`won-expiry-final-targeted.json`). Concurrency case'leri ayrıca tek receipt, tek WON SUCCESS audit, initial+WON iki history, orijinal Task COMPLETED/CAS+1 ve assertion satırı0 doğrular. Historical case'inde immutable v2 eklenip current pointer v2 yapılır; selected v1 artık gerçekten history'dir ve unchanged production assertion reddeder. Predicate veya immutable kayıt değiştirilmez; standalone negatif sonrası fixture pointer'ı original route'u karşılaştırmalı başarılı çalıştırmak için geri alınır.

Companion kabulü bütün dosya tek koşu33PASS iddiası değildir: final9 case'in dışındaki değişmemiş24 case tam koşudan, değiştirilmiş9 case son gate'ten alınır. Full test name ile latest gerçek executed-result dedupe **33 ayrı case PASS** (`won-expiry-accepted-aggregate.json`); filtre skip'ler case sonucunu geçersiz kılmaz ve PASS sayılmaz. İlk aggregation komutu skipped statüsünü pending sanarak assertion'da durdu; rapor yazmadı. Yalnız passed/failed executed status seçimiyle tekrar doğrulandı; test sonucu üretilmedi veya uydurulmadı.

Legacy terminal request UI **13/13 PASS**, exit0 (`won-expiry-legacy-ui.json`). Mevcut6 backend dosyasının tek birleşik koşusu **103/103 PASS,0FAIL/0skip**, exit0 (`won-expiry-existing-regression.json`):

| Dosya                                      | PASS |
| ------------------------------------------ | ---: |
| renewal-quote-expiry-atomic.api.test.ts    |   17 |
| renewal-quote-identity.api.test.ts         |   11 |
| renewal-quote-send-modern.api.test.ts      |   18 |
| renewal-quotes-modern.api.test.ts          |   13 |
| renewal-terminal-task-identity.api.test.ts |   25 |
| renewals.m3-t03-terminal.test.ts           |   19 |

Toplam bağımsız kapsam: mevcut103 + değişmemiş orijinal1 + companion33 = **137 API/D1 case PASS**; legacy UI13 ile **150 ayrı case PASS**. Companion'ın33'ü açıkça yukarıda belirtilen latest-executed case aggregation'dır, tek bütün-dosya33PASS koşusu değildir. Repeat/test checkpoint sonuçları toplama ikinci kez eklenmedi. Orijinal1, mevcut103 ve legacy UI13 sonuçlarında skip yoktur; son companion odaklı koşudaki24filter skip PASS sayılmaz. Son named-case kabulünde başarısız case kalmadı.

Mevcut suite'ler SENT gerçek expiry barrier/replay/concurrency/authorization, immutable insurer/product identity ve revision yarışları,25 primary Task identity/receipt/revocation regression ve19 legacy WON/LOST/VOIDED regression'ını korur. Legacy üç WON branch'i, WON/LOST yarışı, current permission/HEALTH kontrolleri ve quote acceptance ilişkisinin mevcut domain assertions'ları değişmedi. Eski pozitif fixture'larda timestamp/domain assertion düzeltmesi **0**. Geniş tüm-repo/UI/Edge suite'i çalıştırılmadı; bu backend kapanışının kapsamı değildir.

**Backend integrity fix CLOSED / LOCAL VERIFIED.** Atomic expired acceptance blocker düzeltildi; **Phase4G-A halen LOCAL NO-GO**, ayrı frontend implementation ve acceptance yetkisi bekler. Eski `FRONTEND_PHASE4G_A.md` historical failure kaydı geriye dönük PASS'a çevrilmez.

## Kalite ve korunma

Typecheck/lint/format-check/client build/Worker yalnız dry-run/security boundaries/diff-check mevcut son runtime+test kaynağında PASS. Wrangler'ın mevcut multi-environment uyarısı var; gerçek deploy yoktur. Bağımsız reviewer kullanılmadı; uygulayıcı incelemesi exact SQL/bind korunumu, batch ABORT, replay önceliği ve scope ile sınırlıdır.

Başlangıç dirty/untracked SHA envanteri cache'de `won-expiry-preservation-baseline.json` tutulur. `FRONTEND_PHASE4G_A.md` historical NO-GO kanıtı byte-for-byte korunur ve commit dışıdır; SHA256 `1e0ee32ab2727a7d68089537775d1aed7854bc73c7569fbf8f3c146281dbbc7b`.

Protected `MayiSigorta_CRM_Planning_Pack_v2/UYGULAMA_DURUMU.md` SHA256 `f272a14efce57f2ef47d960c2ac387e11cdaeda96aa6fda71db8585844e28930`; edit/stage/commit yoktur. Orijinal regression assertion'ları ve dosya hash'i korunur; GREEN hali backend-only commit'e alınabilir.

Commit allowlist yalnız commands.ts, orijinal backend regression, yeni backend-only companion regression ve bu evidence'dır. Frontend/legacy kaynak, investigation dosyası, status belgesi, schema/migration/Wrangler/dependency değişikliği yoktur. Reset/clean/stash, production/Cloudflare/Paid/gerçek veri/dış mesaj/document/R2 yoktur. Backend kapanışı Phase4G-A frontend kabulü değildir.
