# Frontend UX kalite sprinti — LOCAL GO

Taban HEAD/origin main `40f2cde8245e502ff14745a295917ce64f465548`. Orijinal MODERN_CRM_UX_AUDIT.md değiştirilmez (SHA256 bd115ce7601657eda78220e4bf3bfcad3aa0cea77b14e78dbc8fc1504286c440). Protected belge SHA256 f272a14efce57f2ef47d960c2ac387e11cdaeda96aa6fda71db8585844e28930. Önceden dirty/untracked dosyalar korunur ve commit dışıdır.

## Stage A

Kök neden: sayfa guard'ı capture aşamasında link olayını durdurduğu için Sidebar onClick kapanışı çalışmıyordu. Layout'a açık navigation-attention bildirimi, native top-layer dialog, Escape ile kalma ve özgün taslak alanına odak dönüşü eklendi; z-index artırma çözümü yok. Unresolved yazımlarda geçiş izni verilmez, menü kapanır ve durum mesajına odaklanılır. Dirty browser POP restore sonrası aynı açık onay mekanizmasını kullanır; yalnız bilinçli onay history geçişini serbest bırakır.

RED: ux-stage-a-red.json 0PASS/1FAIL/0skip; drawer true kaldı. Gerçek Edge before üç aktör ×360: node_modules/.cache/ux-sprint-HQdooM/result.json, üç before PNG. Bunlar bilinen kusur yeniden üretimidir, doğru davranış PASS kabulü değildir.

GREEN checkpoint: ux-stage-a-ui.json 23PASS/0FAIL/0skip; terminal workspace, navigation ve shell komşuları dahil. İlk typecheck yalnız yeni testte Testing Library'nin desteklemediği exact option'ı buldu; test-only düzeltme sonrası typecheck/client build PASS. Gerçek Edge155.0.4283.45 OWNER/Ahmet/Ayşe ×360 üç hücre tamamlandı: node_modules/.cache/ux-sprint-NWXA9X/result.json. Drawer otomatik kapandı, kalmada taslak korundu, drawer Escape odağı menü düğmesine döndü, karar Escape kalmayı seçti, açık ayrılma çalıştı. Nihai kabul daha geniş browser/history/unresolved kapsamıyla Stage D'dedir.

## Stage B — ortak görsel temel

Yerel Segoe UI Variable/Segoe UI/system font stack; 15px temel metin, tutarlı başlık ve form hiyerarşisi, tabular rakamlar, koyu lacivert sidebar ve açık aktif durum, M marka işareti, görünür odak, mobil44px hedefler ve16px form girişi eklendi. Remote font/CDN/CSP değişmedi. Sidebar düşük yükseklikte erişilebilir scroll'unu ve masaüstü uzun kuyruk bağımsız scroll'unu korur; ince görünür scrollbar kullanılır. İletişim geçmişinin20rem ve teklif geçmişinin32rem iç scroll bölgeleri kaldırıldı; doğal belge akışı kullanılır. Dikey sayfayı kısaltma iddiası yoktur: uzun geçmişlerde doğal belge uzayabilir. Hassas dialog ve tablolardaki amaçlı overflow korunur.

ux-stage-b-red.json iki yeni stil sözleşmesi RED; ux-stage-b-green.json ile ilgili shell/navigation/stil checkpoint'i GREEN. Stil sözleşmeleri görsel kabulün yerine geçmez; computed geometry ve gerçek Edge Stage D'de ölçülür.

## Stage C — dar günlük iş akışı

Seçili yetkili Task'ın customerId/policyId değerlerinden mevcut profile/detail route'larına doğrudan link eklendi; endpoint/izin genişletme yok, aynı dirty/unresolved navigation guard'ı kullanılır. Eski poliçeyi açmak için tekrar numara yazma/filtreleme gerekmez. İş aşaması, gerçek görüşme ve SENT olaylarından ayrı açıklanır; hiçbir state otomatik değiştirilmez. Süresi dolmuş güncel teklif sürümüne Türkçe açıklama ve mevcut revizyon yolunu anlatan koşullu metin eklendi; eligibility/atomic expiry değişmedi. Teklif listesindeki CAS sözcüğü kayıt sürümü oldu; exact değer aynı kalır.

