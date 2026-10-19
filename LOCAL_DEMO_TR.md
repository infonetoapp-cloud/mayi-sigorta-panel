# Mayı Sigorta — Windows yerel demo

Bu demo gerçek React/Vite arayüzü, Hono API, migration0022, yerel D1 ve mevcut email/parola + cookie/session/CSRF/izin kontrollerini kullanır. Mock giriş veya yetki bypass'ı yoktur. Yalnız demo CLI'ında mevcut canonical Node scrypt hasher server composition'a bağlanır; production auth/Worker kodu değişmez. Lokal rate-limit binding'leri 10 hesap/1000 kaynak istek/dakika sınırını uygular.

## Windows CMD ile başlatma

Phase4D'nin tarihsel backend kimlik engeli `ddf1e37d91f53801565b1f205ff976aafbc99633` ile kapandı; kanıt `QUOTE_IDENTITY_INTEGRITY.md`. Güncel frontend yerel kabul kararı ve test/Edge kanıtı `FRONTEND_PHASE4D.md` içindedir. Farklı sigortacı veya ürün için “Yeni teklif taslağı aç” kullanın; “Yeni değişmez sürüm” aynı teklifin ilk kayıtlı şirket/ürün kimliğini sabit tutar. Bu demo production deployment veya gerçek veri kabulü değildir.

Phase4D: `/today-work` görev seçimi içinde “Teklif geçmişini aç” yalnız seçili yenilemenin bağımsız yetkili geçmişini okur. “Yeni teklif taslağı aç” sunucu varsayımlarını öneri olarak getirir; kapsam, gelecek İstanbul geçerlilik zamanı, prim, ödeme/taksit ve koşulları inceleyip açıkça onaylayın. “Yeni değişmez sürüm” mevcut kaydı değiştirmez; ayrı version row yaratır. Prim decimal/BigInt-safe kuruşa çevrilir. İletişim/görev taslağı önce açıkça kapanır; belirsiz teklif anahtarı çözülmeden liste/hedef/legacy değişmez. Conflict karşılaştırma+yeniden onay, confirmed-write sonrası okuma hatası yalnız GET retry'dır. Gönderim/kabul/ret/WhatsApp/terminal sonuçlar legacy'dedir; gönderildi status dış teslimat değildir. Kanıt: `FRONTEND_PHASE4D.md`.

Phase4C: `/today-work` seçili görevinde “Yeni takip planını aç” ile yeni İstanbul tarih/saatini açıkça seçip tamamla+replacement işlemini onaylayın; fırsat kapanmaz. “Görev atama seçeneklerini aç” yalnız endpoint yetkili dizinini gösterir; hedef açık seçilir ve ayrı onaylanır. İletişim taslağı açıkken görev işlemi gönderilmez. Belirsiz task yazımı çözülene kadar liste/hedef değiştirilmez; exact retry veya confirmed-write sonrası GET-only recovery kullanılır. Conflict karşılaştırması sonraki sayfadaki görevi de özgün cursor URL'sinden okur. Ayrıntılı kanıt: `FRONTEND_PHASE4C.md`.

Phase4B: `/today-work` içinde görev seçip “İletişim geçmişi”ni okuyun. “İletişim kaydı ekle” ile gerçek temas, yanıtsız deneme veya iç not kaydedilir; saat İstanbul'dur. Gerçek temas ayrı doğrulama, şirket kaydı açık yetkili seçimi ister. Not/yanıtsız arama/WhatsApp işlemi gerçek temas değildir; form mesaj göndermez. Başarı yetkili geçmiş okumasından sonra gösterilir. Belirsiz yanıtta yalnız aynı istek; yazım sonrası okuma hatasında yalnız GET tekrar edilir. Görevden ayrılmak sunucudaki yazımı iptal etmez; taslak/key yalnız açık bölümün belleğindedir. Teklif, WhatsApp önizleme/açma, tamamlama/atama ve yenileme sonucu `/today-work/legacy` içindedir. Ayrıntılı yerel kanıt: `FRONTEND_PHASE4B.md`.

Önkoşullar: Node.js24, npm ve OpenSSL (Git for Windows kurulumu içindeki OpenSSL de otomatik bulunur). Mevcut projede Node24 doğrulandı. Internet yalnız bağımlılıkların ilk indirilmesi için gerekebilir; hazır node_modules ile demo tamamen yereldir.

CMD açın:

```bat
cd /d C:\Users\sinan\Desktop\panel
node --version
npm ci
npm run demo
```

