# FRONTEND PHASE2A — müşteri listesi ve tam sayfa profil

Bu dosya yerel uygulama/kabul kaydıdır, yeni bir mimari plan değildir. Mimari kaynak nihai plan12/18 bölümleridir. Başlangıç: `56fb3adc7973d4733c520759e4fc82e8ba35a6f5`. Önceden kirli UYGULAMA_DURUMU.md kullanıcı talimatıyla byte düzeyinde korunur ve commit edilmez.

## Modern müşteri deneyimi

- `/customers`: tam genişlikte okunabilir tablo; müşteri adı, bireysel/kurumsal tür, mevcut email/telefon ve aktif/arşiv durumu. Mobilde aynı satırlar tek kolon okunabilir müşteri kartlarına dönüşür; oversized desktop tablo dayatılmaz.
- Arama ve tür seçimi submit edildiğinde mevcut API'ye gider. Her istek `limit=20`, stable server cursor ile sınırlıdır; önceki/sonraki sayfa vardır. Client-side bütün portföy indirme/filtreleme yoktur. Cursor geçmişi yalnız bellekte tutulur. Arama metni URL veya browser storage'a yazılmaz. Listeye yeniden giriş filtreyi sıfırlar; refresh/back-forward profil route'larında çalışır, liste filtre persistence'ı bu fazda eklenmez.
- Loading/empty/generic network error/permission-denied durumları ve exact failed-cursor retry. Ham server hata metni gösterilmez. Retry/filtre değişiminde önceki sayfanın satırları yeni sonuçmuş gibi bırakılmaz.
- `/customers/:customerId`: büyük müşteri adı/status/temel iletişim header'ı; listeye dönüş; Genel bilgiler, İletişim, Müşteri notları, Poliçeler ve yenilemeler bölümleri. Bölüm seçimi `?section=` ile route history'ye dahildir. Normal summary'de identityMasked, kimlik değeri, sağlık/özel izin alanı veya actor-ID yoktur. React yalnız açıkça seçilmiş DTO alanlarını text olarak render eder; müşteri JSON'unun tamamı basılmaz.
- Notlar mevcut CustomerNotesSection'ın page sunumudur: doğrudan yüklenir, tek form/okunabilir timeline, server authorName snapshot'ı ve Europe/Istanbul tarih-saat. Aynı secure API, CSRF, exact body/key retry, author snapshot ve immutable not sözleşmesi kullanılır. Notları düzenleme/silme eklenmez. Profili veya bölümü terk etmek not formunu kapatır; taslağı göndermeden bölümü değiştirmeyin. Browser storage'a taslak yazılmaz.
- Mevcut poliçe ve yenilemeler yalnız yetkili scoped API'lerden bounded özet olarak okunur. Poliçe/yenileme iş akışlarının görsel modernizasyonu yapılmadı; teklif/görüşme/sonuç işlemleri ileri klasik alanda kalır. Private görevler profile aktarılmaz.
- URL-tagged read state eski veriyi navigation render'ında hemen saklar; AbortController + live guard geç başarılı/hatalı isteklerin yeni profile yazmasını engeller. Müşteri-keyed not mount'u eski müşteri taslağı/yanıtı için ayrı sınırdır.401 geldiğinde mevcut session-ended olayı ve CSRF invalidation shell/protected içeriği kaldırır.403/404 güvenli görünürlük reddidir; yetki oluşturmaz.

## Geçici klasik işlemler — kaldırılmadı

