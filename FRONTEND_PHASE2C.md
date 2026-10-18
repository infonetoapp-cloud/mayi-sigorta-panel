# FRONTEND PHASE2C — modern şirket yetkilileri

Başlangıç `b7beede628a0643de3f022f5fe71af553153a72c`. Bu dosya uygulama/kanıt kaydıdır; mimari otorite nihai planın12/18 bölümleridir. Önceden kirli `UYGULAMA_DURUMU.md` kullanıcı talimatıyla byte düzeyinde korunur ve commit dışında kalır.

## Modern işlemler

- `/customers/:customerId?section=contact` içinde yalnız COMPANY için `CompanyContactsSection`. Okunabilir ad/soyad, görev/unvan, e-posta/telefon, aktif/pasif ve birincil durumu; API'nin döndürdüğü pasif geçmiş silinmez/gizlenmez.
- Inline ekleme/düzenleme, birincil seçimi ve açık inline pasifleştirme onayı; erişilebilir etiketler, hata alanı bağlantıları ve form başlığına focus. shadcn Button/Input ve mevcut responsive profil stilleri; yeni dependency yok. Bunlar şirket müşteri yetkilileridir, çalışan hesabı veya kişisel günlük görev ataması değildir.
- INDIVIDUAL'da yetkili yönetimi render edilmez. Arşivli COMPANY geçmişi görünür, yeni işlemler kapalıdır. Backend'deki atomik lifecycle, primary uniqueness/reset rollback ve izin kuralları değiştirilmedi.
- Dört endpoint mevcut protokolle kullanılır: POST contacts; PATCH contacts/:id; POST contacts/:id/set-primary; POST contacts/:id/deactivate. Mutable payload yalnız ilgili contact alanlarını ve gerekli child expectedVersion'ı taşır; actor/agency/assignee/personel/kimlik/sağlık alanı yoktur.
- Tek küçük bileşen-içi request yolu dört işlem için immutable URL/method/serialized-body/key snapshot'ını kullanır. Legacy'nin ayrı mutation state'leri kopyalanmadı veya yeniden çerçevelenmedi; mevcut CSRF, güvenli hata mapper'ı ve authorized detail reader tekrar kullanılır.

## Retry, conflict ve veri izolasyonu

- Belirsiz ağ/5xx/429 veya bozuk yanıt: form ve diğer mutasyonlar kilitlenir; yalnız aynı body/key/path/method ile açık retry. Aynı anda ikinci submit ref ile engellenir. Alanlar ve pending body/key yalnız component belleğindedir; localStorage/sessionStorage/IndexedDB veya credential persistence yoktur.
- Retry yalnız mevcut mount ömründedir. Belirsiz işlemde sayfayı yenilemek/yeni form açmak yerine “Aynı işlemi yeniden dene” kullanılır; browser reload sonrası durable key/draft kurtarma eklenmedi.
- Başarıdan sonra yetkili tam customer detail GET yapılır; history/list/header yeni DTO ile güncellenir. Write başarılı, readback başarısızsa ikinci write gönderilmez; yalnız okuma tekrar edilir. Başarı mesajı ancak authorized readback sonrasında görünür.
  -409'da draft korunur; yeni write, explicit refresh ve karşılaştırma tamamlanana kadar kapalıdır. Edit yalnız orijinal taslağa göre gerçekten değiştirilen alanları gönderir. Karşılaştırma contact snapshot/version'ına sabitlenir; başka bir parent refresh CAS sürümünü sessizce ilerletmez. Yeniden değişiklik varsa tekrar409 beklenir.
- Geç mutation/read/CSRF yanıtları generation ve keyed mount ile başka müşteri profiline uygulanmaz.401 ortak session-ended akışına gider;403/404'te stale yetkili listesi gizlenir ve işlemler kilitlenir. Ham sunucu hata metni gösterilmez; mevcut non-disclosure modeli sunucudadır.
- Önceden gönderilmiş, sonucu belirsiz immutable attempt sırasında parent arşivlenirse yalnız aynı pending request reconcile edilebilir. Server completed receipt replay'i canlı yetki altında döndürebilir; tamamlanmamış yeni write mevcut atomic archived-parent guard'a takılır. Bu, arşivli kayıt için yeni işlem açmaz.

## Doğrulama