Bağımlılıklar zaten kuruluysa `npm ci` adımını atlayabilirsiniz. `npm run demo` gerçek Vite client build'i yapar; ayrı `npm run dev`, Wrangler, migration veya Cloudflare komutu ÇALIŞTIRMAYIN.

Terminal sırasıyla üç hesabın parolasını iki kez ister:

- Acente Sahibi: `sahip@demo.invalid`
- Ahmet: `ahmet@demo.invalid`
- Ayşe: `ayse@demo.invalid`

Her hesap için farklı, yalnız bu demo için kullanılan15–128 karakterlik güçlü parola seçin. Gerçek CRM/email parolanızı kullanmayın. Yazarken karakter/yıldız görünmez; yapıştırma desteklenir. Parolayı komut argümanına, ortam değişkenine, dosyaya veya bu sohbete yazmayın. Hazır/default parola yoktur; launcher parola veya verifier'ı terminale basmaz. CLI girişi yalnız interaktif TTY'dir; pipe/redirect kabul edilmez. Hatalı girişte demo başlamaz; tekrar `npm run demo` çalıştırın.

### Windows Terminal / PowerShell girişinde takılma için açık alternatif

Maskeli mod varsayılandır. Terminalinizde yazma/yapıştırma/Enter ilerlemiyorsa Ctrl+C ile durdurup PowerShell veya Windows Terminal'de şunu kullanın:

```powershell
Set-Location C:\Users\sinan\Desktop\panel
npm run demo -- --visible-input
```

UYARI: Bu modda parolalar yerel terminalde GÖRÜNÜR. Yalnız bu geçici sentetik demo için ayrı parolalar girin; gerçek hesap parolası kullanmayın. Ekran paylaşımı, terminal/transcript kaydı veya başkası ekranı görürken kullanmayın. Parolalar launcher tarafından ayrıca loglanmaz veya dosyaya yazılmaz; görünen terminal girdisinin kayda alınmasını uygulama engelleyemez.

Bu alternatif standart readline satır girişidir: raw mode veya özel keypress işleyicisi kullanmaz. Her girişten sonra Enter; her hesap için iki eşleşen giriş,15–128 karakter ve üç farklı parola zorunludur. Parolayı `--visible-input` yanına argüman olarak eklemeyin. URL yine https://localhost:8443; kurulum, gerçek auth ve izolasyon değişmez.

Hazır mesajından sonra tarayıcıda tam bu adresi açın:

https://localhost:8443

`http://`, IP adresi veya başka hostname kullanmayın. Server yalnız127.0.0.1 üzerinde dinler; LAN'a açılmaz.8443 başka uygulamada kullanılıyorsa onu güvenli biçimde kapatın; port değiştirmek için auth origin kontrollerini gevşetmeyin.

## Yerel HTTPS uyarısı

Her çalıştırma için bir günlük self-signed localhost sertifikası üretilir. Edge/Chrome ilk ziyarette sertifika uyarısı gösterebilir. Adresin kesinlikle `https://localhost:8443` olduğundan emin olun; yalnız bu yerel demo için “Gelişmiş” → “localhost sitesine devam et” seçin. Sertifika Windows güven deposuna eklenmez; global TLS doğrulamasını kapatmayın. Kurumsal tarayıcı politikası bu istisnaya izin vermiyorsa demo HTTPS girişini engeller; HTTP/auth bypass kullanmayın, yerel sertifika için cihaz yöneticisinin onaylı çözümünü isteyin.

Secure/HttpOnly/SameSite cookie ve gerçek origin/CSRF kontrolleri aynen kalır.

## Veri ve izolasyon

Her başlangıç sıfırdan yeni geçici D1 oluşturur, bütün güncel migration'ları uygular ve yalnız sentetik kayıtlar ekler:

- Bir OWNER; Ahmet ve Ayşe isimli iki aktif çalışan.
  -10 tamamen kurgusal müşteri; gerçek TCKN/VKN/telefon/belge yoktur. Email'ler teslim edilemeyen `.invalid` domain'indedir.
  -10 örnek poliçe,10 yenileme,10 taslak teklif,11 müşteri notu ve iki çalışana beşer atanmış görev. Tarihler bugüne göre belirlenir; takvim-günü istatistiği her çalışanda2geciken/2bugün/1yaklaşandır. İş listesi anlık vade kullanır; aynı günün geçmiş saatli takipleri de Geciken olabilir.
- Deniz Yılmaz müşteri kartında hem Ahmet hem Ayşe adına sunucu kaynaklı not vardır.

