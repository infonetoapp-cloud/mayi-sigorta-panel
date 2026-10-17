# FRONTEND PHASE2B — müşteri oluşturma ve günlük iletişim düzenleme

Başlangıç HEAD `b2a530f9ce7694a872feb59e7ba5ed2b2611e197` ve yarım kalmış çalışma ağacı korunarak devam edildi. Bu dosya uygulama kanıtıdır; mimari otorite nihai plan12/18 bölümleridir. Kullanıcının talimatıyla önceden kirli UYGULAMA_DURUMU.md byte düzeyinde aynen korunur/commit edilmez.

## Modern günlük işlemler

- `/customers/new` gerçek full-page form: bireysel ad/soyad veya kurumsal unvan; isteğe bağlı email/telefon/adres. Mevcut server field sınırlarıyla Türkçe inline validation; shadcn Button/Input ve merkezi token stilleri. Kimlik/sağlık/assignee/agency alanı gönderilmez. API otoritesi sunucudadır; client validation izin yerine geçmez.
- Başarılı canonical create yanıtından sonra yeni kaydın modern profiline `replace` navigasyon yapılır. Form POST+CSRF+idempotency protokolünü korur. Belirsiz yanıt/5xx durumunda form kilitlenir; aynı serialized body ve key ile açık retry vardır. Aynı anda çift submit ref ile engellenir. Kesin validation retleri taslağı korur;403/404/409 yeni mutasyon gönderimini kilitler.409'da yeni kayıt göndermeden listeyi kontrol etme mesajı vardır. Ham server hata metni kullanıcıya basılmaz.
- Retry güvenliği mevcut sayfa/işlem ömründedir; browser refresh/yeni form açma sonrası durable taslak/key persistence eklenmedi. Belirsiz işlemde sayfayı yenilemek yerine retry kullanın. Alan/anahtarlar localStorage/sessionStorage'a yazılmaz. Unmount sonrası geç yanıt yeni sayfayı yönlendirmez.
- Profil İletişim bölümünde açık “Düzenle” aksiyonu; mevcut CustomerContactSection aynen CAS/version, field-only PATCH, exact retry, conflict karşılaştırma, taslak koruma ve confirmed readback mantığıyla yeniden kullanılır. Başarı ancak gerçek güncel detail okumasından sonra header/alanlara yansır ve açık onay mesajı görünür. Arşivli kayıtta edit aksiyonu yoktur.
- CSRF endpoint'i401 ile iptal edilmiş oturumu keşfederse mevcut session-ended olayı ve memory-only token invalidation çalışır; bu eksiklik önce RED testinde gösterildi. Auth/cookie/backend izin protokolü değiştirilmez.

## Şirket yetkilileri ve legacy kapsamı

Mevcut company-contact oluşturma, birincil yapma ve pasifleştirme kodu App içindeki ayrı request snapshot/CAS/idempotency akışlarına bağlıdır; contact.update API'si de ayrı sürüm kuralları taşır. Yalnız form taşımak eksik bir substitute yaratacağı için bu fazda yeniden uygulanmadı. Modern İletişim bölümü yetkili listesini ve açık “klasik şirket yetkilisi işlemleri” bağlantısını gösterir. Tam şirket yetkilisi mutasyon migrasyonu sonraki ayrı dilimdir.

Atama, arşivleme, hassas kimlik, dış referanslar ve müşteri→poliçe hand-off `/customers/:id/advanced` ve `/customers/legacy` üzerinden korunur. Mevcut legacy create formu klasik çalışma alanında kalır ama normal Yeni Müşteri bağlantısı artık modern formdur. Günlük görev/poliçe/yenileme/personel/ayar/katalog modernizasyonu yoktur.

## Açıkça yetkilendirilen dar backend düzeltmesi

Yarım kalmış test gerçek yerel D1/API'de güncel expectedVersion ile arşivli müşteriye PATCH200 üretti. Kök neden `customer.update` executor'ının UPDATE koşulunun yalnız id+agency+version kontrol etmesiydi; UI edit'i kapatsa da sunucu lifecycle kapısı yoktu.

Tek production backend değişikliği mevcut statement'ın WHERE koşuluna `AND archived_at IS NULL` eklemektir. Yeni update atomik DB koşulunda0satır etkilerse var olan changes()/CAS assertion'ı aynı D1 batch'ini receipt/business/audit dahil ROLLBACK eder ve mevcut409 optimistic-concurrency yanıtı döner. Ön service check'e güvenilmez. Yetkisiz/foreign kayıt mevcut non-disclosure404 kapısında kalır.

Completed receipt replay yolu değiştirilmez: gerçek önceki işlem mevcut canlı actor/permission/scope kontrolünden sonra historical DTO'yu döndürebilir; arşivli kayda yeniden UPDATE yapmaz. Yetki iptal edilirse aynı eski key replay'i reddedilir. Yetkili archived GET geçmişi200 kalır. Migration, schema veya yeni auth mimarisi yoktur.

## Odaklı kanıt

