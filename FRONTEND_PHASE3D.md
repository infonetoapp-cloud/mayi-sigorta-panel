# FRONTEND PHASE3D — modern zeyil ve dış referans

Başlangıç `8d1e2803fd8a47aecfd9d4be3040a1852aa63178`. Bu uygulama/kanıt kaydıdır; mimari otorite nihai plan12/18 bölümleridir. Önceden kirli `UYGULAMA_DURUMU.md` kullanıcı talimatıyla byte düzeyinde korunur ve commit dışında bırakılır.

## Modern append-only işlemler

- `/policies/:policyId?section=amendments`: tarihsel zeyil listesi ve inline create formu; required dış referans(max200), canonical effective date, description(max2000), optional signed premium difference ve eşlenik ISO currency. Update/delete/yeni dönem/renewal/cancellation veya özgün poliçe primini değiştiren bir işlem eklenmez.
- `/policies/:policyId?section=external-references`: tarihsel liste ve inline sourceNamespace(max100)/externalKey(max200). Yalnız mevcut POST endpoint'i kullanılır; entegrasyon/senkronizasyon icat edilmez. Server tenant/uniqueness/CAS kuralları aynıdır.
- Her section ayrı keyed PolicyAppendSection instance'ıdır: ayrı form/draft/pending URL-method-body-key snapshot. Shared presentation/protocol kodu tek yerde, backend business/auth modelleri client'a taşınmaz; eski salt-okunur RelatedSection modern append bölümleriyle yer değiştirir. Legacy amendment/reference yolları kaldırılmaz.
- Archived policy listesi authorized history olarak görünür, yeni aksiyonlar/form disabled'dır. Ordinary history yalnız DTO'nun zeyil/reference alanlarını render eder; identity/health/personnel fields veya belge viewer eklenmez.

## Decimal ve validation

Signed input regex/BigInt absolute minor hesabıyla değerlendirilir; canonical nokta, en fazla2 decimal, pozitif/negatif/sıfır kabul edilir. Başta +, virgül, binlik ayırıcı, fazla decimal ve mutlak MAX_SAFE_INTEGER minor aşımı reddedilir. Mevcut strict unsigned helper absolute input için reuse edilir; floating-point major-unit dönüşümü yapılmaz. Number dönüşümü yalnız güvenli integer minor sonucu için preview renderer'a gider. Negatif sub-unit görünümü `-0,50 TRY` olarak korunur.

Prim farkı ve currency birlikte dolu veya ikisi de null'dır;0 boş sayılmaz. Required alan/length/canonical date ve ISO currency client yardımında kontrol edilir; nihai otorite server strict schema'dır. Exact backend kontratı değiştirilmedi.

## Mutation ve concurrency

- Yeni attempt parent-policy version'ı form açılışında sabitler.409 sonrası otomatik yazım yok; draft korunur, authorized policy+relevant list refresh/comparison ve user reconfirmation gerekir. Yeni attempt pinned comparison version ile çalışır, unrelated prop refresh sürümü ilerletmez.
- External duplicate409, genel CAS409'dan yeni kayıt başarısı gibi yorumlanmaz. Refreshed mevcut listede aynı namespace/key görülürse ikinci POST gönderilmez; kullanıcı taslağı düzeltir veya vazgeçer. Farklı policy'deki duplicate için de server global agency uniqueness otoritesi kalır; bu UI kendi portföy araması yapmaz.
- Çift submit ref ile kesilir. Belirsiz response/network/5xx/429 sonrası yalnız exact original URL/method/serialized body/key retry vardır. Pending body/key veya draft browser storage'a yazılmaz; garanti mevcut mount ömründedir. Belirsiz işlemde refresh/navigate yerine retry kullanılmalıdır; durable reload recovery eklenmedi.
- Success, authorized policy+relevant list GET readback'i tamamlandıktan sonra gösterilir. Write committed/readback failed durumunda retry yalnız GET; yeni POST yoktur. Parent detail fresh policy ile güncellenir.401 session cleanup;403/404 korunan section/form gizlenir. Raw server diagnostics gösterilmez.
- Keyed policy+section mount, generation ve scoped read/CSRF AbortSignal geç yanıt/late401'in başka policy/section/current session'a etkisini keser. Amendment ve reference state'leri birbirine taşınmaz.

## Doğrulama

- İlk gerçek localD1/API6/6 PASS; frontend geliştirme öncesi mevcut append kontratı doğrulandı. Son kabulde aynı6 test güçlendirilmiş evidence kontrolleriyle geçti. Pozitif/negatif/sıfır/absent/min/max signed values; invalid pair/format/overflow/date/length/ISO; reference uniqueness; exact create replay; same-parent-version concurrent refs201+409; tek parent increment, tek child/receipt/SUCCESS audit ve stale amendment no-effect; authorized archived history/newwrite rejection; OWNER/Ahmet/Ayşe; foreign404/ungranted403/revoked401/HEALTH403/no protected data/no successful effects. Gerçek backend lifecycle/auth kusuru doğrulanmadı; backend değiştirilmedi.
- Yeni UI32/32 PASS: canonical payload/history, signed boundaries/pair rejection, opening+comparison CAS pinning, explicit409 comparison/draft retention, duplicate-list no-second-POST, double-submit/lostresponse exact retry for both kinds, write-success/readback-failure GET-only, archived read-only, denied cleanup, keyed late csrf401/write/readback401 suppression.
- Son odaklı8 dosya137/137 PASS: yeni UI/API + modern insured-party/forms/pages, legacy policy mutation, customer pages, AppShell regresyonları. Tekrar koşular benzersiz test sayısına eklenmez; unrelated historical suite yoktur.
- Tek gerçek installed Edge walkthrough PASS. OWNER/Ahmet/Ayşe için1440/768/360; dört signed/zero/absent zeyil, özgün premium/endDate/status değişmezliği, gerçek parent PATCH→409→explicit comparison, amendment/ref commit201 sonrası503 exact retries, write/list503 sonrası GET-only retry; external ref duplicate409→refresh→no resend; historical direct reload ve back/forward. Aynı tur modern policy individual/company create/edit/readback/first20 dışı handoff, insured-party create/deactivate/history, legacy handoff ve edit live revocation cleanup regresyonlarını korur. Raw credential/diagnostic log yoktur.
- Typecheck/lint/format/build(client+Worker yalnız dry-run)/security boundaries PASS. Mevcut multi-environment Wrangler selection uyarısı dry-run'da sürer; deployment yapılmaz. Yeni dependency/migration/trigger/shared DTO/auth/backend/scripts/deploy/Cloudflare/Paid/gerçek veri/document activation değişikliği yoktur.
- Bu dar frontend diliminde ek ajan veya review zinciri başlatılmadı; yeni server yetki/ilişki mekanizması eklenmedi, mevcut atomik komutlar gerçek API/evidence ve focused client tests/browser ile doğrulandı.

## Kalan kapsam ve demo

Atama, arşivleme, sensitive identity-variant secure confirmation ve mevcut advanced/backstop işlemler `/policies/legacy` içinde korunur; eski zeyil/reference create yolları da durur. Documents/private R2, renewal generation, quotes ve günlük Task davranışı değiştirilmedi. Açık yerel kabul blocker'ı yoktur; production release veya belge kabulü değildir.

`npm run demo`; maskeli PowerShell giriş sorunu için yalnız sentetik demo parolalarıyla `npm run demo -- --visible-input` (terminalde görünür). https://localhost:8443 → Poliçeler → poliçe → Zeyiller / Dış referanslar. Yeni kayıt inline formdadır; ayrıntılar `LOCAL_DEMO_TR.md`.