Mevcut `.wrangler`, geliştirme D1'i, production kaynakları, dotenv/credential dosyaları kullanılmaz. Browser oturumları uygulamanın gerçek login endpoint'inden oluşur; hazır session enjekte edilmez. CSRF secret rastgele ve süreç belleğindedir. D1, TLS ve derlenen CLI artefaktları geçicidir; normal Ctrl+C kapanışında silinir. Zorla process sonlandırılırsa geçici TLS/bundle kalıntıları OS temp veya ignored node_modules/.cache altında kalabilir; sonraki çalıştırma bunları reuse etmez. D1 uygulama verisi yeniden başlatmada korunmaz; bu bir yedekleme/production restore yöntemi değildir.

Queue/Cron çalıştırılmaz. Belge, belge jobs/cron ve renewal-continuation bayrakları kapalıdır. Gerçek WhatsApp/email göndermeyin; örnek telefonlar özellikle yoktur. Personel ekranında oluşturulan/resetlenen geçici parolalar mevcut ürün davranışı gereği bir kez gösterilebilir; hazırlanan üç hesabı denemek için bu yönetim işlemlerine gerek yoktur.

## Kısa demo turu

1. `ahmet@demo.invalid` ve terminalde kendiniz belirlediğiniz parolayla giriş yapın.
2. “Müşteriler”den Deniz Yılmaz'ı açın. “Müşteri Notları”nda geçmişi gösterin: Ahmet ve Ayşe atıflarını kontrol edin. Yeni bir sentetik not ekleyebilirsiniz. Aynı müşteri kartı iki çalışan için de ortaktır.
3. “Bugünkü İşler”de yalnız Ahmet'in beş işi görünür. “Görev istatistiklerini göster” ile2/2/1 açık iş sayımını kontrol edin. Ekip görünümü çalışan için açılmaz. İş listesi anlık gecikme, sayaç takvim günü hesabı kullanır; ekrandaki tanımlar farkı açıklar.
4. Modern kuyruktan bir takip seçin. Desktop solda liste/sağda özet, tablet/mobile tek kolon ve Görev listesine dön kontrolü vardır. Seçili özetten Klasik iş akışını aç genel `/today-work/legacy` listesine gider; seçtiğiniz görevi otomatik açmaz. Klasik listeden işi yeniden seçip “İletişim, teklif ve sonuçları aç” kullanın. Mevcut taslak Anadolu/Kasko teklifini/yeni sürüm formunu açın; görüşme veya teklif/sürüm kaydedin. “Takibi tamamla ve yenisini planla” mevcut yeni takip zamanıyla sürer. Gerçek gönderim yapmayın.
5. “Çıkış Yap” deyip Ayşe hesabına girin. Aynı Deniz kartını/notları görür; iş listesi artık Ayşe'nin farklı beş görevini gösterir. Önceki Ahmet notunu değiştirme/silme özelliği yoktur.
6. OWNER hesabına girin: modern Bugünkü İşler'de authorized Açık işler/Atanmamış işler/Yeniden atama gerekenler kuyrukları, istatistiklerde Ekip özeti vardır. Satır sayısını tüm portföy toplamı sanmayın; Daha fazla iş yükle iki kuyruğun bağımsız cursor'ını kullanır. Atama/reassignment klasik çalışma alanındadır; otomatik yapılmaz. Atama iş yükünü taşır; customer sahipliğini veya geçmiş not yazarını değiştirmez.401/403/404 veya invalid cursor'da protected seçim temizlenir; Listeyi yenile baştan yetkili okur, geçici sayfa hatasında Aynı sayfayı yeniden dene aynı cursor'ı kullanır.

Eşzamanlı üç hesap denemek için ayrı browser profilleri veya ayrı tarayıcılar kullanın; aynı profilin normal sekmeleri cookie paylaşır. Tek profil içinde hesap değiştirirken önce çıkış yapın.

### Modern şirket yetkilileri

Müşteriler → Yeni Müşteri → Kurumsal ile sentetik bir şirket oluşturun. Profilin İletişim bölümünde Şirket yetkilileri alanından yetkili ekleyin; ad/soyad, görev/unvan, e-posta/telefon girin. Düzenleme, birincil yapma ve açık onayla pasifleştirme aynı sayfadadır. Pasif kayıt geçmişte görünmeye devam eder. Bu işlemler personel hesabı veya kişisel günlük görev ataması oluşturmaz.