İleri müşteri giriş açıklaması atama/arşiv/kimlik olarak netleştirildi; mevcut profile ve iletişim bölümüne dönüş linkleri korunur. **Modalı inline sayfaya dönüştürme ilk adayda denendi, fakat nihai kapsamdan çıkarıldı.** Kaynak incelemesinde legacy assignment/identity alt bileşenlerinin bağımsız retry/reauth state'leri olduğu, sayfa guard'ıyla ortak risk yayınlamadığı görüldü. Drawer/route gezinmesini bu formların çevresinde açmak, var olan etkileşim sınırını güvenle korumak için daha geniş bir çalışma gerektirir. Bu bir kanıtlanmış backend/data-loss kusuru iddiası değildir; ihtiyatlı risk değerlendirmesidir. Kullanıcının riskli optional işi atla yetkisiyle inline CSS/class kaldırıldı, modalın mevcut sınırı ve tüm komutları aynen bırakıldı. Kalıcı ux-advanced-layout testi bu korunan modal/komut sınırını denetler; ilk inline adayın test/Edge checkpoint'leri nihai kabul sayılmaz. Profile dönüş hâlâ önce mevcut detay penceresini kapatmayı gerektirir; ileri işlemlerin kapsamlı sadeleşmesi tamamlandı denmez.

Yeni testler önce direct-link/expired açıklamasında RED verdi. İlk C komşu koşusunda56PASS/6FAIL yalnız eski “Kayıt CAS v7” metnini bekleyen testlerdi; sürüm7/eligibility/no-write assertions korunarak yeni etiket beklentisine uyarlandı. Advanced layout RED null class doğruladı; sonraki testte fixture'da bulunmayan “Kimliği Göster” yerine gerçek “Kimlik Bilgisini Güncelle”, “Sorumluyu Ata”, “Müşteriyi Arşivle” kontrolleri doğrulandı. Sözleşme veya business assertion gevşetilmedi.

## Stage D — tarihsel checkpoint ve başarısızlıklar

İlk UI komutunda Vitest5'in desteklemediği --include bayrağı setup hatası verdi; test çalışmış sayılmadı. `.ui.test.tsx` filtresiyle31 dosya493/493 checkpoint tamamlandı; sonraki advanced-layout testi ve markup için final gate ayrıca yenilenir. API foreground ilk240s zaman aşımı124; PASS sayılmaz, exact dosyalar uzun background kapısında yeniden çalıştırılır. İlk geniş Edge koşusu ileri müşteri dönüş linkinin eski modal arkasında kalması nedeniyle kesildi; hücre tamamlanmış sayılmadı. İlk adayda route-layout değişikliği denendi; güvenli nihai kapsam kararı Stage C'de açıkça ayrılmıştır.

API kapanışı: `ux-api-closure.json` exit0,5 gerçek yerel D1/API dosyası96PASS/0FAIL/0skip: policy-forms7, terminal-task-identity25, WON-create26, WON-link19, legacy-terminal19. Aynı rapordaki2 ek CSS sözleşmesi ayrı frontend statik testtir; API sayısına katılmaz (rapor toplam98PASS). Backend kaynakları ve domain sözleşmeleri değişmedi; uzun SQLite expiry-clock deneyleri yeniden çalıştırılmadı.

İlk tam React43 dosya koşusu592PASS/1FAIL/0skip: standalone reauth testi artık overview'da bulunmayan eski mocked “CRM workspace” etiketini bekliyordu. AuthShell/AuthenticatedApp kaynakları değişmeden gerçek “Genel Bakış” başlığı beklentisine uyarlandı; tek reauth POST/no-business/no-storage assertions korundu. Sonraki iki koşu592PASS/1FAIL/0skip, policy-parties negatif testinde başlangıç yüklemesi sırasında disabled “Taraf ekle”ye erken basıldığını gösterdi. Aynı dosyanın add helper'ında zaten bulunan enabled-wait kalıbı negatif seçim ve customer401 kardeş yoluna eklendi; implicit müşteri/rol seçmeme, no-write, scope/session assertions aynen korundu. İkinci tekrar izoleydi; hata salt kaynak rekabeti varsayılıp geçiştirilmedi. Runtime policy-parties kodu değiştirilmedi. Son tam gate ayrıca esas alınır.

