# Quote SENT atomik süre bütünlüğü — LOCAL VERIFIED

Taban: `8723495af9eba63448210bc680b6c7ed6d875385`. Bu görev yalnız dar backend düzeltmesidir. **Phase4E LOCAL NO-GO kalır; frontend ayrı kabul bekler.** Frontend adayı, eski BLOCKED kanıtı ve korunan durum belgesi değiştirilmedi; yeni frontend/Edge kabulü veya bağımsız reviewer onayı verilmedi.

## Kök neden ve düzeltme

`sendRenewalQuote` valid_until için yalnız JavaScript preflight kontrolü yapıyordu; final D1 batch beklerken süre dolabiliyordu. Erken kontrol aynen korundu. Aynı mevcut batch'te authority assertion ve receipt INSERT'ten sonra, ilk SENT event INSERT'inden önce13 satırlık `d1_cas_assertions` eklendi. Receipt'in önce kalması mevcut same-key race reconciliation sırasını korur; başarısız assertion receipt dahil tüm batch'i geri alır.

SQL exact agency+renewal+quote+quoteVersionId bind'leriyle Quote'u ve onun **current** immutable sürümünü join eder. `length(valid_until)=24` ve `strftime('%Y-%m-%dT%H:%M:%fZ',valid_until)=valid_until COLLATE BINARY` canonical UTC millisecond biçimini fail-closed doğrular. Ardından:

```sql
v.valid_until COLLATE BINARY > strftime('%Y-%m-%dT%H:%M:%fZ','now')
```

Karşılaştırma sırasında SQLite'ın gerçek saati kullanılır; JS now bind'i, ikinci JS kontrolü, saniyeye kırpma veya floating-point Julian-day farkı yoktur. Sabit genişlikte canonical UTC text'in binary sıralaması zaman sıralamasıdır. Eşitlik geçerli sayılmaz; invalid/noncanonical/offset/eksik veya yanlış target ret olur. Mevcut CAS assertion ABORT ve `mapWriteError` yolu güvenli HTTP409 üretir. Existing quote CAS, DRAFT/READY, current-version, authority, event/audit ve receipt sırası değişmedi. Existing receipt replay expiry precheck/assertion önündedir; başarılı tarihsel işlem süresi dolunca da yazımsız replay olabilir.

Yeni migration/trigger değişikliği yoktur. Mevcut assertion cleanup mekanizması kullanılır. Create/version/insurer-product identity/acceptance/terminal kuralları değiştirilmedi.

## RED → GREEN: orijinal test değiştirilmedi

```text
npx vitest run tests/renewal-quote-send-modern.api.test.ts -t 'rejects expiry after preflight' --maxWorkers=1
```

Düzeltme öncesi gerçek tekrar: **1FAIL/17 filtre skip**,87.71s. HTTP201, SENT/CAS2/event1; beklenen HTTP409,DRAFT/CAS1/event0. Test gerçek validUntil+100ms'yi bekler; SQLite saati/SQL/immutable row mock değildir. Skip'ler PASS sayılmaz.

Düzeltme sonrası orijinal dosya bütün halinde **18/18 PASS**. Hem aynı negatif hem receipt/audit/current-pointer dahil exact rollback snapshot'ı GREEN; test dosyasının başlangıç SHA256'sı aynıdır. Dosya Phase4E adayının parçası olduğu için commit edilmez. Kalıcı backend commit'e bunun ayrı30s real-time barrier regresyonu eklendi.

## Son odaklı kanıt

- `tests/renewal-quote-expiry-atomic.api.test.ts`: **17/17 PASS**. İlk14/14 checkpoint sonrası üç yarış kalıcılaştırıldı; son bütün-dosya17 sonucu esas alınır.
- Korunan `tests/renewal-quote-send-modern.api.test.ts`: **18/18 PASS**. OWNER/Ahmet/Ayşe, DRAFT/READY, current/CAS, preflight expiry, atomik expiry, receipt/event/audit ve exact historical replay, changed payload, SENT/REJECTED/EXPIRED/ACCEPTED retleri; HEALTH/cross-agency/revoked-session/permission revoke, gerçek barrier'lı send/send ve send/version yarışları.
- `tests/renewal-quote-identity.api.test.ts` + korunan `tests/renewal-quotes-modern.api.test.ts`: **24/24 PASS**. V1 insurer/product invariant'ı, geçerli same-identity immutable revisions, yeni alternatif Quotes, create/version replay/concurrency ve legacy send/WON korunur.
- Toplam **4 dosya59 ayrı test PASS**. Tarihsel geniş suite'ler ve Phase4E UI/Edge tekrar edilmedi. JSON sonuçları `node_modules/.cache/quote-expiry-final.json`, `quote-expiry-existing-green.json`, `quote-expiry-siblings.json` içindedir.