Belirsiz ağ yanıtında sayfayı yenilemek yerine “Aynı işlemi yeniden dene” kullanın; aynı key/body korunur.409'da güncel yetkilileri yükleyip taslağınızla karşılaştırın ve yeniden onaylayın. Taslak/key yalnız açık sayfanın belleğindedir. Arşivli şirketlerde geçmiş okunur, yeni yetkili işlemleri kapalıdır. İleri müşteri işlemleri ve klasik şirket-yetkilisi yolu kaldırılmadı.

### Modern poliçe gezintisi

Detay → Sorumlu ve arşiv modern atama ve ayrı arşiv tehlike kartını açar. OWNER atama yapabilir; standart Ahmet/Ayşe hesaplarında AGENCY atama yetkisi yoksa dizin/seçici gizlenir. Personel bazlı gerçek sunucu izinleri geçerlidir; her çalışan atama/arşivleme yapamaz. Etkin sorumluyu açıkça seçin ve değişikliği checkbox ile onaylayın; eski devre dışı sorumlu yerine otomatik kişi atanmaz. Bu atama günlük kişisel görev/yenileme görevi/şirket yetkilisi değildir.

Poliçeyi arşivle ilk tıkta yazmaz: sözleşme numarası/dönem/prim/status özetini inceleyin, büyük harf/rakam/alt çizgi gerekçe kodu girin (3–64 karakter, harfle başlamalı; örnek HISTORICAL_RECORD), son checkbox'ı işaretleyip onaylayın. Arşiv iptal, geçersiz kılma veya yenileme tamamlama değildir. OPEN_DEPENDENCIES409 açık yenileme/takip işi olduğunu belirtir; uygulama bunları kapatmaz veya kontrolü atlamaz. Önce yetkili iş akışından inceleme gerekir.409'da güncel poliçeyi karşılaştırın ve tekrar açık onay verin. Belirsiz sonuçta sayfayı yenilemeyin; Aynı işlemi yeniden dene original body/key ile çalışır. İşlem kaydedilmiş/okuma hatalıysa Kaydedilen poliçeyi yeniden oku yalnız GET yapar. Başarılı arşiv sonrası tüm modern ordinary yazımlar kapanır; tarihçe okunabilir.

Poliçeler menüsü modern listeyi açar. Numara için tam/başlangıç eşleştirmesi, sözleşme durumu, bitiş aralığı ve mevcut sıralamaları kullanın. Bir poliçe numarasına basınca gerçek tam sayfa detay açılır; müşteri bağlantısı modern profile döner. Arşiv, sözleşme iptali veya geçersizliği ile aynı şey değildir.

Zeyiller bölümünde Zeyil ekle ile dış referans, geçerlilik tarihi ve açıklama girin. Prim farkı isteğe bağlıdır; `12.34`, `-0.50` veya `0` biçiminde ve ISO para birimiyle birlikte girilir; ikisini de boş bırakabilirsiniz. Başta +, virgül/binlik ayırıcı veya ikiden fazla ondalık kullanmayın. Zeyil yeni poliçe dönemi/yenileme/iptal değildir ve özgün brüt primi değiştirmez. Dış referanslar bölümünde kaynak ad alanı+dış anahtar eklenebilir; otomatik dış sistem bağlantısı kurulmaz. Her iki bölüm yalnız yeni tarihsel kayıt ekler; güncelleme/silme yoktur.409'da güncel kayıtları karşılaştırıp yeniden onaylayın; duplicate referansı tekrar eklemeyin. Belirsiz yanıtta aynı işlem/key retry, yazım başarılı/okuma başarısızsa yalnız GET retry kullanılır. Arşivli poliçeler salt okunurdur.

Sigortalılar ve lehtarlar bölümünde Taraf ekle ile en fazla20 sonuçlu müşteri aramasını kullanın, müşteriyi ve rolü açıkça seçin. Müşteri yetkili API'den doğrulanmadan eklenmez. Aktif tarafı pasifleştirmek ayrı onay ister; pasif geçmiş silinmez. Bu ilişki kişinin tam müşteri profiline/diğer poliçelerine erişim hakkı vermez; müşteri arşivleme veya poliçe iptali değildir.409'da güncel tarafları karşılaştırıp yeniden onaylayın; belirsiz yazımda aynı işlemi yeniden deneyin. Yazım başarılı/okuma başarısızsa Kaydedilen tarafları yeniden oku yalnız GET yapar. Arşivli poliçe geçmişi salt okunurdur.

Poliçeler → Yeni poliçe modern tam sayfa formu açar. Müşteri profilindeki Poliçe ekle kaynağı otomatik seçer; ilk20 arama sonucu dışında da doğru müşteri ayrıca doğrulanır. Sigortacı/branş/ürün ve ödeme yöntemini seçin; taksit yalnız destekleyen yöntemde istenir. Prim için `1234.56` gibi noktalı ondalık kullanın, binlik ayırıcı girmeyin. Her kayıt ayrı sözleşme dönemidir; yenileme için eski dönemin üzerine yazmayın.

