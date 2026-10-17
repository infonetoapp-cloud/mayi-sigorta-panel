# Frontend modernizasyonu — PHASE1 yerel kabul

Bu belge uygulama kanıtıdır; mimari otorite nihai planın12/18 bölümleridir. Kullanıcının talimatıyla önceden kirli UYGULAMA_DURUMU.md byte düzeyinde aynen korunur, commit edilmez.

## Değişen görünüm

-248px desktop sidebar;72px ikon moduna daraltma;900px altı açılır mobil navigasyon. Mobil menü Escape ve bağlantı seçiminde kapanır; gizli menü focus almaz. Skip link, aria-current, anlamlı ikon etiketleri ve sayfa değişiminde ana içeriğe focus vardır. Mobil menü non-modal disclosure'dır; focus trap gerektiren dialog değildir.

- Sticky üst header: gerçek session email'i, acente sahibi/çalışan etiketi, şifre değişimi, yeniden doğrulama ve çıkış. Kullanıcının adını auth DTO'sunda olmadığı için uydurmaz.
- Sakin nötr yüzeyler, mavi vurgu, sistem fontu, merkezi renk/radius/sidebar token'ları. Harici font/CDN yok.
- Genel Bakış ilk tam modern sayfadır: günün işlerine/müşteri/poliçelere gerçek bağlantılar; OWNER için personel kısayolu. Sahte KPI veya teknik iç etiket yok; overview domain verisi istemez.
- Kaynak-sahipli shadcn/ui Radix/new-york Button/Card/Input temeli, components.json ve MIT atfı. Tailwind4.3.3 Vite8 uyumlu; global preflight legacy native form stillerini değiştirmemek için açılmadı. İleride primitive eklerken bu sınıra dikkat edin.

## Route ve uyumluluk sözleşmesi

React Router8.4.0 deklaratif browser-history kullanılır; mevcut React19.3/Node24 peer/engine şartlarıyla uyumludur.

| URL               | Ekran                              |
| ----------------- | ---------------------------------- |
| /                 | Genel Bakış                        |
| /today-work       | Bugünkü İşler (legacy)             |
| /customers        | Müşteriler (legacy)                |
| /policies         | Poliçeler (legacy)                 |
| /catalogs         | Kataloglar (legacy)                |
| /agency-settings  | Acente Ayarları (legacy)           |
| /personnel        | OWNER Personel ve İzinler (legacy) |
| /account/password | Mevcut şifre değiştirme formu      |

CompatibilityPage mevcut App'ı kontrollü page/onNavigate prop'larıyla taşır; eski iş formları/mutation/CSRF/idempotency/CAS/hassas veri erişim kodu yeniden yazılmaz. Route değişiminde müşteri dialog'u/sensitive search kapanır, geç detail yanıtı dialog'u yeniden açamaz. Müşteriden poliçe oluşturma hand-off'u gerçek browser testinde korunur. Standalone App modu önceki odaklı testler için desteklenir; eski header/overview gerçek authenticated app'te gösterilmez.

Personel menüsü ayrı YÖNETİM grubudur; employee direct URL yönetim bileşenini/API'sini yüklemez. Bu client gate server authorization yerine geçmez. Acente ayarı okuma mevcut contract'ta aktif üyelere açıktır; bu yüzden Settings ekranını OWNER-only yapıp mevcut hakları kırmayız. Yazım yetkisi mevcut server permission kontrolündedir. Diğer modüller aynı API kaynak/kapsam izinlerini kullanır; salt menü görünürlüğü yazma/okuma hakkı vermez.

Auth state NORMAL olmadan shell mount edilmez; ACTIVATION yalnız mevcut forced-password formu/logout'tur. Logout/session-end shell ve reauth state'ini temizler. CSRF cache aynı memory-only davranışla ayrı küçük modüle çıkarıldı; App re-export'ları eski ekranlarla uyumludur. Cookie/token/PII için localStorage/sessionStorage veya URL state eklenmedi.

Worker'ın mevcut exact SPA fallback'i yeterlidir: HTML isteyen GET sayfa URL'si index'e döner, API/secure yolları aynı güvenlik kapılarında kalır. Backend/CSP/Worker config değişmedi. Lazy compatibility/personnel chunk'ları gerçek origin'den gelir. Loading/error/not-found/denied durumları vardır.

## Yerel önizleme

Windows PowerShell:

```powershell
Set-Location C:\Users\sinan\Desktop\panel
npm ci
npm run demo
```