- Yeni gerçek yerel D1/API4/4 PASS: iki tip create+exact replay/changed-payload409; active PATCH/stale409; latest-version archived409; customer/evidence readback değişmezliği; receipt/audit0 rollback; archive sonrası historical replay200/evidence1; canlı grant iptali sonrası denial; cross-agency GET/PATCH404; archived read200; unauthorized create403 ve authority mass-assignment400.
- Race testi PATCH'i tüm preflight'lardan sonra gerçek `db.batch` önünde bariyerle tutar; başka gerçek API archive işlemi commit eder, sonra PATCH serbest bırakılır. PATCH409 ve customer/receipt/audit snapshot değişmezliği doğrulanır; Promise.all ile sahte sequential yarış iddia edilmez.
- Mevcut sealed executor paketi13/13 PASS. İlk koşu11PASS/2FAIL: fixture yalnız0000–0004 şemasını uyguladığı için yeni WHERE archived_at kolonunu bulamadı. Fixture mevcut tarihsel migration0005–0008'i de uygulayacak şekilde güncellendi; assertion gevşetilmedi, SQL/migration dosyaları değiştirilmedi.
  -6 odaklı UI dosyası47/47 PASS: create5, customer-pages12, mevcut contact-edit11, notes4, app-shell7, auth8. Validation/no POST, exact body/key replay, şirket payload'ında gizli individual alanlarının yokluğu, generic409, geç response suppression, CSRF401 session-end, modern inline success/header readback ve archived edit yokluğu; mevcut contact conflict/retry/stale-customer güvenceleri korunur.
- Gerçek installed Edge + disposable D1/canonical login PASS: OWNER/Ahmet/Ayşe her biri bireysel ve şirket kaydı oluşturdu ve modern profilde iletişim düzenledi.1440/768/360 layout; new-page direct refresh; kayıp create yanıtı simülasyonunda önce gerçek server commit201 ardından client503 ve exact retry; gerçek bağımsız PATCH ile CAS conflict→draft korunumu→güncel veriyi karşılaştırıp save. Not/list/profile/history/policy hand-off/private tasks/personnel denial/logout/live session revoke regresyonları PASS. Raw credential/error log yoktur.
- Son lint/typecheck/format/build(client + Worker yalnız dry-run)/security-boundaries/diff-check PASS. Yeni dependency yok. Son client index318.79kB/gzip101.51; create5.34kB, profile9.31kB; App253.57kB lazy. Shared contact/create error imports mevcut App'a bağlı olduğundan legacy chunk modern customer operation sırasında da yüklenebilir; dependency-graph refactor bu faza eklenmedi. En büyük chunk500kB altında. Wrangler environment-selection dry-run uyarısı sürer.
- Tek dar bağımsız backend lifecycle incelemesi PASS: hedef `customer.update` değişikliğinde0BLOCKER/0IMPORTANT. Reviewer aynı4D1/API testini `--no-cache` ile bağımsız çalıştırdı:4/4PASS. Bu tekrar ayrı yeni test sayılmaz; toplam benzersiz odaklı test64(47UI+13executor+4API). İnceleme zinciri yoktur.

## Ayrı kalan IMPORTANT: kardeş archived-parent mutasyonları

Reviewer'ın statik kaynak bulgusu, yeni guard'ın regresyonu veya ayrıca çalıştırılmış exploit kanıtı değildir. Bu dar PASS tüm müşteri mutasyonlarının lifecycle kabulü sayılmaz:

- `company_contact.create/update/set_primary/deactivate`: servis ve atomik SQL'de parent arşiv koşulu eksik (`customer-domain-executor.ts:1047–1300,1877–1896`). Parent archive child version'ı artırmadığından child CAS tek başına bu yarışı korumaz. Tam şirket-yetkilisi migrasyonundan önce ayrı focused lifecycle düzeltmesi gerekir.
- `customer.identity.update`: executor `:1371` ve service `:1284–1434` arşiv koşulu içermez.
- `customer.external_reference.create`: executor `:1558–1568` ve service `:1794–1825` arşiv koşulu içermez. Mevcut parent/type DB trigger'ları bu lifecycle açığını kapatmaz.
- Assign ayrı değerlendirilir: service `:1564–1568` archived atamayı reddeder; normal archive yarışı version/CAS'a takılır. Executor `:1450` ayrıca archived predicate taşımaz ama mevcut HTTP bypass kanıtı olarak sunulmaz.

Kullanıcının “bağımsız gap'leri raporla, sessizce kapsam genişletme” talimatıyla bu yollar değiştirilmedi. Legacy'de erişilebilir olmaları güvenlik/lifecycle tam kabulü değildir; sonraki dar güvenlik dilimi olarak ele alınmalıdır. Mevcut yerel frontend ve yalnız customer.update guard kabulünün dışında kalır; production release onayı verilmez.

## Yerel önizleme

PowerShell:

```powershell
Set-Location C:\Users\sinan\Desktop\panel
npm run demo
```

Maskeli prompt terminalinizde takılırsa Ctrl+C ve `npm run demo -- --visible-input`. Visible modda yalnız sentetik demo parolaları kullanın; terminalde görünürler. Hazır mesajından sonra https://localhost:8443/customers/new açın. OWNER/Ahmet/Ayşe hesapları ve credential/HTTPS/izolasyon yönergesi LOCAL_DEMO_TR.md'dedir. Önceden dependency kurulmamışsa `npm ci`; Node24/OpenSSL gerekir. Ctrl+C geçici demoyu kapatır.

## Sınırlar

Önceden kirli durum belgesi SHA256: `f272a14efce57f2ef47d960c2ac387e11cdaeda96aa6fda71db8585844e28930`; değişmeden commit dışında kalır. Production deploy/Cloudflare mutation/migration/Paid/gerçek veri/document activation yoktur. Mevcut production/Free-capacity/document NO-GO ve dev-chain audit borcu bu yerel frontend kabulüyle kapanmaz.