Detay → Poliçeyi düzenle ile temel alanları güncelleyin; müşteri bağı değiştirilemez.409'da güncel poliçeyi karşılaştırıp taslağı yeniden onaylayın. Belirsiz POST/PATCH'te sayfayı yenilemeden Aynı işlemi yeniden dene kullanın; body/key yalnız açık sayfanın belleğindedir. Kayıt başarılı ama detay yüklenememişse Kaydedilen poliçeyi yeniden oku yalnız GET yapar.

Ordinary poliçe create/edit, taraf, zeyil/reference ve sorumlu/arşiv işlemleri moderndir. Hassas kimlik-varyant onayı ayrı güvenli klasik akışta kalır. “Poliçe işlemleri (klasik)” bağlantısı eski ileri işlemlerin doğrulanmış backstop'udur; legacy create/edit ve İleri müşteri işlemleri → +Poliçe Ekle handoff'u da kaldırılmadı. Belge görüntüleyici veya belge aktivasyonu yoktur.

## Kapatma ve tekrar başlatma

Demo CMD penceresinde Ctrl+C. Veriler silinir. Tekrar `npm run demo` yeni izole dataset ve yeni seçtiğiniz parolalarla başlar. Eski browser cookie'si yeni süreçte geçersizdir; giriş ekranı gelmezse sayfayı yenileyin.

## Doğrulama kapsamı

PowerShell visible-input düzeltmesi: CLI/input8 + mevcut gerçek D1/HTTPS demo1 =2 dosya9/9 PASS; typecheck, odaklı ESLint/Prettier ve diff-check PASS. Stream tabanlı testlerde CRLF/Unicode satırları, altı ardışık prompt, default masked seçimi, görünür uyarı, raw-mode çağrısının yokluğu, confirmation/minimum/distinct/EOF retleri doğrulandı. Gerçek launcher child-process argüman/TTY retleri ve `npm run demo -- --visible-input` npm aktarımı kontrol edildi. Kullanıcının Windows Terminal/PowerShell oturumu otomatik sürülmedi; manuel klavye/paste/Enter kabulü bu ortamda ayrıca kullanıcı tarafından denenmelidir. Parola/session/auth/deploy davranışı değişmedi; production veya Cloudflare işlemi yoktur.

Bu dilimin son yerel gate'i:6 dosya39/39 PASS (`local-demo`, auth UI, TodayWork UI, müşteri notları UI, renewal workspace UI, task-statistics UI). Yeni entegrasyon testi gerçek canonical scrypt login ile üç hesabı, her çalışanın farklı beş görevini ve2/2/1 sayımını, ortak not yazarlarını ve OWNER ekip görünümünü doğruladı. Gerçek HTTPS listener'dan Vite HTML ve cookie'li login→me200, oturumsuz401 ve yabancı Host403 kontrol edildi. CLI bundle'ının doğrudan Node import'u3 hesap/openDemo export'u ile PASS. Lint/typecheck/format/client build/Worker yalnız dry-run/boundaries/diff-check PASS. Mevcut client chunk510,18kB ve Wrangler environment uyarıları sürer. Browser'da manuel sertifika onayı veya gerçek Windows CMD'de insanın gizli parola girişini otomasyonla yapılmış saymıyoruz; güvenli masked prompt kullanıcı çalıştırmasında kalır.

Gerçek yerel D1 + canonical password login + HTTPS listener smoke testi; iki çalışanın ortak müşteri/not, private task/statistics, OWNER ekip görünümü, taslak teklif okumaları, yanlış parola/yabancı Host reddi ve FK kontrolü vardır. İlgili React login/TodayWork/not/renewal/statistics UI testleri ayrıca çalıştırılır. Browser sertifikasına manuel onay Windows politikalarına bağlıdır; otomatik testte yalnız o sentetik self-signed bağlantı için TLS istisnası kullanılır, uygulama veya sistem TLS ayarı gevşetilmez. Bu demo production kapasite/güvenlik/release, gerçek veri veya belge açılışı kabulü değildir.

Mevcut UYGULAMA_DURUMU.md kirli değişikliği bu işten bağımsızdır; değişmeden ve commit dışında korunmuştur. Bu dosya demo çalıştırma rehberi ve bu dilimin yerel kullanım kaydıdır; yeni mimari plan değildir.