İlk geniş Edge tekrarında9/9 tamamlanan checkpoint: `node_modules/.cache/ux-sprint-el1Ifz/result.json`,60PNG. Back/forward kal/onay, original terminal exact retry, doğrudan policy/customer routes, inline advanced dönüşü ve collapse geçti. History scroll probe'unda bazı boş geçmişler için boş dizi çıkabildiği saptandı; final harness gerçek quote-history açarak en az bir history bölgesi varlığını zorunlu kılar, uzun policy metni, touch karar tıklaması ve runtime/CSP kontrolü ekler. Bu güçlendirilmiş9-cell final ayrıca beklenir; checkpoint tekrarları final toplamına eklenmez.

Güçlendirilmiş Edge `ux-sprint-7BE6f4/failed.json`: OWNER1440/768 tamamlandı,360 ileri müşteri sayfasında horizontal overflow assertion'ı FAIL. Önceki9/9 checkpoint bu yeni kapsamın kabulü sayılmadı. İlk dar probe `ux-sprint-IcCVPR` yüklenecek müşteri detayını beklemediğinden erken PASS verdi; nihai kabul sayılmaz. Gerçek “+ Poliçe Ekle” kontrolünü bekleyen settled probe'lar `ux-sprint-00nMer` ve `ux-sprint-THldjB` aynı overflow'u yeniden üretti. DOM ölçümü legacy müşteri toolbar/table kartının flex min-content nedeniyle643px'e büyüdüğünü gösterdi. İçeriği gizlemeden, yalnız mevcut frontend ana içerik wrapper'ına `legacy-content` class'ı ve doğru min-width0/max-width100% sınırları eklendi; amaçlı yatay table overflow korunur. Aynı settled360 probe `ux-sprint-M0pBwL/result.json` exit0/PASS; yeni9cell ve ilgili React gate bundan sonra yeniden çalıştırılır. Bu frontend yerleşim kusurudur, integrity/security kusuru değildir.

Aşağıdaki nihai kapı bu checkpoint'leri supersede eder; geçmiş FAIL/RED kayıtları silinmez. Backend, schema, permission/auth veya migration değişikliği yapılmadı. Kullanıcının8443 görünür demosu kapatılmadı; bağımsız kabul aynı mevcut fixture ve HTTPS adaptörünün yalnız9443 loopback origin'ine uyarlanmış geçici bundle'ında yürütülür. Gerçek server domain kodu aynı kalır.

## Nihai kabul — LOCAL GO, sınırlı frontend kapsamı

A GREEN; B tamamlandı; C'nin yukarıdaki düşük riskli navigasyon/metin iyileştirmeleri tamamlandı; ileri müşteri modalını inline'a çevirme optional işi güvenlik sınırını genişletmemek için **bilinçli olarak kapsam dışı bırakıldı**. D nihai kapısı bütün aşağıdaki sonuçlarla tamamlandı. Kaynak/test dondurma manifesti `node_modules/.cache/ux-sprint-accepted-source-hashes.json` ile17 dosyada hash eşitliği doğrulandı. Sonrasında yalnız bu kanıt belgesi düzenlendi.

### Otomatik test ve kalite kapıları

| Kapı                                      | Son kanıt                                   |    PASS |  FAIL |  Skip |
| ----------------------------------------- | ------------------------------------------- | ------: | ----: | ----: |
| Gerçek yerel D1/API,5 dosya               | `ux-api-closure.json` içindeki5 API dosyası |      96 |     0 |     0 |
| Bütün43 React test dosyası                | `ux-ui-final-closure.json`                  |     593 |     0 |     0 |
| CSS/scroll token sözleşmesi,1 dosya       | aynı final UI raporu                        |       2 |     0 |     0 |
| Tekilleştirilmiş otomatik toplam,49 dosya | API96 + React593 + CSS2                     | **691** | **0** | **0** |