| URL / bağlantı                                              | Kapsam                                                                                                                                                                       |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/customers/new` — Yeni Müşteri                             | Mevcut güvenli müşteri oluşturma formu                                                                                                                                       |
| `/customers/:customerId/advanced` — İleri müşteri işlemleri | Mevcut müşteri detayı; iletişim edit, şirket contacts, atama, arşiv, yetkili kimlik reveal/update, dış referanslar, yenileme/teklif çalışma alanı ve müşteri→poliçe hand-off |
| `/customers/legacy`                                         | Eski müşteri listesi; hassas TCKN/VKN araması ve tüm mevcut araçlar                                                                                                          |

Bu sayfalarda “Geçici klasik müşteri çalışma alanı” açıklaması ve modern liste/profile dönüş bağlantısı vardır. Legacy detail dialog'u eski güvenli iş akışı olarak kalır; dönüş bağlantısına gitmeden önce dialog'daki çarpıyla kapatın. Yeni bir nested modal akışı yaratılmaz; ana liste/profile modal kullanmaz. Legacy entry prop'ları yalnız var olan server detail çağrısını/form state'ini açar; authority/DTO/mutation mantığı kopyalanmaz. Poliçe hand-off'u gerçek browser testinde korunur. Diğer modüller modernize edilmedi. Yeni dependency/TanStack Table yoktur.

## Odaklı doğrulama

-7 UI dosyası74/74 PASS: yeni customer-pages10, app-shell7, mevcut notes4/contact-edit ve üç App müşteri workflow suite'i. Server-side filtre/cursor/exact retry, boş/izin/hata durumu, sentetik hassas alanların hiç render edilmemesi, A→B anında eski verinin gizlenmesi ve ters sırada geç yanıt, full-page note author/time/idempotency/CSRF protokolü doğrulandı.

- Gerçek yerel D1/API: customer-notes14/14 PASS; mevcut customers.integration yalnız AGENCY ortak erişim + cross-agency non-disclosure2PASS/39filtre skip. Toplam90PASS; filtre skip'ler başarı sayılmaz. Notes API paketi server author snapshot/immutable ilişki, yetki/tenant, exact retry/audit ve session-revocation kontrollerini kapsar. Backend test fixture'ları veya güvenlik beklentileri gevşetilmedi.
- Gerçek installed Edge + disposable D1 + canonical login ile `npm run test:ui-smoke`/aynı browser runner PASS: OWNER/Ahmet/Ayşe;1440/768/360px müşteri listesi/profil/not overflow kontrolü; direct URL refresh ve profil↔liste back/forward; author atıflı not ekleme; OWNER gerçek create→modern profile→legacy iletişim PATCH→archive200→modern archived state readback; üç hesap için policy hand-off; employee görev mahremiyeti ve personel/team403; logout ve profile açıkken gerçek D1 session revoke sonrası not401→login; CSP/runtime error0.
- İlk browser koşusunda yeni yazılan ikinci Ahmet notu locator'ı çoğalttı; author query'si tarihsel birden fazla notu destekleyecek biçimde daraltıldı. Archive200 ve readback başarılıyken eski dialog arkasındaki dönüş link'ine tıklama testi durdu; önce mevcut dialog'u kapatarak düzeltildi. İş mantığı değiştirilmedi, tarihsel FAIL'ler PASS diye sayılmadı.
- Bir birleşik komut180s limitinde typecheck aşamasında durdu; tamamlandı sayılmadı. Ayrı typecheck ve build tekrar PASS. Source-boundary verifier CSS import'unu desteklemediğinden CSS index.html'deki mevcut stylesheet modeline alındı; verifier/CSP gevşetilmedi. Son lint/typecheck/format/build(client + Worker yalnız dry-run)/boundary PASS. `git diff --check` kapanışta çalıştırılır.
- Son bundle: index234.84kB/gzip73.76 + ortak card83.45kB/gzip28.44; müşteri liste5.21kB, profil8.67kB, resource1.09kB ve notes5.37kB ayrı chunk'lar; legacy App248.09kB gerektiğinde yüklenir. CSS26.78kB/gzip5.90. Paket/lockfile değişmedi. Gerçek ağ/portföy performans kabulü veya tam WCAG denetimi iddia edilmez.

## Yerel demo önizleme

PowerShell:

```powershell
Set-Location C:\Users\sinan\Desktop\panel
npm run demo
```

Maskeli giriş terminalinizde takılırsa Ctrl+C ardından:

```powershell
npm run demo -- --visible-input
```

Visible modda yalnız sentetik demo parolaları kullanın: terminalde görünürler. Parolayı argümana/env/dosyaya koymayın. Bağımlılıklar yoksa önce `npm ci`; Node24/OpenSSL gerekir. Hazır mesajından sonra https://localhost:8443/customers açın; yalnız bu localhost için self-signed sertifikayı onaylayın. OWNER/Ahmet/Ayşe hesapları ve izolasyon/kapatma yönergeleri LOCAL_DEMO_TR.md içindedir. Çalışanla Deniz Yılmaz profilini açın, Notlar ve İletişim bölümlerini deneyin; ileri işlemleri ayrı klasik alandan kullanın. Ctrl+C ile geçici demo kapanır.

## Kalanlar ve sınırlar

Bu faz için bilinen uygulama blocker'ı yoktur. Müşteri create/edit/contacts/assignment/archive/identity ve uzun yenileme/poliçe iş akışları görsel olarak legacy kalır; sonraki ayrı faz bunlardan birini modern sayfaya taşıyabilir. Liste filtre/draft persistence ve gelişmiş table framework bu dilimde yoktur. Önceki Wrangler/Miniflare dev-chain audit borcu ve environment-selection dry-run uyarısı bu frontend işiyle kapatılmış sayılmaz.

Backend iş kuralı/auth/permission/DTO, migration/production deploy/Cloudflare kaynak/Paid/gerçek veri/belge aktivasyonu değişmedi. Belge kapalı/NO-GO ve production release sınırları korunur. Önceden kirli durum belgesinin SHA256'sı `f272a14efce57f2ef47d960c2ac387e11cdaeda96aa6fda71db8585844e28930`; aynı içerik commit dışında kalır.