Mevcut masked prompt Windows Terminal'de takılırsa önce Ctrl+C ve ardından:

```powershell
npm run demo -- --visible-input
```

Visible modda parolalar yerel terminalde görünür; yalnız sentetik demo için ayrı parolalar seçin, gerçek hesap parolası kullanmayın. Parolayı argümana/env/dosyaya koymayın. Maskeli mod default kalır.

Hazır mesajından sonra https://localhost:8443 açın; yalnız bu yerel adresin self-signed sertifika uyarısını onaylayın. OWNER/Ahmet/Ayşe email ve walkthrough LOCAL_DEMO_TR.md içindedir. Her başlangıç disposable D1 kullanır; development/production DB'ye dokunmaz. Ctrl+C ile kapatın.

## Doğrulanan sonuçlar

-12 odaklı dosya114/114 PASS: yeni app-shell7, auth/password-boundaries, önceki dört App workflow suite'i, TodayWork, müşteri notları, renewal workspace, task-statistics ve CLI input. Eski activation testi mock App yerine artık gerçek Genel Bakış heading'ini; password-boundaries testi gerçek route link'ini bekler. Güvenlik assertion'ları kaldırılmadı.

- Gerçek yerel D1/HTTPS demo + build/CSP2/2 PASS. Worker SPA regression2PASS/51filtre skip; skip başarı sayılmadı.
- Opt-in `npm run test:ui-smoke` gerçek installed Edge + sentetik D1 + canonical login ile OWNER/Ahmet/Ayşe için PASS:1440/768/360 layout,248/72sidebar, kapalı/açık mobil menü, yatay overflow yok (overview), refresh/history, müşteri→poliçe hand-off, çalışan görevleri5/self ve OWNER10/team görünümü, employee personnel/team API403, logout ve gerçek D1 session revoke sonrası login'e dönüş; runtime/CSP hatası0. Playwright raw error/credential logging kapalı, context/synthetic secrets/TLS/D1 cleanup var. Playwright yalnız dev dependency; Windows installed Edge kullanır. Başka platformda önce Playwright Chromium kurmak gerekebilir.
- Lint/typecheck/format-check/build(client + Worker yalnız dry-run)/client-server-secret boundary/diff-check PASS. İlk build'deki window runtime yasağı normal reload link'iyle düzeltildi; boundary kuralı gevşetilmedi.
- Bundle: eski tek chunk510.18kB iken yeni ilk JS316.09kB(gzip100.81); legacy252.93kB(gzip65.04) ve personel28.60kB(gzip6.91) lazy; adapter0.22kB; CSS20.23kB(gzip4.77). İlk yük küçüldü; bütün ekranlar ziyaret edildiğinde toplam JS büyümesi router/ui/icon maliyetidir. En büyük chunk500kB altında; gerçek ağ/cihaz latency hedefi ölçülmedi.
- Production dependency audit0. Yeni frontend bağımlılıklarında audit bulgusu yok. Tailwind'ın da kullandığı mevcut source-map-js1.2.1 advisory'si lockfile'da uyumlu1.2.2 patch ile kapatıldı. Kalan mevcut Wrangler/Miniflare/sharp/undici dev zinciri4bulgu(1moderate/3high) ayrı altyapı güncellemesi gerektirir; force-update yapılmadı. Bunlar temiz audit iddiasıyla gizlenmez. Wrangler dry-run environment-selection uyarısı sürer.

## Kalan kapsam ve sınırlar

Bugünkü İşler, müşteri detay/oluşturma, poliçe, katalog/ayar ve personel uzun formları hâlâ legacy görseldir; modal/expanding-card akışları bu fazda taşınmadı. Uyumluluk katmanı küçük ekranlarda kontrol minimumlarını gevşetir/tabloyu kendi içinde kaydırır; bütün legacy ayrıntılar için tam mobil yeniden tasarım veya WCAG sertifikası iddia edilmez. Sonraki faz ayrı yetkiyle bir iş ekranını sayfa tabanlı tasarıma taşımalıdır; otomatik uygulama yoktur.

TanStack Table/Query, yeni reporting framework, backend/auth rewrite, migration, production deployment/Cloudflare mutation/Paid/gerçek veri/document activation yoktur. Mevcut belge kapalı/NO-GO ve production release sınırları aynen korunur. Kullanıcının Windows terminalinde fiziksel parola girişi/sistem sertifika politikası otomatik yapılmış kabul edilmez.
