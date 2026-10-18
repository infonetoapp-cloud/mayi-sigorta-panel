# FRONTEND PHASE3C — modern sigortalı/lehtar yönetimi

Başlangıç `2f523aa3f82382ba0e86fa65e60db12061f32760`. Bu uygulama/kanıt kaydıdır; mimari otorite nihai plan12/18 bölümleridir. Kullanıcıya ait kirli `UYGULAMA_DURUMU.md` byte düzeyinde korunur ve commit dışında kalır.

## Modern taraf işlemleri

`/policies/:policyId?section=parties` içinde PolicyPartiesSection: authorized party DTO'sundan yalnız ad/rol/aktif-pasif özeti; pasif geçmiş silinmez. Party link'inden müşteri profili veya diğer poliçelere erişim bağlantısı üretilmez. Bilgilendirme bu ilişkinin erişim hakkı vermediğini ve pasifleştirmenin müşteri arşivi/poliçe iptali olmadığını açıklar.

Inline ekleme formu mevcut server-side customer search(limit20) kullanır; tüm portföy veya cursor taraması yapılmaz. Müşteri ve rol boş başlar, explicit seçilmelidir. Exact customer GET/idmatch/archived kontrolü başarılı olmadan seçili müşteri mutation'a hazır sayılmaz. Choice doğrulaması yalnız id/ad özetini saklar; API'nin döndürdüğü identity/contact/health/personnel içeriği gösterilmez veya URL/storage'a taşınmaz. Arama yenilemesi eski seçimi temizler; başka müşteri otomatik atanmaz.

Aktif taraf satırı ayrı inline pasifleştirme onayı açar; ilk tıklama write yapmaz. Backend create/deactivate, CSRF, yetki, receipt/audit ve atomik ilişki kuralları değiştirilmez. Archived policy salt okunurdur; normal modern create/edit/detail ve legacy advanced rotaları korunur.

## CAS ve retry

- Create POST `/api/policies/:id/parties`: customerId+role ve form açılışındaki parent-policy expectedVersion. Başka parent prop refresh bu sürümü ilerletmez. Bu regresyon RED'de beklenen8/gelen15 ile görülüp açılış snapshot'ına sabitlendi.
- Deactivate POST `/api/policies/:id/parties/:partyId/deactivate`: yalnız seçilen party expectedVersion; policy version'a çevrilmez.409 sonrası explicit refresh policy+party listesi ve create'te seçili müşteri yetkisini tekrar doğrular; comparison snapshot/version ve yeniden user onayı olmadan yazım açılamaz. Draft customer/role korunur, kaybolan/pasif target yeni aktif target ile değiştirilmez.
- Aynı anda çift submit ref ile engellenir. Belirsiz yanıt/ağ/5xx/429 sonrası yalnız immutable original URL/method/body/key retry; field/status değiştirerek yeni attempt üretilmez. Pending/draft yalnız component belleğindedir; browser storage/durable reload recovery yoktur. Belirsiz işlemde sayfayı yenilemeden retry kullanılır.
- Başarıdan sonra authorized policy detail ve party list GET'leri birlikte tamamlanmadan başarı mesajı verilmez. Readback failure yalnız GET retry yapar, write yeniden gönderilmez. Fresh policy parent detail state'ine aktarılır.401 session-ended;403/404 protected party/form gizlenir ve yeni yazım kilitlenir; raw server hata metni gösterilmez.
- Policy keyed mount/generation ve read/CSRF abort controller, geç mutation/detail/customer/401 yanıtlarının başka policy veya oturuma etkisini keser. CustomerPicker sequence/abort, stale selection yanıtını da keser. Parent policy/detail/callback/party ve customer yetkileri server-owned kalır.

## Yerel kanıt

- Yeni UI21/21 PASS: aktif/pasif özet; no linked-profile/no protected fields; explicit role/customer selection; parent vs child payload; opening-CAS pinning; double-submit/exact retry; create409/deactivate409 separate comparison; successfulwrite/failedreadback GET-only; denied/archived customer; archived policy read-only; revoked/permission write cleanup; keyed late csrf/csrf401/write/readback/readback401/customer401 suppression.
- Gerçek localD1/API6/6 PASS: OWNER/Ahmet/Ayşe shared authorized operations/history; INSURED ve BENEFICIARY aynı customer/policy bağları; parent increment/stale create409 vs childdeactivation version; exact create/deactivate replay ve state/receipt/SUCCESS audit değişmezliği; missing/foreign/scoped inaccessible/archived customer rejection; archived policy create/deactivate ret+history200; foreign/ungranted deny; revoked GET ve iki POST401; OWNER dahil explicit sensitive izni olmayan HEALTH read/create/deactivate403/no data. Kapsam dışı backend lifecycle/access-control kusuru doğrulanmadı; backend değiştirilmedi.
- Son odaklı7 dosya105/105 PASS: yukarıdaki UI/API, modern policy forms/pages, legacy policy mutation UI, customer pages ve AppShell. Tekrar koşular benzersiz test sayısına eklenmez; unrelated tarihsel suite çalıştırılmadı.
- Gerçek installed Edge + disposable D1/canonical login PASS. Önceki focused form smoke'a ayrı party walkthrough helper eklendi: üç kullanıcı için sigortalı+lehtar create, explicit authorized selection, gerçek parent PATCH→create409→compare, lost create201→503→samebody/key replay; explicit deactivation child version, deactivation200→503→samebody/key replay, successfulwrite/list503→GET-only retry, inactive history direct reload ve no customer navigation;1440/768/360 overflow. Aynı tur modern individual/company creation, taksit, policy edit/readback, handoff outside first20, list/detail/back-forward, legacy handoff ve edit session-revoke cleanup regresyonlarını korudu.
- Typecheck/lint/format/client+Worker dry-run/boundaries PASS. Wrangler'ın mevcut multi-environment selection dry-run uyarısı sürer; deployment yoktur. Yeni dependency/schema/migration/trigger/shared DTO/auth/backend/prod/Cloudflare/Paid/gerçek veri/belge aktivasyonu yoktur.
- Tek hedefli salt-okunur bağımsız client relationship/state review PASS:0 BLOCKER/0 IMPORTANT/0 OPTIONAL. Reviewer yeni UI dosyasını bağımsız21/21 PASS doğruladı; CAS ayrımı, exact retry, explicit comparison, selected customer authorization, archived read-only, GET-only readback, stale401 ve limited disclosure incelemesi geçti. Bu tekrar benzersiz test sayısına eklenmez; backend audit veya ek ajan zinciri yoktur. İnceleme sonrası runtime değişikliği yapılmadı.

## Kalan kapsam ve demo

Policy assignment, zeyil/amendment mutasyonları, external-reference mutations, archive, sensitive identity-variant secure confirmation ve mevcut document/private R2 kapıları `/policies/legacy` içinde korunur. Belge aktivasyonu/viewer yoktur. Legacy party yolu da silinmedi.

`npm run demo`; PowerShell maskeli giriş takılırsa yalnız sentetik demo için `npm run demo -- --visible-input` (parola terminalde görünür). https://localhost:8443 → Poliçeler → poliçe → Sigortalılar ve lehtarlar → Taraf ekle. Arama ve rolü açıkça seçin; pasifleştirmeyi ayrıca onaylayın. Ayrıntılar `LOCAL_DEMO_TR.md`. Yerel gate production release veya belge kabulü değildir.
