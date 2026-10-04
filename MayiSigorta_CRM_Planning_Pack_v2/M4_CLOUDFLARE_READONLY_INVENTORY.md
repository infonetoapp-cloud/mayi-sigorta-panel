# M4 — Cloudflare salt-okunur keşif ve credential doğrulaması

Gözlem: **4 Ekim 2026 21:49 UTC** (5 Ekim Türkiye). Başlangıç: temiz `main`, `HEAD == origin/main == 94504b470df2ce2eee9c92b5a264d88dc5ecc36c`; fetch ve diff-check başarılı.

**M4 COMPLETE=false; DOCUMENTS_ENABLED=false; M5 başlamadı.** Bu kayıt provisioning, deployment, gerçek veri kullanımı veya belge aktivasyonu onayı değildir.

## Credential ve hesap

- Credential bulundu: **YES**. Tür: **Global API Key + email**, scoped API token değil. `/user` ve `/accounts` GET: HTTP 200, `success=true`; authentication valid: **YES**. Credential/token exposed: **NO**.
- Credential yalnız süreç belleğinde okunup resmî `https://api.cloudflare.com/client/v4/` endpoint'lerine HTTPS header üzerinden kullanıldı. Komut argümanına, repo dosyasına veya loga yazılmadı; redirect takip edilmedi. Credential dosya yolu, email ve secret değerleri bu kayıtta tutulmaz.
- Hesap listesi toplam **1**, tek sayfa ve tamamı okunmuş. `mayisigorta.com` aktif zone'unun account ID'si bu hesapla birebir eşleşiyor. Bu, projeyle ilişkiyi kanıtlar; şirketin hukukî hesap sahipliği teyidi değildir. Hesap/resource ID ve kişisel hesap adı git kanıtı için gerekli olmadığından burada tutulmaz.
- `/user`: `two_factor_authentication_enabled=false`, `two_factor_authentication_locked=false`. Hesap ayrıntısı: `enforce_twofactor=false`. Bunlar yönetici MFA metaverisidir; CRM Access MFA ile aynı kontrol değildir.
- Global API Key için scoped token permission belgesi uygulanamaz. Global key'nin geniş kapsamı resmî legacy-key dokümanında açıklanır; bu keşif hiçbir write/delete yetkisini denemedi. Yerel no-delete interface gerçek IAM kanıtı değildir.

## Gerçek GET sonuçları

`{account_id}` ve `{zone_id}` doğrulanmış hedeflerin yer tutucularıdır. Boş başarılı listeler ile ürün/plan engelleri ayrı sınıflandırılır.

| Alan | GET yolu / kapsam | Gerçek sonuç | Kanıt sınırı |
| --- | --- | --- | --- |
| Kimlik | `/user` | 200 / success | Credential geçerli; yönetici MFA kapalı |
| Hesap | `/accounts`, `/accounts/{account_id}` | 200 / success; 1 görünür hesap | Ayrı backup hesabı görünmüyor; başka credential altındaki hesapların yokluğu kanıtlanmaz |
| Zone | `/zones?name=mayisigorta.com` | 200 / success; 1 aktif eşleşme | Hesap ilişkisi kesin; plan `Free Website` |
| Workers | `/accounts/{account_id}/workers/scripts` | 200 / success; boş liste | Yüklenmiş Worker script yok; deployment metaverisi okunacak kaynak yok |
| Workers beta | `/accounts/{account_id}/workers/workers` | 200 / success; total_count=0 | Yeni Worker listesi de boş |
| D1 | `/accounts/{account_id}/d1/database` | 200 / success; total_count=0 | Remote D1 yok; DB jurisdiction/location metaverisi yok; SQL/customer sorgusu yapılmadı |
| Queues | `/accounts/{account_id}/queues` | 200 / success; total_count=0 | Remote Queue yok; repo zincirindeki beş queue da yok |
| R2 default | `/accounts/{account_id}/r2/buckets` | 403 / error 10042: R2 Dashboard üzerinden etkinleştirilmeli | Başarılı boş liste değil; bucket yokluğu iddiası kurulmaz |
| R2 EU | Aynı liste, resmî `cf-r2-jurisdiction=eu` header | 403 / error 10042 | EU bucket/region/private/domain/lock metaverisi okunamadı |
| Containers | `/accounts/{account_id}/containers/applications` | 401 / error 1000: Containers erişimi yok; Workers Paid gerekli | Credential genel olarak geçerli; bu ürün plan/entitlement kapısıyla engelli. Boş container listesi değildir |
| Access account | `/accounts/{account_id}/access/apps` | 403 / error 9999: `access.api.error.not_enabled` | Access etkin değil; app/audience/policy/MFA metaverisi okunamadı |
| Access zone | `/zones/{zone_id}/access/apps` | Aynı 403 / 9999 / not_enabled | Account sonucuyla tutarlı; app yokluğu başarılı listeyle kanıtlanmadı |
| Access organization | `/accounts/{account_id}/access/organizations` | Aynı 403 / 9999 / not_enabled | Team domain/global session/MFA konfigürasyonu okunamadı |
| Worker custom domains | `/accounts/{account_id}/workers/domains` | 200 / success; total_count=0 | Worker custom domain yok |
| Worker routes | `/zones/{zone_id}/workers/routes` | 200 / success; boş liste | Zone Worker route yok |
| Panel DNS | `/zones/{zone_id}/dns_records?name=panel.mayisigorta.com` | 200 / success; total_count=0 | Yalnız exact panel hostname okundu; PHP/MX/diğer DNS kayıtları incelenmedi |
| Worker account settings | `/accounts/{account_id}/workers/account-settings` | 200 / success; default_usage_model=standard | Bu değer Workers Paid abonelik kanıtı değildir |
| Abonelik | `/accounts/{account_id}/subscriptions` | 200 / success; tek kayıt: `Cloudflare Free Plan`, scope=zone | API'nin `state=Paid` değeri Workers Paid ürünü anlamına gelmez; Workers Paid kaydı görülmedi |
| Entitlements | `/accounts/{account_id}/entitlements` | 200 / success | Container kullanılabilirliğini kanıtlayan entitlement görülmedi; belirleyici blocker Containers API'nin açık plan hatasıdır |

