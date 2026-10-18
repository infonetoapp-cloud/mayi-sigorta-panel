# Mayı Sigorta — Windows yerel demo

Bu demo gerçek React/Vite arayüzü, Hono API, migration0022, yerel D1 ve mevcut email/parola + cookie/session/CSRF/izin kontrollerini kullanır. Mock giriş veya yetki bypass'ı yoktur. Yalnız demo CLI'ında mevcut canonical Node scrypt hasher server composition'a bağlanır; production auth/Worker kodu değişmez. Lokal rate-limit binding'leri 10 hesap/1000 kaynak istek/dakika sınırını uygular.

## Windows CMD ile başlatma

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
  -10 örnek poliçe,10 yenileme,10 taslak teklif,11 müşteri notu ve iki çalışana beşer atanmış görev. Tarihler bugüne göre belirlenir; her çalışanda2geciken/2bugün/1yaklaşan görev bulunur.
- Deniz Yılmaz müşteri kartında hem Ahmet hem Ayşe adına sunucu kaynaklı not vardır.

Mevcut `.wrangler`, geliştirme D1'i, production kaynakları, dotenv/credential dosyaları kullanılmaz. Browser oturumları uygulamanın gerçek login endpoint'inden oluşur; hazır session enjekte edilmez. CSRF secret rastgele ve süreç belleğindedir. D1, TLS ve derlenen CLI artefaktları geçicidir; normal Ctrl+C kapanışında silinir. Zorla process sonlandırılırsa geçici TLS/bundle kalıntıları OS temp veya ignored node_modules/.cache altında kalabilir; sonraki çalıştırma bunları reuse etmez. D1 uygulama verisi yeniden başlatmada korunmaz; bu bir yedekleme/production restore yöntemi değildir.

Queue/Cron çalıştırılmaz. Belge, belge jobs/cron ve renewal-continuation bayrakları kapalıdır. Gerçek WhatsApp/email göndermeyin; örnek telefonlar özellikle yoktur. Personel ekranında oluşturulan/resetlenen geçici parolalar mevcut ürün davranışı gereği bir kez gösterilebilir; hazırlanan üç hesabı denemek için bu yönetim işlemlerine gerek yoktur.

## Kısa demo turu

1. `ahmet@demo.invalid` ve terminalde kendiniz belirlediğiniz parolayla giriş yapın.
2. “Müşteriler”den Deniz Yılmaz'ı açın. “Müşteri Notları”nda geçmişi gösterin: Ahmet ve Ayşe atıflarını kontrol edin. Yeni bir sentetik not ekleyebilirsiniz. Aynı müşteri kartı iki çalışan için de ortaktır.
3. “Bugünkü İşler”de yalnız Ahmet'in beş işi görünür. “Görev istatistiklerini göster” ile2/2/1 açık iş sayımını kontrol edin. Ekip görünümü çalışan için açılmaz. İş listesi anlık gecikme, sayaç takvim günü hesabı kullanır; ekrandaki tanımlar farkı açıklar.
4. Bir işte “İletişim, teklif ve sonuçları aç” seçin. Mevcut taslak Anadolu/Kasko teklifini ve teklif formunu açın. Yeni teklif/sürüm veya görüşme kaydedin; “Takibi tamamla ve yenisini planla” ile yeni tarih seçip çalışmayı sürdürebilirsiniz. Gerçek gönderim yapmayın.
5. “Çıkış Yap” deyip Ayşe hesabına girin. Aynı Deniz kartını/notları görür; iş listesi artık Ayşe'nin farklı beş görevini gösterir. Önceki Ahmet notunu değiştirme/silme özelliği yoktur.
6. OWNER hesabına girin: Bugünkü İşler'de iki çalışanın işleri ve atama seçenekleri; istatistiklerde “Ekip özeti”, Ahmet/Ayşe satırları ve tüm ekip toplamını kontrol edin. Atama iş yükünü taşır; customer sahipliğini veya geçmiş not yazarını değiştirmez.

Eşzamanlı üç hesap denemek için ayrı browser profilleri veya ayrı tarayıcılar kullanın; aynı profilin normal sekmeleri cookie paylaşır. Tek profil içinde hesap değiştirirken önce çıkış yapın.

### Modern şirket yetkilileri

Müşteriler → Yeni Müşteri → Kurumsal ile sentetik bir şirket oluşturun. Profilin İletişim bölümünde Şirket yetkilileri alanından yetkili ekleyin; ad/soyad, görev/unvan, e-posta/telefon girin. Düzenleme, birincil yapma ve açık onayla pasifleştirme aynı sayfadadır. Pasif kayıt geçmişte görünmeye devam eder. Bu işlemler personel hesabı veya kişisel günlük görev ataması oluşturmaz.

Belirsiz ağ yanıtında sayfayı yenilemek yerine “Aynı işlemi yeniden dene” kullanın; aynı key/body korunur.409'da güncel yetkilileri yükleyip taslağınızla karşılaştırın ve yeniden onaylayın. Taslak/key yalnız açık sayfanın belleğindedir. Arşivli şirketlerde geçmiş okunur, yeni yetkili işlemleri kapalıdır. İleri müşteri işlemleri ve klasik şirket-yetkilisi yolu kaldırılmadı.

### Modern poliçe gezintisi

Poliçeler menüsü modern listeyi açar. Numara için tam/başlangıç eşleştirmesi, sözleşme durumu, bitiş aralığı ve mevcut sıralamaları kullanın. Bir poliçe numarasına basınca gerçek tam sayfa detay açılır; müşteri bağlantısı modern profile döner. Zeyiller ve dış referanslar salt okunur bölümlerdir. Arşiv, sözleşme iptali veya geçersizliği ile aynı şey değildir.