### Milisaniye sınırı

Yeni dosya gerçek production assertion SQL'ini çalışırken yakalar; koşul testte yeniden yazılmaz. Yalnız disposable fixture'daki control trigger'ında aynı sqlite3_step içinde yeni immutable v2'nin valid_until değeri gerçek `strftime(...,'now',offset)` ile oluşturulur, current pointer bağlanır ve yakalanmış assertion aynı adımda çalışır. SQLite'ın step içindeki now sabitliği exact boundary'yi deterministik yapar; sağlayıcı saati veya production predicate değiştirilmez, mevcut guard'lar kaldırılmaz.

- DB now−1ms: ABORT, rollback PASS.
- DB now tam eşit: ABORT, rollback PASS.
- DB now+1ms: assertion PASS; persisted observation iki canonical UTC timestamp arasında tam1ms farkı doğrular.
- Canonical olmayan tarih, olmayan gün, eksik `.000`, timezone-offset biçimi: HTTP409, exact snapshot aynı.
- Yanlış agency/renewal/quote, eksik sürüm ve historical-not-current sürüm: exact production assertion fail-closed.

Retlerde Quote status/CAS/current pointer, immutable versions, events, receipts, audit ve assertion tablosu snapshot'ı aynıdır. Assertion artık satır bırakmaz. Başarılı SENT sonrası gerçek süre dolmasını bekleyen fixture aynı key/body'nin original result'ı döndürdüğünü, yeni key ve değişen same-key payload'ın409 verdiğini ve evidence'in değişmediğini doğrular. Son batch öncesinde iki preflight'ı birleştiren barrier yarışlarında same-key `[200,201]`, different-key/send-vs-version `[201,409]`; bir receipt/bir audit, tek kazanan business effect ve orphan assertion0 doğrulandı.

## Kalite, inceleme ve korunma

`npm run typecheck`, `npm run lint`, değişen backend+regresyon dosyasının Prettier check'i, `npm run build` (client + Worker **yalnız dry-run** + security boundaries), `git diff --check`: PASS. İlk lint yeni testte prefer-const uyarısı verdi; yalnız testte const düzeltildi ve yeniden PASS. Canonical runtime sonrasında değişmedi; son test eklemelerinden sonra typecheck/lint/format yeniden PASS. Wrangler'ın mevcut çoklu-environment seçim uyarısı var; deploy yoktur. Client build worktree adayını derlemiştir, Phase4E kabulü değildir. Korunan adayın formatını değiştirmemek için formatter write yalnız yeni backend testine uygulandı.

Uygulayıcı incelemesi: bind'li SQL ve current/tenant join, DB-clock strict UTC/ms predicate, first-business-write öncesi assertion, receipt rollback/race sırası ve historique replay kontrol edildi; yeni log/secret/network/serbest audit metadata yoktur. Added-line statik tarama PASS. Ayrı reviewer yetkisi olmadığı için bağımsız inceleme yapılmadı.

Başlangıçtaki9 modified/untracked dosyanın SHA256 envanteri repo dışında `mayi-expiry-fix-baseline.json` olarak tutuldu;9/9 byte aynı. Tüm Phase4E frontend kaynak/test/kanıtı korunur ve commit dışındadır. Korunan `UYGULAMA_DURUMU.md` SHA256:

`f272a14efce57f2ef47d960c2ac387e11cdaeda96aa6fda71db8585844e28930`

Commit allowlist yalnız `src/server/renewals/engagement.ts`, `tests/renewal-quote-expiry-atomic.api.test.ts` ve bu kanıttır. Reset/clean/stash, frontend resume, production/Cloudflare mutation/migration/Paid/gerçek veri/WhatsApp-email/document/R2 aktivasyonu yoktur. Sonraki tek ürün kapısı ayrıca yetkili Phase4E frontend tamamlama ve kabulüdür; burada açılmadı.
