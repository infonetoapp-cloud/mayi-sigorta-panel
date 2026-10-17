# Archived customer lifecycle — focused integrity closure

Başlangıç `64344c5d04bdca2f70e70df116de04401f3db09c`. Bu dosya uygulama/kanıt kaydıdır; yeni mimari plan değildir. Önceden kirli UYGULAMA_DURUMU.md kullanıcı talimatıyla byte düzeyinde aynı korunur ve commit edilmez.

## Doğrulanan açıklar / doğrulanmayan şüphe

Yeni `tests/customer-archived-lifecycle.api.test.ts` gerçek güncel migration'lı yerel D1/API üzerinde, düzeltmeden ÖNCE altı ayrı negatif teste RED verdi:

| Komut                              | Arşiv sonrası önceki sonuç                 |
| ---------------------------------- | ------------------------------------------ |
| company_contact.create             | 201 (yeni primary contact yaratılabiliyor) |
| company_contact.update             | 200                                        |
| company_contact.set_primary        | 200                                        |
| company_contact.deactivate         | 200                                        |
| customer.identity.update           | 200 (clear yolu)                           |
| customer.external_reference.create | 201                                        |

Kimlik ve external-reference testleri arşiv sonrası güncel doğru parent version'ını, contact testleri arşivle değişmeyen child version'ını kullanır. Bunlar yalnız statik inceleme bulgusu değil; gerçek API'de yeniden üretilmiş altı kusurdur. Sonraki test identity replacement yolunu da kapsar. Sentetik kimlik değerleri ve encrypted metadata test çıktısına basılmaz.

`customer.assign` için HTTP kusuru gösterilmedi: mevcut service archived kontrolü fresh-key/güncel version isteğini400 ile reddeder; tüm preflight'lardan sonra archive kazanırsa parent version artışı CAS409 üretir. Active assign ve archive sonrası exact historical replay200 korunur. Talimat gereği assign source değiştirilmedi. Trusted executor'ı gelecekte başka call-path'te kullanmak bu HTTP kabulünü kendiliğinden devralmaz.

## En küçük atomik düzeltme

Production kod değişikliği yalnız sealed `customer-domain-executor.ts` içindedir. Altı komutun yeni mutation batch'ine mevcut `d1_cas_assertions` altyapısıyla `EXISTS(customers id+agency AND archived_at IS NULL)` kontrolü eklenir. Kontrol receipt insertion'dan sonra, ilk business statement'tan önce, mevcut nihai authority/session/scope kontrolleriyle AYNI D1 transaction içindedir. Böylece primary reset dahil tüm child yazımları korunur; lifecycle başarısızsa customer/child/receipt/SUCCESS audit geri alınır ve mevcut CAS409 yanıtı döner. Yeni hata mimarisi, trigger veya migration yoktur.

Sıra kasıtlıdır: transaction başlamadan önce eşzamanlı exact işlem tamamlanıp parent sonradan arşivlenmişse önce receipt unique-conflict'e ulaşılır. Mevcut catch/lookup/current-authority replay mekanizması eski sonucu yeniden yazmadan döndürür; lifecycle assertion'ını receipt'ten önce koyup bu geç reconciliation yolunu bozmayız. Erken completed replay ve current live authorization mantığı değiştirilmedi. Yetkili archived history GET'leri korunur; unauthorized/foreign actor mevcut non-disclosure kapısında kalır.

## Test kapsamı ve kanıt

Yeni matrix23test:

-6 active mutation ve immediate/archived exact replay; original data/status ve persisted snapshot aynı.
-6 current-version archived rejection; full parent (identity type/ciphertext/IV/tag/search hash/key-version dahil), tüm contacts, references, toplam receipts ve SUCCESS audits değişmez.
-7 gerçek API race (altı komut + assign). Mutation bütün preflight'lardan sonra actual business batch önünde bariyerde bekler; ayrı gerçek archive API commit eder, sonra mutation bırakılır. Parent/child/evidence aynı, yeni receipt0. Contact child-version örnekleri parent CAS ile maskelenmez.

- Active multi-statement set-primary önce reset yapabilecek durumda stale child version ile409; önceki primary dahil tüm state rollback.
- Concurrent receipt late-reconciliation: yavaş isteğin ilk lookup'ı boşken aynı key/body hızlı isteği commit eder, archive kazanır, yavaş batch receipt unique→historical replay döner ve ikinci yazım olmaz.
- Identity replacement/clear retleri ve explicit sensitive-write grant iptali sonrası historical replay denial; grant geri geldiğinde aynı completed replay işler. Kimlik plaintext'i ve ciphertext assertion diff'lerine konmaz; byte-eşit snapshot boolean ile sınanır.
- Her command için foreign, grantsiz ve gerçek revoked-session denial; authorized archived detail/reference history read200.

İlk kaynak düzeltmesi sonrası21/21 PASS; eklenen son iki test ayrı2PASS/21filtre skip geçti. İnceleme sonrası son kabul koşusunda dosyanın tamamı23/23PASS (312.55s); skip'ler PASS sayılmaz.

Dört yakın mevcut gerçek D1 dosyası tek gate88/88 PASS: customers.domain-mutations, customers.m2-t02-domain, customers.m2-t02-api, customers.integration. Son üç dosyanın eski0004/0005 fixture'ları, runtime'ın gerektirdiği gerçek archived schema için mevcut0005–0008 migration zincirine taşındı. Tarihsel SQL veya assertion değişmedi; sahte kolon shim'i yoktur. İlgisiz frontend/büyük tarihsel suite çalıştırılmadı.

Tek bağımsız lifecycle/security incelemesi PASS:0BLOCKER/0IMPORTANT/0OPTIONAL. Reviewer yalnız yeni dosyada6 farklı localD1 testini filtreli iki koşuda bağımsız doğruladı; skip'leri veya bu tekrarları yeni benzersiz test olarak saymadı. Sonuçtan sonra parent final23/23test, typecheck, lint, format-check, client build/Worker yalnız dry-run, client-server-secret boundary ve diff-check PASS. Benzersiz odaklı toplam111test(23yeni+88yakın regresyon). Wrangler environment-selection uyarısı değişmedi; gerçek deployment yoktur.

## Sınırlar

Frontend, shared DTO/permissions/auth, CSRF, production config, paket/lockfile ve migrations değişmez. Yeni yetkilendirme framework'ü veya genel refactor yoktur. Yeni komut gelecekte bu mutasyon ailesine eklenirse lifecycle test matrix'ine de eklenmelidir. Scope dışı belge/production Free-capacity/recovery NO-GO kararları kapanmış sayılmaz.

Production deploy, Cloudflare mutation, gerçek veri, Paid, migration veya document activation yapılmadı. Protected status SHA256: `f272a14efce57f2ef47d960c2ac387e11cdaeda96aa6fda71db8585844e28930`.
