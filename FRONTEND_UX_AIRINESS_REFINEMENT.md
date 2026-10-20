# Frontend UX ferahlık iyileştirmesi — yerel kabul

Karar: LOCAL GO — yalnız bu odaklı frontend kapsamı. Production-ready veya tüm CRM sadeleşti kararı değildir.
Temel HEAD: `7d8f4bfe961353506b514237248c2b7f6995feca`; commit/push yapılmadı.

## Değişiklik

- Marka laciverti ve yerel Segoe font ailesi korundu. Sidebar'da dolu aktif blok yerine ince sınır/hafif yüzey, kutusuz marka işareti, daha hafif yazı ağırlıkları ve daha düzenli boşluklar kullanıldı. Focus ve mevcut menü davranışları korunuyor.
- Sağ çalışma alanı: Özet, İletişim, Görev işlemleri, Teklifler, Yenileme sonucu. Özet sürekli görünür; İletişim başlangıçta açık, diğer üç işlem grubu kapalı. Ana iletişim eylemi belirginleştirildi; müşteri/poliçe bağlantıları korundu.
- İkincil yardım metinleri ve klasik iş akışına ilişkin ayrıntılar isteğe bağlı açılır. Gerçek işlem uyarıları, son onaylar ve recovery kontrolleri kaldırılmadı.
- Bölüm kapanırken çocuk bileşenler DOM'da kalır. Taslak veya belirsiz/doğrulanmamış işlem bulunan bölüm açık sabitlenir; işlem açıkça kapatılmadan veya doğrulanmadan gizlenemez. Temiz geçmişi kapatıp açmak aynı DOM'u korur ve yeni okuma başlatmaz.
- Yalnız altı frontend dosyası değişti; mevcut test assertion'ları kaldırılmadı. Eski akış testlerine gerekli bölüm-açma eylemleri eklendi.

## Önce / sonra

Aynı sentetik fixture, görünür Edge, 1000px viewport yüksekliği; üç kullanıcıda aynı boyut başına aynı sonuç. Ölçüm seçili görev panelinin başlangıç yüksekliğidir; insan işlem süresi değildir.

| Genişlik |   Önce |  Sonra | Yükseklik azalması |
| -------- | -----: | -----: | -----------------: |
| 1440px   | 2093px | 1238px |              %40.9 |
| 768px    | 2093px | 1238px |              %40.9 |
| 360px    | 2855px | 1324px |              %53.6 |

Başlangıçta görünen buton/bağlantı 13→10. Son durumda ayrıca üç yerel yardım/ayrıntı açacağı var; bu sayım toplam etkileşimli öğelerin aynı oranda azaldığı anlamına gelmez. İkincil işlemlerin bölümünü ayrıca açmak gerekir; bütün akışlarda daha az klik veya daha hızlı iş tamamlama iddiası yoktur. Kazanç, daha kısa ilk görünüm ve daha net gruplanmadır.

## Doğrulama

- React 598 + stil 2 = 600 PASS / 0 FAIL / 0 skip; 45 dosya. `node_modules/.cache/airy-react-first.json`.
- Gerçek görünür Microsoft Edge 155.0.4283.45: OWNER/Ahmet/Ayşe × 1440/768/360px, 9/9 hücre; 33 PNG; 0 runtime/CSP hatası. Mobil dokunma, klavye açma, sidebar/Escape taslak koruması, geçmiş DOM kimliği/no-refetch, WON oluşturma taslağının korunması ve çapraz işlem kilidi kontrol edildi.
- Üç belirsiz LOST sonucunda gerçek yerel D1 yazımı sonrası aynı body/anahtarla exact retry; üç kabul edilmiş POST sonucunda yalnız GET recovery doğrulandı. Kurtarılan görevlerin gerçek D1 durumu COMPLETED okundu. Bu, tüm atomik audit/link etkilerinin yeni bağımsız kanıtı değildir.
- Typecheck, değişen JS/TS'de ESLint, değişen dosyalarda Prettier, izole client build, boundaries ve diff-check PASS. Worker deployment/dry-run veya geniş tarihsel backend/clock suite'i çalıştırılmadı; bağımsız reviewer yok.
- AST karşılaştırmasıyla mevcut read/canOperate/compare/onApplied/key özellikleri korundu; yalnız sunum için iki risk görünürlük bayrağı eklendi. Backend/shared/API/auth/DB/migration/dependency değişmedi. Protected belge SHA256: `f272a14efce57f2ef47d960c2ac387e11cdaeda96aa6fda71db8585844e28930`; stage boş.

## Ara başarısızlıklar ve kanıt sınırı

- Yeni regresyonlar önce RED, sonra GREEN oldu. Yeni testte async hazır olma beklemesi ve form-açma yerine gerçek yazım engelini sınayan doğru beklenti kullanıldı. Eski güvenlik assertion'ları gevşetilmedi.
- İlk lint: eksik Buffer importu giderildi; CSS ESLint kapsamı değildir.
- İlk Edge sürücüsü, bilerek aria-disabled olan sabit bölüm başlığına click bekledi (`airy-review-QxxchF`). Klavyeyle aktivasyonun bölümü kapatmadığı sınandı. Sonraki sürücü hatası DTO'da `id` yerine gerçek `taskId` alanını kullanmamasıydı (`airy-review-d9mpmY`); backend değiştirilmedi. Odaklı OWNER/768 tekrar koşusu PASS.
- Nihai 9/9 matrix kaydı `airy-review-TN4eF1/result.json` geçerlidir; aynı komut daha sonraki önizleme kontrolünde yanlış `.sidebar` seçicisi nedeniyle exit1 verdi. Bu exit0 diye sunulmaz. Gerçek `#app-sidebar` ile ayrı `--preview-only --keep-open` başlangıcı OWNER oturumu, native görünür pencere, dört bölüm ve sunulan CSS'nin yeni build ile SHA eşitliğini doğruladı. Önizleme-only koşusu 9 hücre toplamına katılmadı. Bu test-sürücüsü düzeltmeleri sırasında frontend kaynak hash'leri değişmedi.
- Eski faza özel tarayıcı walkthrough'ları bölüm açma adımlarıyla uyarlandı, bütünüyle yeniden koşturulmadı. Bunlar yeni 9 hücreye ek kabul sayılmadı.