Liste toplamları Python ile denetlendi; account/zone/D1/Queue/Worker-beta/custom-domain/panel-DNS pagination sınırları tamam. Script/route endpoint'leri boş sonuç döndü. R2/Access/Container hata yanıtları envanterin tamamı okunmuş gibi sunulmaz.

## Repo ile karşılaştırma

Otorite: nihai plan 5, 10, 14.1, 15 ve Faz 4; dış kabul sınırı `M4_LOCAL_CLOSEOUT_EVIDENCE.md`, `M4_EXTERNAL_CLAMAV_EVIDENCE.md`, Queue operations note ve güncel uygulama durumu.

`wrangler.jsonc`: `mayisigorta-crm`, `DOCUMENTS_ENABLED=false`; local placeholder D1 ID, `mayisigorta-documents-quarantine` ve beş aşamalı Queue zinciri. R2 EU jurisdiction, gerçek account/remote D1, Container/Durable Object scanner, backup hesabı veya Access audiences bu dosyada kurulmuş değildir. Local config remote kaynak varlığını kanıtlamaz. Gerçek Windows ClamAV/EICAR kanıtı geçerlidir; Worker/Container entegrasyonu yerine geçmez.

## M4 gap matrisi

`MISSING` yalnız başarılı boş listeler veya açık false konfigürasyon için kullanılır. `PERMISSION INSUFFICIENT` ürün/plan erişim engelini de kapsar; scoped token yetkisi eksikliği diye yorumlanmaz. `NOT YET VERIFIED` okunamayan veya bu metadata keşfiyle kanıtlanamayan kontroldür. Hiçbir hata resource yokluğuna çevrilmez.

| M4 gereksinimi | Durum | Gerçek kanıt / kalan boşluk | Gelecekte mutation gerekir mi? |
| --- | --- | --- | --- |
| Ana hesap/project ilişkisi | EXISTS AND READ-PROVEN | Aktif mayisigorta.com zone aynı görünür hesaba bağlı | Hayır; hukukî sahiplik ayrı teyit |
| Yönetici MFA güvenlik temeli | MISSING | Kullanıcı MFA ve hesap MFA zorunluluğu false | Evet; kullanıcı kurulumu ve hesap zorunluluğu, ayrıca onayla |
| CRM Worker | MISSING | Her iki Worker listesi boş | Evet; güvenli staging önkoşulları sonrası |
| Remote D1 | MISSING | Liste total_count=0 | Evet; ortam ayrımı ve production EU jurisdiction ile |
| Private primary R2 | NOT YET VERIFIED | R2 etkinleştirme engeli; başarılı bucket listesi alınamadı | En az ürün aktivasyonu; bucket oluşturma/config gereği sonra okunarak kesinleştirilir |
| R2 public domain/r2.dev kapalı | NOT YET VERIFIED | Bucket erişimi engelli; public-domain metadata çağrısı için gerçek hedef yok | Mevcut ayara bağlı; private kabulü zorunlu |
| Queue ve DLQ/overflow/terminal/hold | MISSING | Hesapta queue yok | Evet; beş kaynak, consumer sınırları, 14 günlük hold ve alarm/replay kabulü |
| Gerçek ClamAV Container/private binding | PERMISSION INSUFFICIENT | Workers Paid plan kapısı; kaynak listelenemedi | Plan onayı ve sonraki scanner deploy/binding gerekecek; burada yapılmadı |
| Scanner digest/egress/concurrency/CPU/memory/temp-cleanup | NOT YET VERIFIED | Runtime yokluğu/plan engeli; yerel motor kanıtı bu kontrolleri kapatmaz | Kurulum ve kontrollü sentetik runtime doğrulaması gerekir |
| Ayrı backup account/EU R2 | NOT YET VERIFIED | Yalnız 1 hesap görünür; R2 liste erişimi engelli | Hesap/bucket kimliği teyit edilmeden create kararı verilmez |
| Backup no-delete IAM sınırı | NOT YET VERIFIED | Kullanılan credential Global API Key; ayrı runtime backup yetkisi incelenemedi | Ayrı yetki sınırı kurulmalı veya mevcut sınır kanıtlanmalı |
| Backup 35 gün lock/export retention | NOT YET VERIFIED | Okunabilir backup bucket/lock yok | Mevcut ayara bağlı; sonra readback zorunlu |
| D1/R2/backup EU jurisdiction | NOT YET VERIFIED | D1 yok; R2 EU liste engelli; backup erişimi yok | Remote kaynak kurulum/teyidi gerekir; location hint yeterli değil |
| Normal Access app / 8h audience | NOT YET VERIFIED | Access not_enabled; app/policy okunamadı | Access activation ve normal app kurulumu/teyidi gerekir |
| Secure Access app / ayrı audience / 15m | NOT YET VERIFIED | Access not_enabled; ayrı audience kanıtı yok | Ayrı secure app kurulumu/teyidi gerekir |
| OTP + bağımsız TOTP / her-login MFA / bypass kapalı | NOT YET VERIFIED | Access policy/MFA okunamıyor; gerçek login denenmedi | Konfigürasyon ve gerçek sentetik staging login kabulü gerekir |
| Exposure/publication kontrolleri | MISSING | Worker/domain/route/panel DNS yok | Korumayı önce kur; PHP/MX/zone-wide ayarlara dokunmadan daha sonra yayınla |
| Restore/recovery/RPO 1h/RTO 4h | NOT YET VERIFIED | Remote DB/storage/scanner/backup temelinin kanıtı yok; metadata tatbikat değildir | Saatlik export/manifest/keys ve ayrıca yetkili sentetik restore/publication sınaması gerekir |
| WhatsApp Business delivery/read servisi | NOT REQUIRED | Nihai plan manuel preview/open ve ayrı contact ister | Hayır |