`ux-api-closure.json` raporu2 CSS testini de içerdiğinden98 gösterir; bu2 test final toplamda iki kez sayılmadı. `ux-ui-final-closure.json` raporu595PASS/0FAIL/0skip ve44 dosyadır. Komutlar: `node node_modules/vitest/vitest.mjs run .test.tsx tests/ux-visual-foundation.test.ts --maxWorkers=1 ...`; API komutunun dosyaları Stage D'de sayılmıştır. Eski checkpoint/targeted tekrarları bu toplama eklenmedi. Tüm repo backend/migration/clock suite'i yeniden çalıştırılmadı.

React kapsamı: günlük kuyruk/statistics/reassignment/task operations, customer profile/search/create/contact/notes/company contacts, policy list/detail/standalone forms/parties/lifecycle/append, iletişim geçmişi, teklif/draft/revision/SENT, LOST/VOIDED, WON LINK ve CREATE, parent draft/operation guards, navigation, auth/session/reauth, legacy workspace/quote/completion/WhatsApp ve mevcut document UI testleri. Document UI testlerinin çalışması belge aktivasyonu değildir.

- Typecheck PASS.
- Değişen kaynak/test dosyalarında ESLint PASS.
- Değişen dosyalarda Prettier check PASS; orijinal audit/protected belge formatlanmadı.
- Son `npm run build` PASS: client build + Worker **yalnız `--dry-run`** + security boundaries. Kanıt: `node_modules/.cache/ux-final-build.log`. Mevcut Wrangler environment seçimi uyarısı vardı; sonu `--dry-run: exiting now.`; canlı deploy değil.
- Git diff-check PASS. src/server, src/shared, db/schema/migrations, AuthShell/AuthenticatedApp, dependency ve Wrangler config drift0.
- Bağımsız reviewer çalıştırılmadı; mevcut oturumdaki gerçek test sonuçlarıdır. Production-ready veya tam WCAG kabulü değildir.

### Gerçek Edge — son9/9

Microsoft Edge **155.0.4283.45**, Windows `msedge` channel; sentetik OWNER/Ahmet/Ayşe, disposable D1, gerçek login endpoint'i. Son komut `node tests/browser/ux-quality.smoke.mjs`, `ux-edge-final-closure.log`, süreç **exit0**.

| Aktör | 1440px | 768px | 360px |
| ----- | ------ | ----- | ----- |
| OWNER | PASS   | PASS  | PASS  |
| Ahmet | PASS   | PASS  | PASS  |
| Ayşe  | PASS   | PASS  | PASS  |

Son kanıt: `node_modules/.cache/ux-sprint-ixgcQO/result.json`.9 benzersiz aktör/genişlik çifti,9 tamamlanan sonuç ve **69 benzersiz PNG** Python ile ayrıca sayıldı; dosyaların varlığı doğrulandı. Runtime/CSP error0. Hiçbir failed/setup/interrupted hücre bu9'a katılmadı. Inline adayın önceki `ux-sprint-8tTouk` koşusu da nihai kaynak yerine sayılmaz; son koşuda orijinal advanced modal korunur ve önce açıkça kapatılarak profile dönülür.

Her hücrede: dirty draft ile yan menüye çıkma; drawer kapanması; kalmada aynı taslak; Escape ile kalma; açık ayrılma; gerçek back/forward kal/onay; policy/customer ID üzerinden authorized route'a geçiş; advanced mevcut modalı kapatıp profile dönüş; gerçek LOST commit yanıtının kaybı sonrası çıkış engeli ve aynı body/key ile retry; uzun müşteri/poliçe metni; her screenshot noktasında yatay document overflow olmaması.1440'te collapse/expand ve uzun kuyrukta klavye ile iç kaydırma;768/360'ta Edge touch emülasyonu ile menü/kal dokunması, drawer Tab döngüsü ve Escape odağı kontrol edildi.