## Kalan UX borçları

WON ve bazı hata/recovery ekranlarında teknik kimlik/sürüm dili ile uzun finansal formlar duruyor. İleri müşteri işlemleri yeniden yazılmadı. CREATE_POLICY için optional kabul edilmiş teklif ilişkisi hâlâ kapsam dışında. Kademeli gösterimin iş başına toplam klik/süre etkisi gerçek çalışan incelemesiyle henüz ölçülmedi.

## İnceleme ve dosyalar

Yeni görünüm: https://localhost:9443/today-work — görünür Edge, gerçek otomatik OWNER girişi, yalnız sentetik veri. Şifreler bellekte üretildi ve yazdırılmadı. Bu demo penceresini kapatmak geçici sunucu/DB'yi kapatır. Önceki 8443 demosu ve onun build'i korunmuştur; yeni aday 9443'tedir.

Önce: `node_modules/.cache/airy-review-ZMQN8d/owner-360-before.png`.
Sonra: `node_modules/.cache/airy-review-TN4eF1/owner-360-after.png` ve `owner-1440-after.png`.
Matrix sonucu: `node_modules/.cache/airy-review-TN4eF1/result.json`.
Görünür önizleme: `node_modules/.cache/airy-review-afnoB7/preview.json`.
Cache kanıtları cache temizlenirse silinir. Orijinal audit ve protected dirty belge değiştirilmedi. Production, Cloudflare, ücretli servis, gerçek müşteri, dış mesaj, belge/R2 veya yeni faz yok.

## Dar Git uzlaştırması — 20 Ekim 2026

Kullanıcının ayrı yetkisiyle mevcut airy seti bağımsız commit için doğrulandı. Başlangıç HEAD ve read-only fetch sonrası remote main `7d8f4bfe961353506b514237248c2b7f6995feca`. Son airy manifestindeki23 dosyanın tüm başlangıç hashleri eşleşti; audit manifestindeki194 kaynak da eşleşti. Önceki accepted manifestinden yalnız Edge sürücüsünün daha sonra düzeltilmiş preview bölümü farklıydı; eski9/9 yerine yeni koşu yapıldı. Göreli import kontrolünde allowlist dışında untracked bağımlılık bulunmadı.

- Yeni React/stil koşusu:600 PASS,0 FAIL,0 skip; `node_modules/.cache/reconcile-phase0-ui.json`.
- Gerçek yerel D1/API:5 dosya,96 PASS,0 FAIL,0 skip; `reconcile-phase0-api-retry.json`. İlk foreground komut420s araç zaman aşımında kesildi; başarı sayılmadı. PTY ile izole tekrar1467.99s/exit0 tamamlandı; test/sunucu değiştirilmedi.
- Yeni görünür Edge155.0.4283.45: OWNER/Ahmet/Ayşe ×1440/768/360,9/9;33 PNG; `airy-review-YVowEN/result.json`. Ayrı10443 loopback ve yeni `reconcile-phase0-client` build'i kullanıldı;8443/9443 süreçleri kapatılmadı. Geçici sürücü yalnız port/build yolunu uyarladı. İlk background başlatmada süreç envanteri yardımcı kodu TypeError verdi; sonraki non-PTY başlatma `stdin is not a tty` ile çalışmadı. Bunlar kabul hücresi sayılmadı; PTY koşusu exit0 tamamlandı.
- Typecheck,23 dosyada format, ilgili JS/TS'de lint, yeni client build, Worker yalnız dry-run, security boundaries ve diff-check PASS. İzole build ile `dist/client` hash eşitliği doğrulandı. Wrangler çoklu environment uyarısı korundu; canlı işlem yok.
- Başlangıçtaki124 dirty/untracked dosyanın byte hashleri testlerden sonra124/124 eşleşti. Bu ek dışında mevcut içerik değiştirilmedi. Korunan belge SHA256 `f272a14efce57f2ef47d960c2ac387e11cdaeda96aa6fda71db8585844e28930`; bağımsız audit SHA256 `c9c787dcf31131cc79bc844c54ac4e96de6a01237a2319a67dd72a03828810c0`.
- Stage yalnız bu rapor,6 airy kaynak dosyası ve16 doğrudan ilgili test/yardımcı dosyadır. Independent audit, `audit-evidence/`, `MODERN_CRM_UX_AUDIT.md`, protected belge ve cache çıktıları commit dışıdır. UX-004/UX-001/A11Y-001 bu commit'te düzeltilmiş değildir.

Karar: PHASE0 LOCAL GO; üretim kabulü değil. Tam committed dosya listesi Git commit ağacından okunmalıdır.
