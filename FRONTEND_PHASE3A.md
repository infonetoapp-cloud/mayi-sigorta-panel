# FRONTEND PHASE3A — poliçe listesi ve tam sayfa detay

Başlangıç `b2d40b5417817996f2edd8f13804af5706ae406b`. Uygulama/kanıt kaydıdır; mimari otorite nihai plan12/18 bölümleridir. Kullanıcının önceden kirli `UYGULAMA_DURUMU.md` dosyası değiştirilmez ve commit edilmez.

## Doğrulanan query uyuşmazlığı

CustomerProfilePage mevcut `/api/policies?customerId=...&limit=20` isteği gerçek yerel D1 ve canonical login altında400 döndü; beklenen200 assertion'ı RED oldu. Frontend yalnız `pageSize=20` olarak düzeltildi. API strict schema aynıdır; regresyon yanlış limit'i400 ve doğru customerId/pageSize isteğini200 ile doğrular. UI testi gerçek request URL'inde pageSize=20/limit yokluğunu ve yeni policy detail bağlantısını doğrular. İlk fixture hazırlığındaki yanlış login/helper/grant/required installmentCount/session-table varsayımları düzeltildi; bunlar backend kusuru olarak sayılmadı.

## Modern okuma ekranları

- `/policies`: server-paged20 kayıt; varsayılan end_date_asc; tam/prefix normalize poliçe-numarası araması, mevcut status/endFrom/endTo/sort filtreleri. Filtre/cursor URL'dedir; filtre değişimi cursor'ı bırakır, retry aynı URL/cursor'ı kullanır. Tüm portföy istemciye indirilmez. Desteklenmeyen archive filtresi veya yeni backend sorgusu eklenmez.
- Poliçe numarası, gerçek başlangıç/bitiş dönemi, bitiş tarihi, integer-minor brüt prim/para birimi, sözleşme durumu ve ayrı arşiv durumu. Liste DTO'sunda bulunmayan müşteri/sigortacı isimleri uydurulmaz veya ek GET ile bütün satırlar için çekilmez.1440px tablo;1000px ve altında etiketli okunabilir kart satırları.
- Para gösterimi safe integer → BigInt whole/fraction ile çalışır; floating-point major-unit bölmesi yoktur. MAX_SAFE_INTEGER sınırı ve negatif50 minor zeyil ayrı UI kanıtıdır.
- `/policies/:policyId`: authorized joined detail DTO'dan customer/insurer/product/branch/payment method/dates/premium/currency/installments/status; modern customer link'i, pasif katalog ve archived tarih/reason geçmişi. Kimlik, sağlık içeriği, personel/assignee iç alanları render edilmez.
- Sigortalılar/lehtarlar, zeyiller ve dış referanslar URL bölümlerinde salt okunurdur; yalnız seçilen bölümün mevcut endpoint'i yüklenir. Party özeti bütün bağlı Customer kaydına erişim gibi değerlendirilmez. Arşiv, iptal ve geçersiz durumları birbirinden ayrıdır.
- Mevcut generic URL/revision-tagged reader tekrar kullanılır; AbortController/live guard ve policy-ID keyed mount eski detail/related yanıtını veya eski401'i yeni policy ekranına taşımaz.401 ortak session cleanup;403/404 canonical non-disclosure; ağ/empty/error/retry halleri vardır. Sidebar policy alt yollarında aktif kalır.

## Korunan mutasyonlar ve müşteri handoff'u

`/policies/legacy` açık etiketli mevcut PolicyPanel'dir. Oluşturma, düzenleme, atama, parties, amendments, references, archive ve secure confirmation protokolleri değiştirilmedi. Modern detail normal işi nested legacy modal'da açmaz; mutasyon isteyen kullanıcı klasik çalışma alanına açıkça geçer. Mevcut R2 belge özelliği açılmaz ve yeni viewer yoktur.