Quote history önce gerçekten açıldı; computed overflow dizisinin boş olmaması zorunlu tutuldu. Son9 hücrenin tümünde history overflow visible; masaüstü kuyruk bağımsız scroll'lu, tablet/mobil kuyrukta max-height sınırı nedeniyle ilave iç scroll yok. Uzun ad/poliçe stres testi yalnız DOM sunumunda sentetik metinle yapıldı, domain kimliği/prim/veri değiştirilmedi.

MEMBER6 hücresinde policy GET403 yanıtı **kasıtlı enjekte edilerek** denial sunumu ve detay kartı bulunmaması doğrulandı; bu gerçek grant-revocation testi diye sunulmaz. Canlı yetki/Task identity/domain retleri ayrı API96 ve mevcut UI regresyonlarındadır. Edge belirsiz terminal örneği LOST'tur; WON LINK/CREATE bu sprintin API/UI regresyonlarında doğrulandı, yeni bir9-cell WON acceptance iddia edilmez. Fiziksel telefon, gerçek sanal klavye veya ekran okuyucu denetimi yapılmadı.

### Ölçülen / doğrulanabilir sürtünme farkları

| Dar işlem                                         | Önce                                                                                     | Sonra                                                          | Sınır                                                                                                    |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Temiz seçili görevden eski poliçe detayına erişim | Audit J1: menü → numara girişi → filtre → detay,4 kontrol eylemi;1 tekrar yazılan numara | Mevcut yetkili ID ile “Poliçeyi aç”,1 tıklama;0 numara tekrarı | Aynı dar erişim parçası karşılaştırılır; bütün J1 zinciri yeniden zamanlanmadı. Dirty onay kaldırılmadı. |
| Mobil dirty sidebar çıkışında uyarıya erişim      | Ek “Menüyü kapat” workaround'u1                                                          | Ek kapatma0; drawer kendiliğinden kapanıyor                    | Üç aktörde360 ve son matriste768 ile de doğrulandı.                                                      |
| Geçmişte iç scroll türü                           | İletişim20rem + teklif32rem sınırlı                                                      | İkisi de doğal belge akışında                                  | Toplam belge boyu/çalışan tekerlek sayısı azaldı iddiası yok.                                            |
| İleri müşteri arka planı min-content taşması      | Settled probe'da643px kart                                                               | Final360/768 screenshot noktalarında document overflow0        | Table'ın amaçlı yatay scroll'u korunur; advanced modalın dikey scroll'u kaldırılmadı.                    |

Süre, verim yüzdesi veya gerçek çalışan memnuniyeti uydurulmadı. Font/renk token'larında hesaplanan örnek kontrastlar: sidebar ana metin11.19:1; aktif öğe9.11:1; sidebar ikincil metin7.89:1; normal yardımcı metin5.75:1; primary button6.87:1. Bunlar tüm ekranlarda otomatik WCAG sertifikası değildir.

### Önce / sonra görüntüleri

- High önce: `node_modules/.cache/ux-sprint-HQdooM/owner-360-before-dirty.png` (Ahmet/Ayşe eşleri de aynı dizinde).
- High sonra: `node_modules/.cache/ux-sprint-ixgcQO/owner-360-after-dirty.png`.
- Görsel temel önce: `node_modules/.cache/crm-ux-audit-EfSYBk/j1-selected-owner.png` — orijinal audit artefaktı, değiştirilmedi.
- Masaüstü sonra: `node_modules/.cache/ux-sprint-ixgcQO/owner-1440-workspace.png`.
- Tablet sonra: `node_modules/.cache/ux-sprint-ixgcQO/ayse-768-workspace.png`.
- Uzun metin/geçmiş mobil: `node_modules/.cache/ux-sprint-ixgcQO/ahmet-360-long-policy-and-history.png`.
- Advanced korunmuş modal: `node_modules/.cache/ux-sprint-ixgcQO/owner-360-customer-advanced.png`.

Tam yerel kök: `C:\Users\sinan\Desktop\panel\node_modules\.cache\ux-sprint-ixgcQO`. Cache artefaktları Git'e alınmadı; cache temizliğiyle silinebilir. Asıl audit raporu değiştirilmedi.

### Kasıtlı olarak değişmeden kalanlar