- Yeni UI16/16 PASS. Validation/no POST, COMPANY/INDIVIDUAL/archived history, primary/deactivate explicit confirmation, exact retry,409 draft+comparison+field-only PATCH, unrelated parent refresh karşısında pinned CAS, success-readback failure'da no repeat write, late mutation/detail/CSRF profile response suppression, permission/session denial ve archived-during-pending exact retry.
- Son odaklı UI kapısı6 dosya55/55 PASS. Modern create/contact-edit/list/profile/notes/AppShell korunur; tekrar koşular benzersiz test sayısına eklenmez. Dört yeni gerçek API testiyle toplam59 benzersiz odaklı test PASS.
- Yeni gerçek localD1/API4/4 PASS: OWNER kaydına Ahmet/Ayşe shared erişimle create/edit/set-primary/deactivate; completed deactivation exact replay/evidence değişmezliği; competing same-version PATCH200+409; stale target primary reset rollback;403 izinsiz/404 foreign/401 revoked session; archived dört yeni işlemin409'u ve parent/child/receipt/SUCCESS audit snapshot değişmezliği, pasif geçmiş authorized GET200.
- Birleşik Edge doğrulaması ilk kısa runner bütçelerinde timeout oldu; başarı sayılmadı. Client build ayrı doğrulandı, güvenli sabit aşama etiketleri ve15s locator timeout'u ile test bütçesi450s'ye çıkarıldı; ardından gerçek kurulu Edge walkthrough PASS. Assertion gevşetilmedi; gerçek API/auth yerine mock/bypass kullanılmadı. OWNER/Ahmet/Ayşe,1440/768/360; şirket yetkilisi create/edit/primary/deactivate, pasif history, gerçek commit sonrası503+exact retry ve gerçek stale edit→refresh→field-only compare; modern customer create/contact edit/list/profile/notes/history/policy handoff, private tasks/personnel denial/logout/revocation ve CSP/runtime.
- Typecheck, lint, format, client+Worker dry-run build ve güvenlik boundaries PASS. Mevcut Wrangler environment-selection uyarısı yalnız dry-run'da sürer; remote deployment yapılmaz.
- Tek dar bağımsız client mutation/state incelemesi PASS:0 BLOCKER/0 IMPORTANT/1 OPTIONAL. Reviewer o anki14 UI testini bağımsız çalıştırdı:14/14 PASS. Optional geç detail-readback ve geç CSRF navigation testleri kapanışta eklendi ve geçti. İnceleme snapshot'ından sonra comparison CAS sürümünün unrelated parent refresh ile sessizce ilerlemesi ayrıca RED testinde gösterildi (beklenen3/gelen9); comparison snapshot/version sabitlenerek düzeltildi, final16 UI ve son kaynakla Edge tekrar PASS. İkinci inceleme zinciri veya backend yeniden audit'i yoktur.

## Legacy ve sınırlar

Atama, arşivleme, hassas kimlik, dış referans ve poliçe handoff hâlâ advanced/klasik çalışma alanındadır. Legacy şirket yetkilisi yolu kaldırılmadı. Eski profil metnindeki “şirket yetkilileri sonraki dilim” uyarısı modern operasyonlar doğrulandığı için kaldırıldı; genel klasik ileri işlem bağlantıları durur.

Backend business model, auth, shared DTO, migration/trigger, demo credential protokolü, production/Cloudflare, Paid hizmet veya belge aktivasyonu değiştirilmedi. Yeni gerçek müşteri verisi yoktur. Son kaynakla build/dry-run/boundaries ve gerçek Edge turu PASS; uygulama kabulünü engelleyen açık blocker yoktur. Korunan durum belgesinin SHA-256 değeri başlangıçla aynıdır: `f272a14efce57f2ef47d960c2ac387e11cdaeda96aa6fda71db8585844e28930`.

## Yerel demo

`npm run demo`; PowerShell maskeli giriş takılırsa yalnız sentetik demo için `npm run demo -- --visible-input` (terminalde görünür parola uyarısı). Parolaları yalnız yerel interaktif prompt'a girin; https://localhost:8443. Müşteriler → kurumsal müşteri aç/oluştur → İletişim → Şirket yetkilileri. Yeniden başlatma disposable verileri sıfırlar. Ayrıntılar `LOCAL_DEMO_TR.md`.