## Sonraki tek güvenli dış adım

**Doğrulanmış ana Cloudflare hesabında yönetici MFA güvenlik temelini kurmak:** mevcut yönetici için MFA enrollment ve hesap üyeliğinde MFA zorunluluğu; ardından kullanıcı/account metadata readback'iyle doğrulamak. API şu anda ikisini de kapalı gösteriyor. Bu güvenlik önkoşulu, ücretli Workers/Container aktivasyonu, R2/backup ve korumalı Access staging provisioning'den önce gelir. Bu öneri mutation yetkisi değildir ve bu oturumda uygulanmadı; daha geniş credential talep edilmedi.

## Kapsam ve doğrulama

- Cloudflare'a yalnız belgelenmiş **GET** istekleri gönderildi; Wrangler kullanılmadı. Remote write, token/IAM oluşturma, plan satın alma, deploy, DNS/route/policy/secret değişimi, Queue publish/pull/ack/purge ve restore yok.
- D1 satırı/SQL, R2 nesne adı/içeriği veya müşteri belgesi okunmadı; ham API yanıtları repo'ya kaydedilmedi. Bucket-public-domain/lock ve Access policy çağrıları okunabilir hedef olmadan körlemesine denenmedi.
- Kaynak/test/schema/migration/Wrangler değişmedi; bu keşif için uygulama full suite'i yeniden çalıştırılmadı. Güvenli evidence/status dokümantasyonu için diff/whitespace ve secret-value/pattern kontrolleri checkpoint kapısıdır.
- Hermes skill/reference/asset authoring veya self-improvement yapılmadı. M5 başlamadı; belge modülü kapalı kaldı.

## Resmî API kaynakları

Güncel endpoint ve GET davranışları `developers.cloudflare.com` API reference üzerinden doğrulandı. HTML/fetch engellerinde aynı resmî sayfanın `index.md` gösterimi kullanıldı; başka kaynaktan endpoint uydurulmadı.

- [Global API Key semantiği](https://developers.cloudflare.com/fundamentals/api/get-started/keys/) ve [API authentication](https://developers.cloudflare.com/fundamentals/api/how-to/make-api-calls/).
- [Account API](https://developers.cloudflare.com/api/resources/accounts/), [User details](https://developers.cloudflare.com/api/resources/user/methods/get/), [Worker API](https://developers.cloudflare.com/api/resources/workers/).
- [D1 list](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/list/), [Queue list](https://developers.cloudflare.com/api/resources/queues/methods/list/).
- [R2 bucket list ve jurisdiction header](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/methods/list/index.md), [R2 data location](https://developers.cloudflare.com/r2/reference/data-location/), [r2.dev metadata](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/domains/subresources/managed/methods/list/), [bucket lock metadata](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/locks/methods/get/).
- [Containers list](https://developers.cloudflare.com/api/resources/containers/subresources/applications/methods/list/index.md), [Containers pricing/instance types](https://developers.cloudflare.com/containers/platform/pricing/).
- [Access apps](https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/applications/methods/list/), [Access organization](https://developers.cloudflare.com/api/resources/zero_trust/subresources/organizations/).
- [Worker domains](https://developers.cloudflare.com/api/resources/workers/subresources/domains/methods/list/), [Worker routes](https://developers.cloudflare.com/api/resources/workers/subresources/routes/methods/list/), [DNS metadata](https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/list/).