Exact Task/renewal/policy identity ve CAS; server-authoritative scope/grants/session invalidation; tüm terminal ve reauth/secure onayları; frozen URL/method/body/key; uncertain exact retry ve accepted POST sonrası GET-only recovery; atomic CREATE policy/full-premium link/Task/WON; grossPremium decimal string/BigInt kontrolü; quote immutable revision/SENT semantiği ve SQL expiry; LOST/VOIDED/OTHER farkı. Sigortacı ve sorumlu için açıklanmayan default yok. İş aşaması veri tabanında otomatik değiştirilmedi. Advanced motor ve modal sınırı korunur. Hiçbir domain kabiliyeti kaldırılmadı.

### Öncelikli kalan UX işleri

1. Uzun mobil formların salt-okunur açıklama/kimlik ayrıntılarında, aktif draft/request state'i unmount etmeden kademeli açılım. Bütün formu kısaltılmış gibi sunmuyoruz.
2. WON'da okunabilir teklif seçenekleri, daha az görünür UUID/CAS/minor ve İstanbul tarihi; fark gerekçesi kodunu güvenli ve açık iş diliyle sunma. Bu sprintte yalnız teklif liste etiketindeki CAS sadeleşti.
3. Advanced customer motorunun ortak risk-aware navigation/reauth kapsamıyla ayrıca sadeleştirilmesi; bu sprint yalnız yönlendirme metnini iyileştirdi, inline dönüşümü bilinçli atladı.
4. Yeni Task B'ye yalnız açık ve fresh authorized seçimle daha kısa geri dönüş. A→B otomatik retarget yok.
5. Süresi dolmuş SENT'in WON seçim listesinde neden görünmediğini ayrıca açıklama; mevcut history uyarısı tamamlandı, tüm boş seçim metinleri yeniden yazılmadı.
6. Yetki reddini daha erken/anlaşılır anlatma; rolden yetki çıkarma veya client menü gizlemesini güvenlik sayma yok.

CREATE_POLICY sırasında optional accepted-quote association bilinen kapsam dışıdır; yeni business fazı olarak ayrıca yetki ister. **Phase4G-C başlatılmadı.**

### Commit kapsamı ve koruma

Aşağıdaki18 dosya niyetli frontend/test/kanıt setidir; protected belge ve orijinal audit commit dışıdır:

- `FRONTEND_UX_QUALITY_SPRINT.md`
- `src/app/App.tsx`
- `src/app/components/layout/AppShell.tsx`
- `src/app/components/layout/Sidebar.tsx`
- `src/app/components/layout/NavigationDecision.tsx`
- `src/app/pages/CompatibilityPage.tsx`
- `src/app/pages/today-work/RenewalQuotesSection.tsx`
- `src/app/pages/today-work/TodayWorkPage.tsx`
- `src/app/pages/today-work/today-work.css`
- `src/app/theme.css`
- `tests/auth.standalone-reauth.test.tsx`
- `tests/policy-parties.ui.test.tsx`
- `tests/renewal-quote-send-modern.ui.test.tsx`
- `tests/ux-navigation.ui.test.tsx`
- `tests/ux-customer-orientation.ui.test.tsx`
- `tests/ux-advanced-layout.ui.test.tsx`
- `tests/ux-visual-foundation.test.ts`
- `tests/browser/ux-quality.smoke.mjs`

Protected SHA256: `f272a14efce57f2ef47d960c2ac387e11cdaeda96aa6fda71db8585844e28930`. Audit SHA256: `bd115ce7601657eda78220e4bf3bfcad3aa0cea77b14e78dbc8fc1504286c440`. Git stage öncesi ve publication sonrası ayrıca doğrulanır. Commit/push yalnız bu son GO adayına uygulanır; commit SHA ve HEAD/origin/remote main readback'i kapanış yanıtındadır.

Production deployment/Cloudflare mutasyonu, yeni migration/schema/backend/auth/authorization kuralı, Paid kaynak, gerçek müşteri verisi, sigortacı issuance, dış mesaj veya R2/document aktivasyonu yok. **LOCAL GO yalnız bu sınırlı frontend sprintinin yerel kapıları içindir.**
