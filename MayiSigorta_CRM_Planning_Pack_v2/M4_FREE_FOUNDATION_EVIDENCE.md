# M4 F-26 — Free-tier foundation ve R2 insan aksiyonu

Gözlem: 5 Ekim 2026; bağımsız GET readback sonrası kayıt. Accepted Phase 1 commit: `091621591240693a831c4b814915d91f7aa77719`; fresh GPT-6.1 Sol High reviewer `20261005_215639_24831e`: PASS / BLOCKER 0 / IMPORTANT 0 / OPTIONAL 1. Bu foundation kısmen tamamlandı; M4 tamamlanmadı.

## Doğrulanan hesap ve gerçek kaynaklar

Hedef account `af9fc98cb8d5f5508d58057bc794d863`, exact active `mayisigorta.com` zone/account ilişkisi GET ile doğrulandı. Mevcut administrative Global API Key yalnız yerel HTTP header'ında kullanıldı; değer/email/header source, docs, runtime veya reviewer prompt'una konmadı. Token migration/rotation yok. User MFA ve account `enforce_twofactor=true` yeniden read-proven.

| Kaynak | Gerçek sonuç / bağımsız readback |
| --- | --- |
| D1 | `mayisigorta-crm`, ID `1dd3b04e-14b8-459c-86d0-5c3c3ed8127d`; POST sonrası GET ve ayrı fresh verification GET: HTTP 200/success. `jurisdiction=eu`, `read_replication.mode=disabled`, created `2026-10-05T19:12:22.647Z`, initial file size 12288 bytes. Boş yeni DB; remote migration ve customer data yok. EU gerçek jurisdiction'dır, location hint değil. |
| Generic Queue | `mayisigorta-document-jobs`, ID `3c2b94a3ca204da28a9f9b884b0a1778`; POST, paused settings PUT, exact GET ve ayrı fresh GET: HTTP 200/success. `delivery_paused=true`, `delivery_delay=0`, `message_retention_period=86400`; producers=0, consumers=0. Mesaj publish/pull/ack yapılmadı. Scanner queue değil. |
| Queue jurisdiction | Resmî SDK EU alanı sunsa da bu account/control plane create body'deki `jurisdiction=eu` alanını HTTP 400/10026 `Could not parse request body` ile reddetti; bu Paid entitlement veya credential reddi diye sunulmaz. Önce target queue yokluğu tekrar GET ile doğrulandı, optional jurisdiction alanı çıkarılınca normal create geçti. GET jurisdiction alanı yok/null: Queue EU garantisi **YOK**. Queue opaque job ID/hash envelope taşır; binary/free text taşımaz; D1/R2 EU şartı değiştirilmedi. Worker global-processing değerlendirmesi dış kapı olarak kalır. |
| Primary R2 | EU-header bucket GET HTTP 403/10042: `Please enable R2 through the Cloudflare Dashboard.` Subscription checkout/ödeme insan aksiyonu bekliyor. Bucket **oluşturulmadı**; privacy/EU/r2.dev/domain/anonymous readback **NOT YET VERIFIED**. R2 write veya checkout kabulü yapılmadı. |
| Worker | GET scripts toplam 0; deploy/route/domain/secret yok. Free capability hedefleniyor; billing subscription GET'te yalnız zone `Cloudflare Free Plan` var, Workers Paid yok. Gerçek Worker binding/runtime proof henüz değil. |
| Containers / ücretli ürünler | Container create API çağrısı, Workers Paid/Zone Pro/paid Zero Trust/subscription write yok. Bu görevde aktivasyon/provisioning **NO**. |

İlk foundation komutu D1'i başarıyla oluşturdu, Queue EU-body 400 nedeniyle exit 1 döndü; bu kayıt saklandı. D1 rollback/delete veya tekrar yaratılmadı. Queue ayrı minimal-body oluşturuldu. Her başarılı yazı exact GET ve ikinci salt-okunur verification invocation ile doğrulandı; HTTP success tek başına kabul sayılmadı.

## Wrangler ve doğrulama sınırı

`wrangler.jsonc` root LOCAL synthetic DB/bucket ayarlarını korur; yeni `env.foundation` yalnız gerçek account/D1/Queue ID/name taşır. `DOCUMENTS_ENABLED=false`, `workers_dev=false`, `preview_urls=false`, cron=[], consumers=[], R2=[]; public domain veya scanner/container binding yok. Gerçek olmayan R2 binding foundation'a eklenmedi. Root local bucket için çıkan non-inherited R2 warning **bilinçlidir**; production readiness kanıtı değildir.

- Güncel format check/lint/typecheck/boundaries ve `git diff --check`: PASS.
- `npx wrangler deploy --env foundation --dry-run`: PASS; binding output yalnız D1, generic Queue, static ASSETS, false DOCUMENTS_ENABLED. Remote deployment yok; Worker adı `mayisigorta-crm-foundation` yalnız config hedefidir.
- Wrangler'ın gerçek `unstable_readConfig` normalizasyonunda DB/account/Queue exact eşleşme, documents/public URLs off, cron/consumer/R2/scanner yokluk assertion'ları: PASS.
- Root local R2/Queue regression dosyası: **2/2 PASS**; emulator, gerçek R2 kanıtı değil.
- Phase 1 source/test/schema/migrations değişmedi; yalnız foundation config ve evidence/status eklenir. 70 dosyada 1365 testlik accepted birleşik kapsam, D1/migration/no-drift/build/review kanıtı status'tadır; bu metadata/config diliminde değişmeyen pahalı full suite yeniden çalıştırılmaz.

