# FRONTEND PHASE3B — modern poliçe oluşturma ve temel düzenleme

Başlangıç `128fb6dd0c1bbb3dee719df99506d28b6f0f9ee6`. Bu uygulama/kanıt kaydıdır; mimari otorite nihai plan12/18 bölümleridir. Kullanıcının önceden kirli `UYGULAMA_DURUMU.md` dosyası byte düzeyinde korunur ve commit dışında kalır.

## Modern iş akışları

- `/policies/new` ve `/policies/:policyId/edit` mevcut AppShell'de lazy tam sayfalardır. Ortak PolicyForm ve küçük policy-form-model client validation/field-diff/decimal helper'ları create/edit'i birleştirir; server business logic veya authorization yeniden yazılmaz.
- Mevcut DTO/API alanları: create customer; insurer/branch/product/payment; policy number; canonical contract dates; gross premium/ISO currency; destekleyen ödeme yönteminde taksit sayısı; ACTIVE/CANCELLED/VOIDED. Sigortacı/branş değişince ürün açıkça sıfırlanır, yalnız eşleşen selectable ürünler sunulur. Desteklemeyen yönteme açık geçişte taksit null olur; destekleyen yöntemde2–min(36,maxInstallments) zorunludur.
- Edit'te exact authorized policy okunmadan alanlar mount edilmez. Müşteri bağı değiştirilemez. Historical inactive katalog option'ları isimleriyle tutulur; ilk aktif seçenek kendiliğinden atanmaz. İlgisiz temel edit, inactive katalog/taksit alanlarını payload'a koymaz. Katalog/taksit değişirse server'ın mevcut selectable combination koşulları client yardımında da kontrol edilir; nihai otorite server'dır.
- Premium canonical noktalı decimal (1234.56), en fazla2 basamak, binlik ayırıcı/negatif yok. Safe-integer minor sınırı BigInt ile doğrulanır, edit minor→decimal string kayıpsızdır. Özet karşılaştırma sonrası gerçekten yazılacak merge sonucunu gösterir. Her kayıt bir sözleşme dönemidir; eski dönemin üzerine yenileme yazılmaması açıkça anlatılır. Frontend otomatik renewal yoktur; mevcut POST sonrası server ensureRenewal davranışı değişmez.

## Customer handoff

Modern customer profile'daki “Poliçe ekle” → `/policies/new?customerId=<id>`; URL'de isim/identity/form body yok. Origin exact customer GET ile authorize edilir, ilk20 seçenek dışında olsa bile dedicated selected option ve doğru customer association korunur. Başka müşteri kendiliğinden seçilmez. Origin denied/archived ise form mount edilmez ve protected detail gösterilmez. Genel müşteri araması server-side limit20; kullanıcı explicit seçim yapar, detay GET tekrar kontrol eder. Müşteriyi açık değiştirmek taslağı sıfırlar; pending/busy/readback/conflict sırasında seçim kilitlidir. Yeni body/key veya draft browser storage'a yazılmaz.

Eski advanced +Poliçe Ekle handoff ve `/policies/legacy?customerId=...` korunur. Legacy create/edit silinmedi. Modern policy list yeni oluşturma, detail açık edit bağlantısı sunar; arşivli policy'de edit link/form yoktur.

## Mutation güvenliği

- POST/PATCH mevcut API, CSRF ve immutable URL/method/body/key snapshot'ıyla çalışır. Çift submit ref ile engellenir. Belirsiz ağ/5xx/429/bozuk success yanıtında form kilitlenir; yalnız exact retry. Bu garanti mevcut mount ömründedir; belirsiz sonuçta sayfayı yenilemek yerine retry kullanılmalıdır. Durable browser persistence eklenmedi.
- Edit yalnız orijinal authorized baseline'a göre değişen alanları ve expectedVersion'ı gönderir.409 draft'ı korur; explicit current-policy+catalog refresh, comparison snapshot/version ve yeniden onay zorunludur. Dokunulmamış alanlar başka kullanıcının değerlerini ezmez. Comparison sonrasında effective final sözleşme tarih/para/katalog validation'ı uygulanır. Yeniden concurrent değişiklik yine CAS'a takılır.
- Başarılı POST/PATCH sonrasında exact policy authorized GET readback'i doğrulanır, ardından modern detail'a gidilir. Write200 fakat readback başarısızsa yalnız GET retry; ikinci mutation yok. Generic create409 başka key ile tekrar create'a çevrilmez, liste kontrolü istenir.
  -401 session cleanup,403/404 kilit/korunan edit alanlarının kaldırılması ve canonical errors. Policy-ID/customer-ID keyed mount ve generation geç mutation/navigation/callback etkisini keser; scoped AbortController late readback401'in başka policy'yi kapatmasını önler.