Müşteri advanced ekranındaki +Poliçe Ekle, optional routing callback üzerinden `/policies/legacy?customerId=...` yoluna geçer. İsim/korunan body URL veya browser storage'a yazılmaz; originating customer yetkili GET ile yeniden okunmadan form mount edilmez. Denied/archived origin yeni oluşturma formunu açmaz. Standalone App eski lokal handoff'unu korur. UI RED testinde origin ilk customer options sayfası dışında iken farklı müşteri seçiliyordu; PolicyPanel'ın zaten render ettiği origin option'ı default load'da geçerli ID sayılarak seçim korunur. Diğer mutation request/confirmation mantığı yeniden yazılmadı.

## Gerçek doğrulama

- Son odaklı5 dosya61/61 PASS: yeni policy UI16, gerçek D1/API6 ve mevcut policy mutation/customer-profile/AppShell komşu UI regresyonları. Tekrar koşular benzersiz test sayısına eklenmez.
- D1/API: wrong query400/canonical200; server keyset/order/exact-prefix/status/date; canonical policy creation; gerçek insured party/zeyil/reference readback; OWNER/Ahmet/Ayşe shared authorized detail ve related reads; archived ACTIVE policy geçmişi; foreign404, ungranted403, revoked401/no data. Sentetik HEALTH policy ordinary listede görünmez ve dört detail endpoint'i explicit sensitive izin olmadan OWNER dahil üç aktöre403 döner.
- UI: cursor retry, filtre reset, exact maximum money/negative sub-unit, authorized historical detail, on-demand related reads, rapid detail/related switch ve eski401 suppression, denied cleanup, originating customer first-page dışında kalınca seçim korunumu, denied handoff'ta form mount yokluğu, customer-profile pageSize/link ve sidebar active regresyonları.
- Kurulu gerçek Edge + disposable demo/canonical login PASS: OWNER/Ahmet/Ayşe için müşteri profilinden DEMO-0 modern detayı, +Poliçe Ekle handoff'u, seçili origin demo-customer-0, gerçek policy POST201 ve server customerId readback; modern exact search/list/detail/direct refresh ve related tabs;1440/768/360 overflow ve gerçek computed table/card display; back/forward/customer navigation; mevcut customer/company-contact/note/private-task/owner-denial akışları ve policy üzerinde canlı session revoke→protected heading cleanup. Edge turu sonrasında sidebar highlight düzeltmesi odaklı UI gate'de doğrulandı; fetch/mutation mantığı değişmedi.
- Typecheck/lint/format/client+Worker dry-run/boundaries PASS. İlk lint, browser callback'inde çıplak getComputedStyle ismini no-undef saydı; aynı browser global'i globalThis ile açık yazılarak düzeltildi. Mevcut Wrangler multi-environment selection uyarısı yalnız dry-run'da sürer. Production deploy yoktur.
- Backend/shared DTO/auth/migration/trigger/dependency değişikliği yoktur; yeni servis/ücretli kaynak/gerçek veri/belge aktivasyonu yoktur. Ek ajan veya bağımsız audit zinciri başlatılmadı. Korunan dosya hash'i başlangıç değeriyle doğrulanır: `f272a14efce57f2ef47d960c2ac387e11cdaeda96aa6fda71db8585844e28930`.

## Yerel demo ve kalan kapsam

`npm run demo`; maskeli PowerShell girişi takılırsa yalnız sentetik parolalar için `npm run demo -- --visible-input` (terminalde görünür). https://localhost:8443 → Poliçeler → poliçe numarası. Oluşturma ve ileri işlemler “Poliçe işlemleri (klasik)” bağlantısındadır; müşteri advanced ekranında +Poliçe Ekle origin'i otomatik seçer. Detaylar `LOCAL_DEMO_TR.md`. Bu read/UI fazı için açık blocker yoktur; mutation modernizasyonu, belge viewer/activation ve production kabulü yapılmış sayılmaz.