## Free-tier ve R2 maliyet açıklaması — aktivasyon yapılmadı

Resmî kaynaklar 5 Ekim 2026'da Cloudflare docs `production` ağacından okundu; güncel tree ref `d62ed691f8cf8fb202d00b2f5332ea8b1be03114` (commit `2026-10-05T19:11:09Z`). Önceki araştırma ref'i `03f58703df62daa18049b7e0043bb6e25c659670` tarihsel kalır.

- D1 Free: 5 milyon rows-read/day, 100000 rows-written/day, 5 GB account storage. Free limit üstü Paid otomatik satın alınmaz; gerçek capacity/fail-closed runtime gate açık.
- Queue Free: 10000 operations/day, **24 saat retention, non-configurable**. Ücretli 14-gün zorunluluğu yok. D1 durable jobs/outbox/lease/attempt/CAS ve beş-dakika redispatch otorite; Queue expiry/consumer retry exhaustion kalıcı iş kaybını meşrulaştırmaz. Gerçek failure recovery ve alarm teslimi hâlâ açık.
- R2 **Standard**: sabit aylık taban subscription ücreti yok; **kullanım bazlı faturalandırma**. Dahil aylık hak: **10 GB-month storage, 1 milyon Class A, 10 milyon Class B**, egress ücretsiz. Free hak yalnız Standard içindir, Infrequent Access değildir.
- Free hakkı aşan Standard kullanım: **$0.015/GB-month**, **$4.50/milyon Class A**, **$0.36/milyon Class B**. Resmî billable-unit yuvarlaması uygulanır; Free hak sınırsız veya sıfır maliyet garantisi değildir.
- R2 başlangıcı **Dashboard checkout/subscription** gerektirir. Resmî billing setup geçerli primary ödeme yöntemi ister; usage-based hizmet için ödeme preauthorization/suspension riski vardır. Kart/ödeme ayrıntısı ajan tarafından okunmadı, chat'te istenmez.
- **Doğrulanmış hard spending cap yok.** Resmî budget alerts bilgi amaçlıdır; kullanımı durdurmaz veya cap uygulamaz. Bir alarmı hard-cap olarak sunmak veya “R2 kesin ücretsiz” demek doğru değildir.
- Bu monetary exposure kabul edilmedi; paid monthly plan satın alınmadı, ödeme yöntemi eklenmedi. Kullanıcı hedef account Dashboard > Storage & databases > R2 > Overview checkout'unu maliyet/overage şartlarını görerek kendisi tamamlamadan R2 provision edilmez. Workers Paid/Zone Pro/paid Zero Trust seçilmez.

Resmî kaynaklar:

1. https://developers.cloudflare.com/r2/get-started/
2. https://developers.cloudflare.com/r2/pricing/
3. https://developers.cloudflare.com/billing/get-started/create-billing-profile/
4. https://developers.cloudflare.com/billing/manage/budget-alerts/
5. https://developers.cloudflare.com/billing/understand/billing-policy/
6. https://developers.cloudflare.com/queues/platform/pricing/
7. https://developers.cloudflare.com/d1/platform/pricing/
8. https://developers.cloudflare.com/d1/configuration/data-location/
9. https://github.com/cloudflare/cloudflare-python/blob/main/src/cloudflare/types/queues/queue_create_params.py

## Kalan dış kapılar ve sıradaki tek güvenli adım

Önce **R2 usage-billing/checkout insan aksiyonu**. Sonra fresh R2 activation GET; private Standard primary bucket EU-header ile create ve exact EU/r2.dev OFF/no public custom domain/no anonymous access readback; foundation binding + dry-run.

Bundan bağımsız kalan zorunlu dış kanıtlar: normal/secure Access MFA/audience/session/login/alternatif URL; gerçek structural acceptance/safe attachment ve Free CPU/peak-memory/query/storage kapasitesi; durable writes/retry/reconcile/Queue expiry ve alarm teslimi; ayrı backup account/credential/IAM no-delete/EU/35-gün lock/export retention; saatlik tutarlı export/trustworthy manifest/recovery keys/restore RPO 1 saat-RTO 4 saat ve current offboarding/permission/deletion-tombstone publication; hukuki retention/operational commissioning ve açık release yetkisi.

`M4 COMPLETE=false`, `DOCUMENTS_ENABLED=false`; M5 başlamadı. ClamAV/Container/scan CLEAN/scan-specific paid-retention üretim kapıları geri getirilmez. Global API Key daraltması sonraki teknik borçtur, bugünün blocker'ı değildir. Auth/domain/multi-user ve backup sınırları azaltılmadı. Hermes skill/tooling/config authoring veya self-improvement yok.