- CSRF helper'ına backward-compatible optional AbortSignal eklendi. Mevcut callers'ın argumentsiz davranışı aynı; yeni form unmount sonrası CSRF yanıtından token cache/session-ended side effect'i üretmez. Bu iki late401 kusuru UI RED testleriyle görülüp client'ta kapatıldı; auth endpoint/cookie/server modeli değişmedi.

## Doğrulama

- Son odaklı gate:7 dosya90/90 PASS — yeni forms UI/API, modern policy pages, legacy policy mutations UI, customer pages, AppShell ve CSRF kullanan customer-create UI. Büyük tarihsel suite veya agent/review zinciri yoktur.
- Gerçek localD1/API7 test: OWNER/Ahmet/Ayşe individual/company creation; taksitli/taksitsiz ve canonical minor/currency; create exact replay ve tek renewal initialization; field-only PATCH/association/stale409/exact replay/evidence değişmezliği; invalid premium/overflow/currency/catalog/installment rejection; inactive product'la ilgisiz edit ve MAX_SAFE_INTEGER premium; archived policy/customer rejection; foreign404/ungranted403/revoked401; OWNER dahil explicit sensitive permission olmadan HEALTH create/edit/read403 ve başarılı evidence değişmezliği. Kapsam dışı backend düzeltmesi gerektiren kusur gösterilmedi.
- UI: handoff outside first20, bounded search/explicit selection, dependencies/installment validation, field-only PATCH, double submit, POST/PATCH lost response exact snapshot, write-success/readback-failure GET-only retry,409 draft/current snapshot/field-only merge/summary, historical inactive refs, denied/archived forms, duplicate create409 lock, late CSRF/mutation/readback/401 navigation suppression.
- Gerçek installed Edge disposable demo+canonical login PASS: üç kullanıcı için individual ve company modern create (peşin TRY ve taksitli EUR), selected origin outside first20, POST commit201→simulated503→exact replay, PATCH commit200→503→exact replay, gerçek başka oturum PATCH→409→comparison→changed-only resend, PATCH200/readback503→yalnız GET, authorized readback/navigation, edit direct refresh,1440/768/360 overflow, modern list/detail, customer link ve back/forward; legacy handoff seçim; canlı revoked edit→login/protected fields cleanup/no new write; CSP/runtime0 failure.
- İlk Edge setup denemeleri fixture timestamp CHECK'e takıldı: sentetik customer.created_at default updated_at'tan gelecekteydi. Fixture'a eşleşen ordered updated_at eklendi; DB constraint veya assertion gevşetilmedi. Sonra tam tur PASS. Raw credentials/errors loglanmadı.
- Typecheck/lint/format/build(client+Worker dry-run)/boundaries PASS. Worker dry-run mevcut multi-environment selection uyarısını korur; deploy değildir. Yeni dependency yok. Backend/shared DTO/migration/trigger/scripts/demo credential protocol değişmedi; Cloudflare/prod/Paid/gerçek veri/belge aktivasyonu yapılmadı.

## Kalan kapsam ve demo

Atama, insured/beneficiary mutations, zeyiller, dış referanslar, arşivleme, sensitive identity-variant secure confirmation ve eski belge kapıları klasik çalışma alanındadır. Private R2/document viewer aktive edilmedi. Legacy create/edit de regression/backstop olarak kalır.

`npm run demo`; maskeli PowerShell girişi takılırsa yalnız sentetik demo için `npm run demo -- --visible-input` (parola terminalde görünür). https://localhost:8443 → Poliçeler → Yeni poliçe; veya müşteri profilinde Poliçe ekle. Detail'da Poliçeyi düzenle. Sadece sentetik parolaları yerel prompt'a girin; ayrıntılar `LOCAL_DEMO_TR.md`. Açık uygulama blocker'ı yoktur; production release veya belge kabulü değildir.