Sigortalılar ve lehtarlar bölümünde Taraf ekle ile en fazla20 sonuçlu müşteri aramasını kullanın, müşteriyi ve rolü açıkça seçin. Müşteri yetkili API'den doğrulanmadan eklenmez. Aktif tarafı pasifleştirmek ayrı onay ister; pasif geçmiş silinmez. Bu ilişki kişinin tam müşteri profiline/diğer poliçelerine erişim hakkı vermez; müşteri arşivleme veya poliçe iptali değildir.409'da güncel tarafları karşılaştırıp yeniden onaylayın; belirsiz yazımda aynı işlemi yeniden deneyin. Yazım başarılı/okuma başarısızsa Kaydedilen tarafları yeniden oku yalnız GET yapar. Arşivli poliçe geçmişi salt okunurdur.

Poliçeler → Yeni poliçe modern tam sayfa formu açar. Müşteri profilindeki Poliçe ekle kaynağı otomatik seçer; ilk20 arama sonucu dışında da doğru müşteri ayrıca doğrulanır. Sigortacı/branş/ürün ve ödeme yöntemini seçin; taksit yalnız destekleyen yöntemde istenir. Prim için `1234.56` gibi noktalı ondalık kullanın, binlik ayırıcı girmeyin. Her kayıt ayrı sözleşme dönemidir; yenileme için eski dönemin üzerine yazmayın.

Detay → Poliçeyi düzenle ile temel alanları güncelleyin; müşteri bağı değiştirilemez.409'da güncel poliçeyi karşılaştırıp taslağı yeniden onaylayın. Belirsiz POST/PATCH'te sayfayı yenilemeden Aynı işlemi yeniden dene kullanın; body/key yalnız açık sayfanın belleğindedir. Kayıt başarılı ama detay yüklenememişse Kaydedilen poliçeyi yeniden oku yalnız GET yapar.

Atama, sigortalı/lehtar değişiklikleri, zeyil, dış referans, arşivleme ve güvenli onaylar “Poliçe işlemleri (klasik)” bağlantısında korunur; legacy create/edit ve İleri müşteri işlemleri → +Poliçe Ekle handoff'u da kaldırılmadı. Belge görüntüleyici veya belge aktivasyonu yoktur.

## Kapatma ve tekrar başlatma

Demo CMD penceresinde Ctrl+C. Veriler silinir. Tekrar `npm run demo` yeni izole dataset ve yeni seçtiğiniz parolalarla başlar. Eski browser cookie'si yeni süreçte geçersizdir; giriş ekranı gelmezse sayfayı yenileyin.

## Doğrulama kapsamı

PowerShell visible-input düzeltmesi: CLI/input8 + mevcut gerçek D1/HTTPS demo1 =2 dosya9/9 PASS; typecheck, odaklı ESLint/Prettier ve diff-check PASS. Stream tabanlı testlerde CRLF/Unicode satırları, altı ardışık prompt, default masked seçimi, görünür uyarı, raw-mode çağrısının yokluğu, confirmation/minimum/distinct/EOF retleri doğrulandı. Gerçek launcher child-process argüman/TTY retleri ve `npm run demo -- --visible-input` npm aktarımı kontrol edildi. Kullanıcının Windows Terminal/PowerShell oturumu otomatik sürülmedi; manuel klavye/paste/Enter kabulü bu ortamda ayrıca kullanıcı tarafından denenmelidir. Parola/session/auth/deploy davranışı değişmedi; production veya Cloudflare işlemi yoktur.

Bu dilimin son yerel gate'i:6 dosya39/39 PASS (`local-demo`, auth UI, TodayWork UI, müşteri notları UI, renewal workspace UI, task-statistics UI). Yeni entegrasyon testi gerçek canonical scrypt login ile üç hesabı, her çalışanın farklı beş görevini ve2/2/1 sayımını, ortak not yazarlarını ve OWNER ekip görünümünü doğruladı. Gerçek HTTPS listener'dan Vite HTML ve cookie'li login→me200, oturumsuz401 ve yabancı Host403 kontrol edildi. CLI bundle'ının doğrudan Node import'u3 hesap/openDemo export'u ile PASS. Lint/typecheck/format/client build/Worker yalnız dry-run/boundaries/diff-check PASS. Mevcut client chunk510,18kB ve Wrangler environment uyarıları sürer. Browser'da manuel sertifika onayı veya gerçek Windows CMD'de insanın gizli parola girişini otomasyonla yapılmış saymıyoruz; güvenli masked prompt kullanıcı çalıştırmasında kalır.

Gerçek yerel D1 + canonical password login + HTTPS listener smoke testi; iki çalışanın ortak müşteri/not, private task/statistics, OWNER ekip görünümü, taslak teklif okumaları, yanlış parola/yabancı Host reddi ve FK kontrolü vardır. İlgili React login/TodayWork/not/renewal/statistics UI testleri ayrıca çalıştırılır. Browser sertifikasına manuel onay Windows politikalarına bağlıdır; otomatik testte yalnız o sentetik self-signed bağlantı için TLS istisnası kullanılır, uygulama veya sistem TLS ayarı gevşetilmez. Bu demo production kapasite/güvenlik/release, gerçek veri veya belge açılışı kabulü değildir.

Mevcut UYGULAMA_DURUMU.md kirli değişikliği bu işten bağımsızdır; değişmeden ve commit dışında korunmuştur. Bu dosya demo çalıştırma rehberi ve bu dilimin yerel kullanım kaydıdır; yeni mimari plan değildir.
