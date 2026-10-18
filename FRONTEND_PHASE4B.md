# Frontend Phase4B — modern yenileme iletişimi

Taban: `b0283c3fb69bc8e6adcff4820fd3fec6645871ce`. Mimari otorite nihai plan bölüm12/18'dir. Korunan kirli `UYGULAMA_DURUMU.md` bu işe dahil değildir.

## Kapsam ve otorite

- Modern `/today-work` seçili authorized task DTO'sunun renewalId'siyle küçük ayrı `RenewalInteractionsSection` açar. Sahte task GET veya URL'de protected payload yoktur. GET interactions bağımsız izin otoritesidir; quote/personnel endpoint'i çağrılmaz.
- Kompakt geçmiş outcome/channel, API tarihleri Europe/Istanbul, mevcut author ve izinli notu gösterir. Eksik tarih/yazar türetilmez. Son temas/deneme doğrudan GET'ten gelir. Company seçenekleri aynı authorized response'tandır.
- Yeni inline form CONTACT_CONFIRMED/ATTEMPT_NO_RESPONSE/NOTE destekler; beş mevcut kanal vardır. NOTE yalnız OTHER+dolu trim sonrası≤1000 not; diğerlerinde note:null. INDIVIDUAL contact:null; COMPANY açık etkin seçenek zorunludur. Eski/pasif seçim otomatik değiştirilmez.
- Gerçek temas için ayrı açık doğrulama vardır. Yanıtsız arama, not veya WhatsApp işlemi gerçek temas kanıtı değildir. Generic form WHATSAPP_OPENED sunmaz; mesaj göndermez/WhatsApp açmaz. Bu protokol legacy'de kalır.
- Kullanıcı İstanbul yerel tarihini görür/düzenler; UTC canonical occurrence üretilir. Geçersiz gün/dönüşüm ve tek anlamlı olmayan tarih reddedilir; eksik tarih tahmin edilmez. İlk yeni form zamanı yalnız kullanıcıya düzenlenebilir başlangıçtır; submit/retry mevcut draft tarihini kullanır.

## Yazım, readback ve izolasyon

- Explicit submit, synchronous duplicate lock, mevcut CSRF/session/error helper'ları. expectedVersion icat edilmez. Bellekte attempt tam URL/method/serialized body/key taşır. Network/5xx/429/408 veya güvenilmez başarı envelope'u aynı attempt'i dondurur; yalnız exact retry mümkündür.
- Başarılı POST ardından authorized GET içinde dönen interactionId ve tüm gönderilmiş alanların eşleşmesi görülmeden başarı onayı yoktur. GET başarısızsa yalnız GET retry; ikinci POST yoktur.
- Validation draft'ı korur; 403/404 protected data'yı gizler ve authorized refresh zorunlu kılar.409 draft korur, güncel history/contacts okunur ve explicit reconfirm/new submit gerekir. Contact stale ise placeholder korunur, yeni kişi otomatik seçilmez.
- Seçili task/queue/session/authority değişiminde keyed remount, read AbortController+generation ve operation epoch eski yanıtı bırakır. CSRF de abort-aware'dır. Gönderilmiş POST sunucuda iptal edilmiş gibi gösterilmez. Aynı ekran içindeki task/queue/legacy ayrılışı risk varsa açık uyarı/onay ister; browser unload standart uyarısı vardır. Başka route/session unmount bellek state'ini bırakır; dönüşte önce yetkili geçmiş kontrol edilmelidir.
- Taslak, body, anahtar ve protected data browser storage'a yazılmaz. İletişim bölümü kapanınca draft/key kalıcı olmaz; belirsiz işlemin iptali veya yeni oturumdan exact retry garantisi verilmez.

## Doğrulama kaydı

- Yeni gerçek local D1/API dosyası izin/quote bağımsızlığı, üç outcome, clock fields, generic WHATSAPP_OPENED reddi, şirket seçimi/stale contact, exact receipt replay/evidence ve HEALTH/foreign/revocation senaryolarını içerir.
- Yeni UI21 testi ve Phase4A UI18 testi ilk odaklı turda39/39 PASS; API dosyası ayrı PASS. API'nin ilk fixture denemesinde permission restore/scope ve replay status beklentileri düzeltildi; backend patch yapılmadı.
- İlk11 dosyalı konsolide tur220s süreç zaman aşımında durdu; PASS sayılmadı. Uzatılmış aynı paket11 dosya129/129 PASS (284.81s): modern interaction API/UI, Phase4A API/UI, task statistics API/UI, legacy TodayWork/reassignment/interaction history/quotes/WhatsApp UI. Son runtime web API düzeltmesinden sonra modern interaction+Phase4A UI39/39 tekrar PASS.
- İlk build sınırı `window`/`globalThis` alias kullanımını reddetti. Mevcut sınır sözleşmesi doğrudan web API isimleri istediğinden `addEventListener`/`removeEventListener` kullanıldı; sınır gevşetilmedi.
- Son gerçek Edge turu exit0 PASS: OWNER/Ahmet/Ayşe1440/768/360; gerçek contact/attempt/note ve server clock alanları, lost committed-response exact retry/tek kayıt, write sonrası GET failure GET-only, bağımsız403 cleanup, company explicit contact/stale409/reconfirm, mobile form/draft ayrılış, no quote calls/no browser storage;4A independent cursor/exact retry/statistics/owner-only/reload/back-forward/revocation/CSP/runtime. Önceki ilk Edge turu owner revocation aşamasında FAIL verdi; teşhis yalnız güvenli stage/category işaretleri ekledi, sonraki tam tur owner ve iki member tüm cleanup/runtime aşamalarını geçti. Başarısızlık kaydı korunur.
- Typecheck, ESLint, değişen dosyalarda Prettier, git diff-check ve client build/Worker yalnız dry-run/security boundaries PASS. Wrangler mevcut environment-selection uyarısı vardır; deploy yapılmadı. Korunan durum dosyası SHA256 `f272a14efce57f2ef47d960c2ac387e11cdaeda96aa6fda71db8585844e28930` aynıdır.
- Tek bağımsız salt-okunur inceleme `deleg_5533456c`: PASS, security_concerns/logic_errors boş; reviewer modern UI21/21 bağımsız PASS. Önerilen mismatched ID veya note içeren GET200 readback negatifleri kalıcı teste eklendi; son modern UI23 + Phase4A UI18 =41/41 PASS; typecheck/lint tekrar PASS. Yeni reviewer zinciri veya backend patch yoktur.

## Ertelenen işlevler

`TodayWorkPanel` ve `RenewalWorkspacePanel` değişmedi. Task completion/replacement, assignment, quote/version/status, WhatsApp preview/open/manual-send ve WON/LOST/VOIDED modernleştirilmedi; `/today-work/legacy` arkasında korunur. Task statistics sözleşmesi değişmez.

Production deploy, Cloudflare değişikliği, migration, ücretli servis, gerçek veri, R2/document activation veya backend business-rule değişikliği yoktur.
