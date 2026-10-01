# Uygulama durumu

Son güncelleme: **1 Ekim 2026**. Mimari kaynak: [NIHAI_MIMARI_VE_UYGULAMA_PLANI.md](NIHAI_MIMARI_VE_UYGULAMA_PLANI.md), sürüm 1.0. Authorization source-of-truth: [RG-00_AUTHORIZATION_CONTRACT.md](RG-00_AUTHORIZATION_CONTRACT.md).

## Milestone 1 kabul durumu

| Kontrol noktası | Durum |
|---|---|
| M1-T01 | PASS |
| M1-T02 | PASS |
| RG-00 | PASS |
| M1-T03 | PASS |
| M1-T04 | PASS |
| M1-T05 | PASS |
| M1-T06 | PASS |
| M1-T07 | PASS |
| M1-T08 | PASS |
| M1-T09 | PASS |
| M1-T10 | PASS |

**MILESTONE 1 = COMPLETE**

## Milestone 2 durum takibi (Müşteri & Poliçe Domain'i)

| Kontrol noktası | Kapsam | Durum |
|---|---|---|
| M2-T01 | Customer + CompanyContact (DB schema 0004, domain/API/UI) | PASS / COMPLETE — BLOCKER 0, IMPORTANT 0, OPTIONAL 2 |
| M2-T02 | Hassas kimlik, müşteri atama ve harici referans | **PASS / COMPLETE — BLOCKER 0, IMPORTANT 0** |
| M2-T03 | Kataloglar ve operasyonel acente ayarları | **PASS / COMPLETE — BLOCKER 0, IMPORTANT 0** |
| M2-T04 | Tek sözleşme dönemi Policy çekirdeği, UI ve güvenli kimlik varyantı | **COMPLETE — Batch-B kabul edildi** |
| M2-T05 | Policy ilişkileri/lifecycle ve UI (PolicyParty, Amendment, external reference, assignment/archive) | **COMPLETE — Batch-B kabul edildi** |
| M2 Batch-B | T04+T05 UI, entegrasyon, regresyon ve kalite kapısı | **COMPLETE — BLOCKER 0, IMPORTANT 0, OPTIONAL 0** |
| M2-T06 | Milestone 2 final integrated acceptance gate (later-phase scope excluded) | **COMPLETE — deterministic gates PASS; fresh GPT-6 Sol High BLOCKER 0 / IMPORTANT 0 / OPTIONAL 0 — M2 COMPLETE** |

## Gerçek uygulama durumu

| Faz | Durum |
|---|---|
| Planlama ve kararların kapatılması | TAMAMLANDI |
| Faz 1 — Güvenli temel | TAMAMLANDI — M1-T01–M1-T10 ve RG-00 PASS |
| Faz 2 — Müşteri/poliçe domain'i | TAMAMLANDI — M2-T01–T06 PASS; 7. fresh GPT-6 Sol High final review PASS |
|| Faz 3 — Yenileme ve takip | TAMAMLANDI — M3 COMPLETE; M3-T01/T02/T03, migration 0012–0014, tam kalite kapıları ve fresh GPT-6 Sol High PASS |
| Faz 4 — Belge ve iletişim | DEVAM EDİYOR — metadata, upload, quarantine/Queue, dead-letter ve içerik inspection dilimleri kabul edildi; M4 genel kabulü tamamlanmadı |
| Faz 5 — Raporlar ve operasyon arayüzü | BAŞLAMADI |
| Faz 6 — Veri aktarımı | BAŞLAMADI |
| Faz 7 — Üretim kabulü | BAŞLAMADI |

M2-T01 Customer ve CompanyContact recovery bulguları giderildi: gerçek-D1 audit failure rollback fixture'ı business mutation ve aynı-key retry yoluna ulaşıyor; Customer ile CompanyContact add/set-primary/deactivate retry'ları logical request snapshot'ı ve aynı idempotency key'i koruyor; CSRF cache testi `private` ve `no-store` direktiflerini ayrı doğruluyor. Generic `parseServerConfig` kabul edilmiş M1 sözleşmesine döndürüldü; CSRF secret doğrulaması yalnız issuance ve protected mutation yollarında fail-closed çalışan `parseCsrfConfig` sınırına ayrıldı. Önceden başarısız olan altı M1 testi geri kazanıldı ve LEVEL-B M2 + seçili M1 paketi 520/520 PASS oldu. BLOCKER 0, IMPORTANT 0; M2-T01 checkpoint commit'e hazırdır fakat commit/push yapılmadı. M2-T02+ başlatılmadı; staging/production deployment, gerçek veri importu veya Cloudflare remote mutation yapılmadı. Çalışma ağacı uncommitted bırakıldı.

## M2 Batch-A kabul kanıtı — 20 Eylül 2026

Durum: **M2-T02 PASS / COMPLETE; M2-T03 PASS / COMPLETE**. Milestone 2 tamamlanmadı; M2-T04 başlamadı.

- T02 UI maskeli varsayılan kimlik görünümü, açık reveal/hide, set-update-clear, sunucu kaynaklı aktif sorumlu seçenekleri, body-only hassas arama ve harici referans liste/oluşturma akışlarını gerçek CSRF ve aynı logical-operation idempotency retry sözleşmesiyle sunuyor.
- T03 UI insurer, branch, product, payment method, loss reason ve operasyonel acente ayarlarını list/create/update/deactivate akışlarıyla sunuyor; inaktif değerler ayrıştırılıyor ve yeni bağımlı seçimlerde yalnız sunucunun selectable yanıtı kullanılıyor.
- Bağımsız Batch-A diff incelemesindeki gerçek bulgular giderildi: T03 CSRF hata kodu korunumu, hassas POST aramasında CSRF, external reference anahtarının audit metadata'dan çıkarılması ve kimlik taslağının panel kapanışında temizlenmesi. Dependency scope bulgusu authorization sözleşmesindeki `DEPENDENCY_SCOPE_TOO_NARROW` kuralı nedeniyle geçerli bulunmadı. Son durum: BLOCKER 0, IMPORTANT 0, OPTIONAL 2.
- Birleşik seçili kabul paketi 16 test dosyasında 429/430 ile tek T01 immutable customer-type regresyonunu buldu; sözleşme geri yüklendikten sonra doğrudan etkilenen 5 dosya **83/83 PASS**, T03 backend düzeltme paketi **22/22 PASS** oldu. Batch-A UI paketi **31/31 PASS**.
- `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm run verify:boundaries` ve production client + Worker dry-run `npm run build`: PASS.
- 0005 ve 0006 SQL içerikleri değiştirilmedi; doğrulanan SHA-256 değerleri sırasıyla `f5c1717b78c0d7fe9f5b3576616283311709d35e29eb24a7d786b8b1cc7dfd51` ve `d6cd62cbb4b3fc9980e415f1de32431e65830f89a7415d2e64ba393209fafdf7`; 0007 yok. Önceden kabul edilen gerçek-runner migration kanıtı yeniden çalıştırılmadı.
- Remote Cloudflare/D1/DNS işlemi, staging/production deployment veya gerçek veri aktarımı yapılmadı.

## M2-T04 CORE kabul kanıtı — 21 Eylül 2026

Durum: **M2-T04 CORE COMPLETE — UI/BATCH GATE DEFERRED**. M2 tamamlanmadı; M2-T05 başlamadı.

- `policies` tablosu additive `0007_robust_scalphunter.sql` migration'ıyla eklendi. Policy tek sigorta sözleşme dönemidir; policyholder Customer, insurer, product+branch, payment method ve assignee ilişkileri same-agency composite FK'lerle korunur. Global `UNIQUE(policy_number)` yoktur.
- Varsayılan aday kimliği `(agency, insurer, normalized_policy_number, end_date, identity_variant)` unique sözleşmesidir; `identity_variant=0` varsayılandır. Aynı numaranın farklı dönemleri kabul edilir, eşzamanlı aynı aday yaratımı en fazla bir business effect üretir.
- Normal create/update/assign yolları server-owned kapalı Policy komutları, canlı identity/membership/permission/scope recheck, expectedVersion CAS, namespaced idempotency, audit ve business effect'i tek D1 batch içinde uygular. Generic PATCH assignee veya `identity_variant` kabul etmez.
- `policy.identity_variant.create` yalnız secure audience + accepted SensitiveActionGrant + `policy.update` AGENCY effective scope + gerekçe + expectedVersion ile çalışır. Grant action/payload/target/version/permission_version bağları, tek kullanım, exact replay yetki recheck'i ve grant+variant+receipt+audit rollback atomikliği gerçek D1 testlerinde doğrulandı.
- `policy_record_resolver` AGENCY ve ASSIGNED (Policy assignee veya policyholder Customer assignee) davranışını uygular. Health eylemleri normal Policy yetkisine ek `sensitive.health.read/write` gerektirir; OWNER için hassas izin örtük değildir.
- Primler integer minor unit olarak saklanır ve decimal string BigInt ile deterministik ayrıştırılır; geçersiz hassasiyet, bilimsel gösterim, NaN/Infinity ve overflow reddedilir. Sözleşme tarihleri canonical `YYYY-MM-DD` olarak timezone dönüşümü olmadan saklanır. ISO 4217 kodu allowlist ile doğrulanır.
- Katalog sözleşmesi branch health classification ile payment method installment capability/max limit alanlarını API/domain düzeyinde taşır. Yeni Policy ve güvenli varyant aktif same-agency catalog gerektirir; tarihsel inaktif referanslar okunabilir kalır.
- Odak T04 paketi: **4 dosya / 29 test PASS**. Paylaşılan authorization regresyonu: **3 dosya / 210 test PASS**. Değişen catalog mutation/API regresyonu: **2 dosya / 22 test PASS**.
- Migration gerçek Wrangler local runner testi: 0006→0007 upgrade + Customer/T03 seed korunumu, clean apply ve ikinci runner `No migrations to apply`: PASS. 0000–0006 SHA-256 koruması PASS; geçici klon üzerinde Drizzle generate `No schema changes, nothing to migrate`: PASS; 0008 yok.
- `npm run lint`, `npm run typecheck`, `npm run verify:boundaries` ve `git diff --check`: PASS. Geniş Level-B/full suite/full build kullanıcı talimatıyla Batch-B sonuna ertelendi.
- Git commit/push/deploy yapılmadı. `HEAD` ve `origin/main` `de5eeaa74567f8f49ef1ec8c76a4f41008367d4b`; T04 çalışması Batch B için uncommitted bırakıldı. `.env` tracked değil; Cloudflare deploy, remote D1, DNS veya production data işlemi yapılmadı.

Sonraki tek görev: **M2-T05**; T04 UI ve geniş Batch-B kabul kapısı T05 sonrasında birlikte tamamlanacak.

## M2-T02 CORE recovery kanıtı — 20 Eylül 2026

Durum: CORE kanıtı Batch-A UI ve birleşik kabul kapısıyla tamamlandı; **M2-T02 PASS / COMPLETE**.

- Completed OperationReceipt replay denetimi domain planı ve duplicate-reference precheck'inden önce çalışan ortak faza alındı. Exact external-reference retry önceki `201` sonucunu döndürüyor; tek business row ve tek success audit korunuyor. Aynı anahtarın farklı action/payload/target/version kullanımı idempotency conflict, yeni anahtarın aynı referansı ise `DUPLICATE_EXTERNAL_REFERENCE`/HTTP 409 üretiyor. Gerçek yerel D1 concurrent duplicate testi en fazla tek business effect doğruluyor.
- Kimlik kriptosu AES-256-GCM, her şifrelemede yeni 96-bit IV, 128-bit authentication tag ve ayrı anahtarlı HMAC-SHA-256 kullanıyor. Anahtar eksikliği/bozukluğu, anahtar tekrar kullanımı, yanlış key version ve doğrulama hataları fail-closed. Fallback kripto anahtarı yok.
- Kalıcı gerçek-D1 kanıtları plaintext TCKN/VKN'nin customer identity storage, audit metadata, receipt response ve varsayılan Customer DTO'da bulunmadığını doğruluyor. Hassas arama yalnız POST body kullanıyor; query-string girişleri reddediliyor.
- Sensitive izin tek başına Customer record scope yaratmıyor; OWNER açık sensitive grant olmadan plaintext identity okuyamıyor; ASSIGNED sensitive search yalnız etkin kayıt kapsamını döndürüyor.
- Assignment kanıtları same-agency ACTIVE hedef, canlı old/new assignee scope geçişi, exact replay/tek audit, stale expectedVersion ve inactive/cross-agency ret davranışlarını doğruluyor.
- Kimlik mutation audit insert failure gerçek yerel D1 testinde business effect + receipt + audit birlikte rollback oluyor.
- Migration 0005 testi gerçek Wrangler `d1 migrations apply --local --persist-to` yoluyla 0004 -> 0005 upgrade, seed veri korunumu ve ikinci çalıştırmada `No migrations to apply` no-op davranışını doğruluyor. Drizzle generate no-drift PASS; 0000-0004 SHA-256 kanıtı PASS.
- CORE odak paketi: **103/103 PASS**, 8/8 test dosyası. `npm run typecheck`, `npm run verify:boundaries`, değişen kapsam ESLint ve `git diff --check`: PASS.
- Sol Medium bağımsız uygulama/kripto/yetkilendirme incelemesi: **BLOCKER 0, IMPORTANT-CORE 0, OPTIONAL 0**. Ayrı reviewer alt oturumu sağlayıcı HTTP 429 kotasına takıldı; kabul kararı ana Sol Medium incelemesi ve kalıcı test/gerçek-D1 kanıtlarına dayanıyor.
- M2-T02 Phase-B UI ve birleşik Batch-A regresyonları tamamlandı.
- Commit/push, remote Cloudflare/D1/DNS işlemi yapılmadı; çalışma ağacı bilerek uncommitted bırakıldı.

## M2-T03 CORE kanıtı — 20 Eylül 2026

Durum: CORE kanıtı Batch-A UI ve birleşik kabul kapısıyla tamamlandı; **M2-T03 PASS / COMPLETE**. M2 tamamlanmadı.

- `agency_settings`, `insurers`, `insurance_branches`, `insurance_products`, `payment_methods` ve `loss_reasons` için additive `0006_parched_proteus.sql`, Drizzle şeması, katalog servis/API katmanı ve mühürlü normal-session mutation executor eklendi. Policy/Renewal tablosu veya UI eklenmedi.
- Katalog kodları agency kapsamında unique ve API üzerinden değişmez; lifecycle fiziksel silme yerine ACTIVE/INACTIVE kullanır. İnaktif tarihsel değerler ID ile okunur, selectable yanıtlardan çıkarılır. Ürün ilişkilerinde aynı-agency ve aktif insurer/branch koşulları D1 trigger ve servis sorgusu sınırında korunur.
- Varsayılan sigortacı yalnız aynı acenteye ait ACTIVE insurer olabilir. Doğrudan default deactivation engellenir; explicit default geçişi + eski default deactivation tek D1 batch içinde atomiktir. Yarış testi competing transition altında aktif default ve rollback bütünlüğünü doğrular.
- On beş katalog action'ı `catalog.manage`, `agency.settings.update_operations` action'ı `agency.settings.manage` gerektirir; tamamı `MEMBERSHIP_AUTHORIZED` + `NORMAL_SESSION`, sensitive izinsizdir. Strict payload şemaları caller-selected action/permission/assurance/agency ve keyfi version alanlarını reddeder; güncellemelerde yalnız `expectedVersion` kabul edilir.
- Exact replay tek business effect/tek success audit döndürür; changed-payload conflict, concurrent duplicate semantic code, stale CAS ve zorlanan audit failure rollback gerçek yerel D1 üzerinde doğrulandı.
- T03 odak paketi: **26/26 PASS**, 3/3 test dosyası. Gerçek Wrangler migration kanıtı: 0005→0006 upgrade + T01/T02 seed korunumu, clean apply, rerun no-op, 0000–0005 SHA-256 koruması ve Drizzle no-drift PASS.
- Paylaşılan authorization/boundary yüzeyleri için seçili T02 regresyonu: **70/70 PASS**, 3/3 test dosyası. `npm run typecheck`, `npm run verify:boundaries` ve `git diff --check`: PASS.
- Katalog/acente ayarları UI ile M2-T02 identity/assignment/sensitive-search/external-reference UI işleri Batch-A kapsamında tamamlandı.

## M2-T01 odaklı recovery kanıtı — 20 Eylül 2026

- Audit rollback gerçek-D1 seçkisi: **1/1 PASS**, 11 test filtre nedeniyle atlandı; başarısız audit yazımı sonrası entity/receipt/audit/CAS rollback ve aynı-key retry doğrulandı.
- Retry/idempotency UI seçkisi: **2/2 PASS**, 8 test filtre nedeniyle atlandı; lost-response replay aynı key ve fresh submit yeni key kullandı.
- CSRF cache integration seçkisi: **1/1 PASS**, 35 test filtre nedeniyle atlandı; `private` + `no-store` semantiği doğrulandı.
- UI odak testi: **10/10 PASS**.
- Customer API ve gerçek CSRF issuance akışı: **36/36 PASS**.
- Gerçek primary-contact concurrency seçkisi: **2/2 PASS**, 10 test filtre nedeniyle atlandı.
- Birleşik M2-T01 focused paket: **58/58 PASS**, 3/3 test dosyası.
- Generic config + doğrudan CSRF targeted paketi: **264/264 PASS**, 5/5 test dosyası; secretsız generic config/health/me/GET-HEAD davranışı ile secretsız CSRF issuance/mutation fail-closed davranışı doğrulandı.
- LEVEL-B M2 + seçili M1 paketi: **520/520 PASS**, 12/12 test dosyası.
- Migration 0004 kapısı: **4/4 PASS**; historical hash, clean/upgrade, rerun/no-op, trigger/index inventory ve Drizzle no-drift doğrulandı.
- `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm run verify:boundaries` ve `git diff --check`: PASS.

## Nihai doğrulama kanıtı

- Bağımsız GPT-5.6 Sol High: **BLOCKER 0, IMPORTANT 0, OPTIONAL 2 — FINAL VERDICT PASS**.
- Tam test paketi: **547/547 PASS**, 15/15 test dosyası.
- Gerçek yerel D1 paketi: **26/26 PASS**.
- Format, lint, typecheck, `verify:boundaries`, build ve Worker dry-run PASS.
- Migration zinciri `0000 -> 0001 -> 0002 -> 0003`: temiz uygulama PASS, upgrade PASS, rerun/no-op PASS ve Drizzle no-drift PASS. Tarihsel `0000`, `0001` ve `0002` SQL migration dosyaları değiştirilmedi.
- Yalnız sentetik/local doğrulama yapıldı. Remote Cloudflare deployment, remote D1 migration ve DNS değişikliği yapılmadı.

## Kalan optional

- T07 D1 result-array işleme yolunda açık sayısal defensive maksimum yoktur. Mevcut durumda authority veya correctness hatası oluşturmamaktadır; Milestone 1 kapsamında yeni uygulama işi açılmadı.
- M2-T01: `App.tsx` için sonraki bir bakım turunda ele alınabilecek refaktör ihtiyacı.
- M2-T01: Deprecated boş `src/server/mutations/domain-executor.ts` dosyasının sonraki bir bakım turunda kaldırılması.

## Kurulum girdileri

Yeni mimari karar sorusu yoktur. Nihai planın 17. bölümündeki gerçek owner email'i, MFA/Access bilgileri, ayrı backup hesabı, hukuki retention profili ve işletim kişisi gibi değerler ilgili üretim kapısında doğrulanacaktır. Bunların hiçbiri sahte bilgiyle doldurulmadı; bağımsız sentetik geliştirmeyi engellemez.

## Sonraki aşama

M2-T02 ve M2-T03 Batch-A kabulü tamamlandı. M2-T04, M2-T05 ve M2 Batch-B tamamlandı. M2-T06 deterministic final gate tamamlandı; sıradaki tek adım ayrı bir GPT-6 Sol High bağımsız incelemedir. Bu inceleme bu çalışmada başlatılmadı. Milestone 2 henüz tamamlanmadı.

## Gelecek ajanların güncelleme biçimi

Her çalışma sonunda tarih/kapsam, değişen dosyalar, çalıştırılan test ve sonuç, migration ortamı, deploy durumu, varsa somut engel ve sonraki tek görevi buraya kaydet. Mimariyi bu dosyada tekrar tanımlama. Fazı yalnız kendi kabul kapısı gerçekten geçtiğinde TAMAMLANDI yap.

## M2-T05 CORE kabul kanıtı — 21 Eylül 2026

Durum: **M2-T05 CORE COMPLETE — UI/BATCH GATE DEFERRED**. M2 tamamlanmadı; M2-T06 başlatılmadı.

- Additive `0008_fearless_giant_girl.sql`; `policy_parties`, minimal `policy_amendments` ve `policy_external_references` tablolarını, Customer archive alanlarını ve Policy archive bütünlük tetikleyicilerini ekledi. Same-agency composite ilişkiler, arşivli parent/customer insert-reparent retleri, reason-code biçimi ve Customer `OPEN_DEPENDENCIES` simetrisi gerçek D1 üzerinde doğrulandı.
- Relationship create/deactivate, amendment, external-reference, Policy assignment/archive ve Customer assignment/archive yolları expectedVersion CAS, route-target bağlı idempotency, canlı identity/membership/permission/scope recheck, dependency-scope sırası, audit ve receipt ile atomik çalışıyor. Losing-writer, audit failure rollback ve exact replay senaryoları kalıcı gerçek-D1 testlerinde geçiyor.
- PolicyParty yalnız bağlı Policy için ad/rol özeti sağlıyor; ilgili Customer'ın portföyünü veya diğer poliçelerini açmıyor. Lifecycle status ile archive state ayrı tutuluyor ve tarihsel child satırları korunuyor.
- T05 + migration + boundary odak paketi: **6 dosya / 72 test PASS**. T04 ve seçili Customer/UI regresyon paketi: **6 dosya / 58 test PASS**.
- Migration 0007+0008 paketi: **2 dosya / 6 test PASS**; clean apply, 0007→0008 upgrade ve seed korunumu, ikinci uygulamada gerçek no-op, 0000–0007 SHA-256 bütünlüğü ve Drizzle no-drift doğrulandı.
- `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm run verify:boundaries` ve `git diff --check`: PASS. İki bağımsız son inceleme turunun nihai sonucu **BLOCKER 0, IMPORTANT-CORE 0, OPTIONAL 0 — PASS**.
- Commit/push/deploy yapılmadı. `HEAD` ve `origin/main` `de5eeaa74567f8f49ef1ec8c76a4f41008367d4b`; T04+T05 Batch-B çalışması bilerek uncommitted bırakıldı. `.env` tracked değil; remote Cloudflare/D1/DNS veya gerçek veri işlemi yapılmadı.

## M2 Batch-B kabul kanıtı — 23 Eylül 2026

Durum: **M2-T04 COMPLETE; M2-T05 COMPLETE; M2 Batch-B COMPLETE**. Milestone 2 tamamlanmadı; M2-T06 sıradaki görevdir ve başlatılmadı.

- Kesintili çalışmadan korunan mevcut iş: T04/T05 backend, additive 0007/0008 şeması, policy UI iskeleti, müşteri arşiv UI'si ve Batch-B UI/regresyon testleri. Recovery sırasında tamamlanmış parçalar yeniden yazılmadı.
- Poliçe listesi/oluşturma/detay/düzenleme/atama, Customer → Poliçe Ekle, health-sensitive uyarı ve secure kimlik varyantı akışı; PolicyParty INSURED/BENEFICIARY, Amendment, external reference ve iki arşiv akışı doğrulandı. Arşiv dışı bırakma OPEN_DEPENDENCIES hatası güvenli metinle sunulur; yeni yenileme/poliçe dönemi oluşturulmaz.
- Batch-B UI: **19/19 PASS**. Müşteri atama UI kapsaması önceki M2-T02 UI testinde korunarak dahil edildi.
- Uygulama/test regresyonları: migration testleri hariç **787/787 PASS (34 dosya)**. Ayrı tek-worker migration doğrulaması: 0005 **6/6**, 0007+0008 **6/6 PASS**; 0007/0008 gerçek-runner kanıtı kabul edilen additive migration'lardır. İlk tüm-suite paralel çağrısındaki Wrangler migration test timeout'ları izole tekrarında geçmiştir.
- `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm run verify:boundaries`, `npm run build` (Worker dry-run dahil) ve `git diff --check`: PASS.
- Migration/schema değişikliği Batch-B UI sırasında yapılmadı; 0007/0008 T04/T05 CORE kapsamındaki additive migration'lardır. Tarihsel 0000–0006 migration SQL dosyaları değişmedi; remote D1/migration, deployment, DNS veya gerçek veri işlemi yapılmadı.
- Güvenlik/diff kapanış incelemesi: BLOCKER **0**, IMPORTANT **0**, OPTIONAL **0**. `.env` tracked değil; `command(*)`/`permissions.allow` unsafe artifact ve Gemini/Antigravity artifact bulunmadı; `node_modules`, `dist` veya `_archive/` değişikliği yok.

## M2-T06 final integrated gate — 23 Eylül 2026

Durum: **M2-T06 DETERMINISTIC GATES COMPLETE — READY FOR FINAL INDEPENDENT REVIEW**. Milestone 2 tamamlanmadı; M3 başlamadı.

- Başlangıçta `HEAD == origin/main == e2838547621de8698f9b6a87d10495e8dcaea1fd`; çalışma ağacı temizdi. İncelemede M2 planındaki poliçe numarası exact/prefix search'ünün API listesi ve UI'da bulunmadığı **1 IMPORTANT** bulgu olarak saptandı. Server-side normalize policy-number search, erişim filtresini koruyarak eklendi; liste UI'sı, cursor pagination ve regresyon testleri tamamlandı. Historical migration değişmedi, yeni migration gerekmedi.
- Tam `npm run test`: **801/801 PASS, 37/37 dosya**. Tam `npm run test:d1`: **26/26 PASS, 1/1 dosya**. Önceki paralel Wrangler timeout'ları bu tam koşuda tekrarlanmadı. Migration yüzeyinin tek-worker kontrollü tekrarı **20/20 PASS, 5/5 dosya**; daha dar 0005/0007/0008 tekrarı **12/12 PASS**. Bu kanıt correctness hatası göstermiyor; geçmiş timeout'ların yalnız contention kaynaklı olduğu kesin olarak kanıtlanmış sayılmıyor.
- Migration zinciri `0000`–`0008` (9 SQL dosyası): temiz apply PASS; 0003 tabanından 0004–0008 yükseltmesi PASS ve seed Agency/Membership durumu korundu; ikinci apply `No migrations to apply` PASS. 0008 temiz apply/rerun ve Drizzle no-drift testleri PASS. `npx drizzle-kit generate`: **No schema changes, nothing to migrate**. Historical migration SQL değiştirilmedi; 0009 oluşturulmadı. Migration/constraint/trigger/FK/index inventory testleri tam suite'te PASS.
- Integrated Flow A (Individual Customer, kimlik/assignment, Policy create/list/search/detail/update/assignment, secure identity variant ve archive) mevcut T02/T04/T05 gerçek-D1 domain, API ve Batch-B UI testleriyle PASS; T06 policy search UI/API regression dahil edildi. Flow B (Company/CompanyContact, Policy, PolicyParty, Amendment, external reference, okuma/list/detail ve lifecycle) aynı gerçek-D1 domain ve UI regresyonlarıyla PASS; yeni sonraki-faz modeli eklenmedi.
- Authorization ve hassas veri olumsuz matrisleri: tam test suite PASS; agency/record scope, OWNER NORMAL ve açık SENSITIVE izin ayrımı, explicit MEMBER grants, canlı ASSIGNED değişimi, health sınıflandırma ve izin geri alma, secure grant audience/binding/version/single-use/replay, arşivli kayıt ve PolicyParty portföy kapsamı test yüzeyleri PASS.
- Idempotency/concurrency/rollback ve arşiv/lifecycle: tam suite'teki gerçek D1 testleri PASS; exact replay/conflict, same-candidate eşzamanlı create, CAS, audit/receipt/grant rollback, archive dependency/race, arşiv ≠ CANCELLED/VOIDED ve ilişki korumaları PASS.
- Performans: Miniflare yerel D1 üzerinde, gerçek `listPolicies` domain/list path'i ve **15.000** sentetik Policy, 100 Customer, sayfa boyutu 50; beş sorgu şeklinin her biri için 31 sıcak ölçüm. p95: acente + end-date sıralı sayfa **344.02 ms**; poliçe numarası prefix search **416.34 ms**; insurer + end-date aralığı **334.66 ms**; müşteri poliçe geçmişi **367.19 ms**; status filtresi + created-at sırası **352.54 ms**. Hepsi 500 ms yerel hedefinin altında; bunlar local D1 ölçümüdür, 20 eşzamanlı Türkiye ağ/production kapasite testi değildir.
- Kalite: `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm run verify:boundaries`, `npm run build` (client + Wrangler Worker dry-run) ve `git diff --check`: **PASS**.
- Güvenlik/işletim sınırı: tracked `.env` **NO**; `command(*)` **NOT FOUND**; `permissions.allow` **NOT FOUND**; client/server boundary PASS; tracked `node_modules`, `dist`, `_archive` değişikliği veya geçici benchmark dosyası yok. Remote deployment, remote D1, DNS, gerçek veri işlemi yapılmadı.
- M2-T06 bulguları: başlangıçta **IMPORTANT 1** (Policy exact/prefix search eksikti), düzeltme + backend/UI regresyonlarıyla kapatıldı; final **BLOCKER 0, IMPORTANT 0, OPTIONAL 0**. Kaynak/test/UI ve bu evidence dokümantasyonu commit'e dahil; deployment, remote D1 veya DNS değişikliği yapılmadı.

M2-T06 DETERMINISTIC GATES COMPLETE — READY FOR FINAL INDEPENDENT REVIEW

## M2 final review remediation — 23 Eylül 2026

Durum: **M2 FINAL REVIEW REMEDIATION COMPLETE — READY FOR FRESH INDEPENDENT REVIEW**. M2 COMPLETE değildir; M3 başlamamıştır.

- Başlangıç doğrulaması: `main`; `HEAD == origin/main == 0040ab623655eb2fdb76c70f5a60d65bf0e91a24`; çalışma ağacı temizdi. Yeni GPT-6 Sol High bağımsız incelemesi **FAILED: 2 BLOCKER + 2 IMPORTANT + 1 OPTIONAL** buldu.
- BLOCKER 1 (Customer idempotency target binding): customer-domain executor tek kanonik fingerprint bileşimi olarak action + server-owned komut hedefi + expectedVersion + payload kullanıyor. Customer/contact route hedefleri komuttan bağlanıyor; CompanyContact update/set-primary/deactivate hem customerId hem contactId, create ise customerId ile bağlanıyor. Client authority alanları kullanılmıyor; create sırasında her retry'da değişen server-generated entity ID fingerprint'e alınmıyor. Gerçek D1 testleri farklı customer/contact/parent hedeflerinde conflict, aynı işlemde replay ve changed-version conflict'i doğruluyor; T01/T02 retry regresyonları da geçti.
- BLOCKER 2 (completed receipt replay authorization): servis erken replay helper'ı ve executor'ın ilk lookup, planning failure sonrası lookup ve unique-insert yarış kaybı yolları aynı merkezi current-authority assertion'ını kullanıyor. Replay dönmeden aktif identity, user, agency, membership, güncel permission version/permission graph ve canlı Customer scope doğrulanıyor; erişim kaybında 404/non-disclosure uygulanıyor. Yetki devam ederken exact receipt mutable duplicate/precondition kontrolünden önce döner. Gerçek D1 testleri permission revoke, reassignment, suspended membership ve revoked identity sonrası denial'ı; exact external-reference replay/tek business effect'i doğruluyor.
- IMPORTANT 1 (Türkçe poliçe numarası): canonical sözleşme NFKC + trim, Turkish `i/İ/ı/I` biçimlerinin açıkça `I`'ye katlanması, locale-independent uppercase ve harf/rakam dışı ayraçların silinmesidir. Saklama ve sorgu aynı fonksiyonu kullanır. Önceden saklanan değerlerde eski algoritmanın ürettiği dotted capital `İ` bulunabildiğinden additive `0009_turkish_policy_number_casefold.sql` backfill gereklidir. Mevcut aday unique constraint iki eski kimliğin çakışmasını durdurur; migration tüm UPDATE'i atomik başarısız kılar, otomatik birleştirme/variant ataması yapmaz. Gerçek local Wrangler clean apply, 0008→0009 upgrade ve rerun no-op geçti; Miniflare D1 backfill/no-op ve collision rollback testleri geçti. Drizzle: `No schema changes, nothing to migrate`; 0000–0008 tarihsel SQL'e dokunulmadı.
- IMPORTANT 2 (exact/prefix Policy search): API `searchMode=exact|prefix` doğrular; exact `normalized_policy_number = ?`, prefix parametreli `LIKE ?` kullanır. UI arama türünü açıkça gösterir (varsayılan Önek); cursor sayfalarında arama modu korunur. Gerçek D1 testleri `P-100`/`P-1000` ayrımını, Turkish-case storage/query uyumunu, ASSIGNED ve agency izolasyonunu, deterministik cursor sayfalarında kayıpsız/tekrarsız sonuçları doğruluyor.
- OPTIONAL stale README düzeltildi: README artık Faz 1/2 ve M2/M3 durumunu UYGULAMA_DURUMU ile tutarlı bildiriyor; mimari içerik yeniden yazılmadı.
- Odaklı adversarial/regresyon paketi: **8 dosya / 127 test PASS**; migration normalization kabulü **3/3 PASS** (odak paketine dahildir). Kapsam: Customer target binding ve cross-target replay, retry/permission/assignment/membership/identity denial, external-reference exact replay sırası, policy normalization/search authorization/pagination, UI mode davranışı ve migration collision/upgrade/no-op.
- Tam kapılar: `npm run test` **807/807 PASS (38 dosya)**; `npm run test:d1` **26/26 PASS**; `npm run format:check` PASS; `npm run lint` PASS; `npm run typecheck` PASS; `npm run verify:boundaries` PASS; `npm run build` PASS (client build + normal Worker dry-run + boundary gate); `git diff --check` PASS.
- Migration kabulü: Wrangler local clean, upgrade seed korunumu/backfill, ikinci apply no-op PASS; unique-collision failure rollback PASS; Drizzle no-drift PASS. Şema değişikliği yoktur; `0009` yalnız mevcut değerlerin canonical backfill'idir. Remote D1, DNS, staging, production, deploy veya gerçek veri işlemi yapılmadı.
- Remediation commit: `2112bc70bf51307e3ce34d8cd3c7e7e382f9f236` (`fix: close M2 final review findings`). Remediation sonuç sınıflandırması: **kalan BLOCKER 0, IMPORTANT 0, OPTIONAL 0**; yeni bağımsız Sol High review henüz yapılmadı. Bu kayıt M2 COMPLETE anlamına gelmez.

## M2 ikinci bağımsız inceleme remediation — 23 Eylül 2026

Durum: **M2 ikinci inceleme remediation uygulaması tamamlandı; üçüncü yeni bağımsız incelemeye hazır. M2 COMPLETE değildir; M3 başlamamıştır.**

- Başlangıç doğrulaması: `main`; `HEAD == origin/main == b2d9a810ffc6ba225426be7c65074f088afd969b`; çalışma ağacı temizdi.
- İkinci GPT-6 Sol High bağımsız incelemesi **FAILED: BLOCKER 1, IMPORTANT 1** bildirdi. BLOCKER, `customer.create` completed replay'in yalnız collection/create yetkisini kontrol ederek receipt DTO'sunu reassignment sonrası eski ASSIGNED üyeye döndürebilmesiydi. IMPORTANT bulgusu, `assignCustomer` arşiv kontrolü ve CompanyContact deactivation pasiflik kontrolünün exact receipt replay'den önce çalışmasıydı; servis denetiminde `setPrimaryCompanyContact` için aynı sınıftan lifecycle kontrolü de bulundu.
- BLOCKER düzeltmesi: retry tarafından üretilen yeni Customer ID kullanılmaz. Completed receipt'in tam `CustomerDto` şekli/alan türleri/agency/status doğrulanır; DTO ID'si, aynı agency + actor + membership + idempotency key için yazılmış tek immutable SUCCESS `customer.create` audit hedefiyle eşleşmelidir. Bu hedef aynı agency içindeki canlı Customer satırında yüklenir. Güncel `customer.create` collection yetkisine ek olarak gerçek hedef için güncel `customer.read` permission graph ve kayıt kapsamı değerlendirilir; son D1 sorgusu güncel identity/user/agency/membership/permission_version ve live assignee-scope/CompanyContact-parent ilişkisini aynı sorguda tekrar bağlar. Corrupt/malformed/missing audit-target kanıtı `REPLAY_AUTHORIZATION_DENIED` / 404 non-disclosure ile kapanır. Retry-generated ID fingerprint dışında kalmaya devam eder; aynı anahtar ikinci Customer üretmez.
- Mutable-precondition düzeltmesi: `assignCustomer`, `deactivateCompanyContact` ve `setPrimaryCompanyContact` artık strict request canonicalization ve current replay authorization sonrasında completed exact receipt'i kontrol eder. Replay yoksa arşivli Customer, pasif Contact ve aktif-primary kuralları normal ilk yürütmede aynen uygulanır. `customer.update`, `company_contact.update`, `customer.archive` ve `customer.external_reference.create` servis yolları da incelendi: exact replay'i engelleyen mutable precondition bulunmadı; dış referansın receipt-before-duplicate davranışı korundu.
- Customer mutation inventory'si: `customer.create/update/identity.update/assign/archive/external_reference.create` ve `company_contact.create/update/set_primary/deactivate` incelendi. Type uyumluluğu kontrolleri immutable Customer type'a bağlı pure/domain validation olarak kaldı; diğer lifecycle/duplicate kontrolleri receipt replay'i yenemez. CompanyContact create'in parent COMPANY kuralı immutable type invariant'ıdır; normal ilk yürütme kontrolü korundu.
- Odaklı gerçek yerel D1/Miniflare paketi: **55/55 PASS, 4 dosya** (`customers.domain-mutations`, `customers.m2-t02-domain`, `customers.m2-t02-api`, `policies.m2-t05-domain`). Customer create immediate exact replay aynı DTO'yu, tek Customer/audit'i doğrular; reassignment sonrası collection yetkisi sürerken API **404** döner ve Customer DTO/ID'sini ifşa etmez; current AGENCY scope replay'e izin verir, permission revoke/membership suspension/identity revoke reddedilir. Yeni retry-ID yarışı tek business effect/audit'te birleşir. Bozuk DTO ve immutable audit hedefi eksik receipt fail-closed olur.
- Odaklı replay regresyonları: CompanyContact deactivate exact retry prior DTO'yu döndürür (CONTACT_ALREADY_INACTIVE değil), tek audit/business effect; set-primary, Contact update ve Customer update exact replay'leri sonraki deactivation/archive state'inden sonra prior DTO'yu döndürür. Customer assign başarıdan sonra arşivlense de aynı key/target/payload/expectedVersion replay edilir, yeni assignment business effect/audit'i oluşmaz. Customer target fingerprint (parent + Contact ID + payload + expectedVersion), external-reference exact replay-before-duplicate, replay permission/scope denial ve concurrent receipt losing-writer regressions gerçek D1 seçkisinde geçti.
- Tam kapılar: `npm run test` **813/813 PASS (38 dosya)**; `npm run test:d1` **26/26 PASS (1 dosya)**; `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm run verify:boundaries`, `npm run build` ve `git diff --check` **PASS**. Build içindeki Wrangler Worker deploy dry-run geçti; herhangi bir deploy yapılmadı.
- Migration/schema: hiçbir migration veya schema dosyası değişmedi; `0000–0009` tarihsel SQL ve migration `0009` davranışı aynen kaldı; speculative `0010` yok. Migration matrix tekrarına gerek olmadı.
- Remote/operasyon sınırı: remote D1, DNS, staging, production, gerçek veri, deployment ve M3 işi yapılmadı.
- Remediation sonrası bulgu sınıflandırması: **kalan BLOCKER 0, IMPORTANT 0, OPTIONAL 0** (uygulama/test öz-değerlendirmesi; üçüncü bağımsız inceleme yerine geçmez). Remediation implementation commit: `1302b5112561d9108119aaaa5558fefea3cfcc31` (`fix: harden customer completed replay semantics`).

M2 SECOND REVIEW REMEDIATION COMPLETE — READY FOR THIRD FRESH INDEPENDENT REVIEW

## M2 üçüncü bağımsız inceleme remediation — 23 Eylül 2026

Durum: **M2 üçüncü inceleme remediation uygulaması tamamlandı; dördüncü yeni bağımsız incelemeye hazır. M2 COMPLETE değildir; M3 başlamamıştır.**

- Başlangıç doğrulaması: `main`; `HEAD == origin/main == 9da627c1117f67960de2bc2936f0fbfbf4899af0`; çalışma ağacı temizdi. Üçüncü yeni GPT-6 Sol High bağımsız inceleme sonucu **BLOCKER 0, IMPORTANT 1** idi; rapor verilen özetten OPTIONAL sayısı belirtilmedi.
- Tek kalan IMPORTANT'ın kök nedeni: `company_contact.create` her çağrıda yeni server-generated `contactId` oluşturuyordu. Canonical fingerprint doğru biçimde bu değişken ID'yi dışarıda bırakıp parent `customerId` + payload'ı bağlıyordu. Ancak tamamlanmış receipt replay yetkisi `command.contactId` üzerinden kontrol edildiğinden exact retry, ilk Contact yerine yeni ve mevcut olmayan retry ID'sini arayıp `REPLAY_AUTHORIZATION_DENIED` üretiyordu.
- Düzeltme yalnız merkezi customer-domain executor'a yapıldı. Contact'ın özgün hedefi persisted completed 201 response içindeki katı doğrulanmış `CompanyContactDto.id` ile; aynı agency, actor user, actor membership ve idempotency key için tek SUCCESS `company_contact.create` audit satırının `company_contacts` hedefi eşleştirilerek server-side türetiliyor. Receipt DTO'sunun agency/customer bağları canonical agency ve command/fingerprint parent'ıyla uyuşmalı; DTO Contact ID'si immutable audit target ile aynı olmalı. Audit target'ın gerçekten hâlâ var olduğu ve aynı Customer/agency altında bulunduğu canlı join ile denetleniyor.
- Persisted DTO exact key seti, ID/agency/customer, zorunlu ad-soyad, nullable alan türleri, primary boolean, ACTIVE create durumu, version 1 ve eşit canonical timestamp'lerle doğrulanıyor. Audit kanıtı eksik, birden fazla, yanlış actor/agency/key/action/target type/outcome veya DTO target'ıyla tutarsızsa fail-closed. Mevcut audit update/delete guard'ının immutable olduğu D1 testinde doğrulandı.
- Receipt dönmeden önce güncel `company_contact.create` ve `customer.read` yetkisi gerçek original parent/Contact üzerinde tekrar değerlendiriliyor; canlı identity, user, agency, membership, permission version/permission graph ve güncel ASSIGNED parent kapsamı son SQL assertion'ında tekrar kontrol ediliyor. Retry-generated Contact ID bu replay dalında kullanılmıyor. Create fingerprint'i parent `customerId` + payload semantiğinde kaldı; generated Contact ID eklenmedi.
- API/gerçek-D1 exact replay testi iki ayrı aynı-route/aynı-key/aynı-body çağrısında ilk **201** ve özgün DTO/ID'nin aynısını, tek Contact satırını ve tek SUCCESS business audit'ini doğruladı. ASSIGNED parent başka üyeye atanıp aktör kapsamından çıkarılınca replay generic **404/non-disclosure** verdi; Contact/audit çoğalmadı. Güncel explicit MEMBER AGENCY kapsamı exact replay'i özgün DTO ile kabul etti.
- Adversarial gerçek-D1 kapsamı: doğrudan executor replay'inde permission revoke, inactive membership ve revoked identity retleri; malformed Contact DTO; DTO Contact ID ile immutable SUCCESS audit target uyuşmazlığı; Contact'ın fingerprint command'ındaki Customer'dan farklı parent'a ait olması; aynı key + farklı parent/payload/action conflict. Exact parent+payload replay aynı sonucu verdi ve tek business effect/audit korundu.
- Diğer Customer-domain CREATE yolları kısaca denetlendi: `customer.create` zaten persisted original Customer receipt/audit target'ını kullanıyor; `customer.external_reference.create` için generated reference ID authorization hedefi değil, current replay authorization parent Customer'a bağlı. Retry-generated ID'nin replay authorization'da kullanıldığı başka bir eşdeğer sibling defect görülmedi.
- Odaklı gerçek-D1 regresyon paketi **5 dosya / 101/101 PASS**: `customers.integration`, `customers.m2-t02-domain`, `customers.m2-t02-api`, `customers.domain-mutations`, `policies.m2-t05-domain`. Kapsama yeni API/service testleri, Customer create replay, Contact create parent fingerprint, Contact deactivate/set-primary/update replay, external-reference replay-before-duplicate ve arşiv sonrası assign replay dahil.
- Tam kapılar: `npm run test` **821/821 PASS (38 dosya)**; `npm run test:d1` **26/26 PASS**; `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm run verify:boundaries`, `npm run build` ve `git diff --check` **PASS**. Build client üretimini ve Wrangler Worker `--dry-run` kabulini geçti; deployment yapılmadı.
- Tekrar/ortam notu: bir full test çağrısında mevcut M2-T02 UI kimlik testi test içi placeholder aramasında başarısız oldu; aynı test izole **1/1 PASS**, ardından tam suite **821/821 PASS** verdi. İlk D1 çağrısı 300 saniyelik tool süresine ulaştı; 600 saniye sınırıyla tekrar **26/26 PASS** tamamlandı. Başarılı nihai gate sonuçları son kod ağacındadır.
- Migration/schema: hiçbir şema veya migration dosyası değişmedi; mevcut `0000–0009` aynen kaldı; `0010` eklenmedi. Migration matrix tekrarına gerek olmadı. Remote D1, DNS, staging, production, gerçek veri veya deploy işlemi yapılmadı.
- Remediation implementation commit: `4ac33226f9dcc876e3795d09176331b38adcfc51` (`fix: authorize contact create replay against original target`). Self-assessment: **BLOCKER 0, IMPORTANT 0, bu remediation kapsamında yeni OPTIONAL bulgusu 0**; üçüncü bağımsız rapordaki OPTIONAL sayısı belirtilmemiştir. Bu öz-değerlendirme bağımsız inceleme yerine geçmez ve M2 COMPLETE anlamına gelmez.
- Sonraki tek adım: **dördüncü fresh independent GPT-6 Sol High incelemesi**. M2 henüz tamamlanmadı; M3 başlamadı.

M2 THIRD REVIEW REMEDIATION COMPLETE — READY FOR FOURTH FRESH INDEPENDENT REVIEW

## M2 final review remediation — 24 Eylül 2026

Durum: **Üçüncü bounded remediation cycle tamamlandı; M2 COMPLETE değildir, M3 başlamadı. Yeni fresh GPT-6 Sol High incelemesi bekleniyor.**

- Dördüncü fresh GPT-6 Sol High incelemesi **BLOCKER 0, IMPORTANT 1, OPTIONAL 0** buldu: `company_contact.create` completed receipt DTO'sunda e-posta yalnız string/trim olarak doğrulanıyor, biçimi doğrulanmıyordu. Gerçek-D1 exact replay regresyonu e-posta geçersizken makbuzun döndüğünü RED olarak gösterdi; ortak Zod `.email()` doğrulaması eklendi ve retry fail-closed oldu.
- Beşinci fresh GPT-6 Sol High incelemesi Contact düzeltmesini doğruladı; aynı eksik doğrulamanın sibling `customer.create` receipt parser'ında kaldığını **BLOCKER 0, IMPORTANT 1, OPTIONAL 0** olarak bildirdi. Customer için aynı canonical e-posta kontrolü eklendi; persisted receipt exact replay testi RED→GREEN oldu.
- Altıncı fresh GPT-6 Sol High incelemesi `customer.create` makbuzundaki diğer create-schema sınırlarının da tam doğrulanmadığını **BLOCKER 1, IMPORTANT 0, OPTIONAL 0** olarak buldu: boş/limit dışı telefon, limit dışı adres ve kanonik olmayan string/timestamp değerleri. Raporun “whitespace-only displayName” örneği mevcut parser'da zaten reddediliyordu; düzeltme yine de create schema ile eşleşecek şekilde tüm alanlarda trim/max/min ve canonical timestamp kontrollerini ortak doğrulayıcılarla tamamladı.
- Yeni gerçek-D1 regresyonları Contact ve Customer bozuk e-posta makbuzlarını ve Customer create DTO sınırlarını (displayName, ad/soyad, şirket unvanı, telefon, adres, timestamp) aynı idempotency key ile replay ederek doğruluyor. Kapsam dışı/audit-hedefi/replay-authority semantiği değiştirilmedi.
- Odak Customer/API regresyonu: **4 dosya / 88 test PASS**. M2 tam `npm run test`: **824/824 PASS, 38/38 dosya**. `npm run test:d1`: **26/26 PASS**.
- `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm run verify:boundaries`, `npm run build` (client + Worker `--dry-run`) ve `git diff --check`: **PASS**. Bir ara `format:check` yalnız Prettier biçimi nedeniyle uyarı verdi; hedef dosyalar formatlandı ve son kalite kapıları temiz geçti.
- Schema/migration değişmedi; `0000–0009` aynen kaldı. Uygulama/test remediation commit'i: `139a44034617f98626398c6187fd3110cd8429ca` (`fix: validate create replay receipt DTOs`). Bu kayıtta remote D1, deployment, DNS veya gerçek veri işlemi yapılmadı.
- Sonraki tek görev: **yeni fresh GPT-6 Sol High bağımsız M2 incelemesi** (`gpt-6-sol`, reasoning `high`). PASS alınmadan M2 kapanmayacak ve M3 başlamayacak.

M2 FINAL REVIEW REMEDIATION CYCLE 3 COMPLETE — READY FOR FRESH GPT-6 SOL HIGH REVIEW

## Milestone 2 formal close — 24 Eylül 2026

Durum: **MILESTONE 2 = COMPLETE. Faz 3 / M3 sıradaki aşamadır; bu kapanışta M3 implementation henüz başlatılmadı.**

- Yedinci fresh bağımsız GPT-6 Sol High incelemesi (`gpt-6-sol`, reasoning `high`) commit `4862441e0594d1c1a97d28f05599d673cbf9cf4a` üzerinde gerçek kod ve testleri inceledi: **BLOCKER 0, IMPORTANT 0, OPTIONAL 0 — FINAL VERDICT PASS**.
- Reviewer; Customer ve CompanyContact create makbuzlarının canonical email/null, trim/uzunluk, telefon/adres ve timestamp kontrollerini; Contact/Customer özgün hedefinin audit ve canlı kayıtla bağlanmasını; güncel permission/scope recheck'lerini; bütün replay çıkışlarını ve receipt/business/audit atomikliğini PASS değerlendirdi. Türkçe Policy normalization, exact/prefix search ve migration 0009 da incelendi.
- Reviewer odak testleri: Customer/API 4 dosya **88/88 PASS**; Policy normalization/search + migration 0009 2 dosya **27/27 PASS**; Policy lifecycle/assignment-after-archive 1 dosya **16/16 PASS**. Reviewer bu incelemede tam 824 suite veya `test:d1`'ı yeniden çalıştırmadı; son kod değişikliğinden sonraki deterministic gate kanıtı üstteki cycle-3 kaydındadır.
- M2 deterministic gate: `npm run test` **824/824 PASS (38 dosya)**; `npm run test:d1` **26/26 PASS**; format, lint, typecheck, boundaries, client build + Worker dry-run PASS. Migration/schema değişmedi; historical `0000–0009` korunmuştur.
- Review başlangıç/kapanış repository durumu: `main`, HEAD, `origin/main` ve canlı `origin/main` `4862441e0594d1c1a97d28f05599d673cbf9cf4a` ile eşitti; çalışma ağacı temizdi. Uygulama/test remediation commit'i `139a44034617f98626398c6187fd3110cd8429ca`; M2 kapanışı documentation-only değişikliktir.
- Bu gece deployment, remote D1, DNS, Cloudflare hesap ayarı veya gerçek veri işlemi yapılmadı.
- Tarihsel checkpoint'teki sonraki görev M3'ün ilk vertical slice'ıydı; bu kayıt, aşağıdaki 27 Eylül 2026 M3 kapanış kanıtıyla superseded edilmiştir. M4 kapsamı başlamamıştır.

MILESTONE 2 COMPLETE — MILESTONE 3 COMPLETE

## M3-T01 kabul kanıtı — 24 Eylül 2026

Durum: **M3-T01 kabul edildi; M3-T02 ile paylaşılan uygulama ağacında. M4 başlamadı.**

- Additive `0010_m3_renewal_core.sql` ile RenewalOpportunity, RenewalStateHistory, birincil yenileme Task'ı ve agency generation cursor'ı eklendi. Migration/schema ayrıntılı yerel kabul kanıtı M3-T02 checkpoint'inde güncellendi.
- Ortak idempotent Policy→Renewal üretimi manuel Policy oluşturma ve günlük scheduled Worker yolunda kullanılıyor; cursor/catch-up, yarışta tek kayıt/history/Task/audit, rollback, Policy archive/terminal guard ve Policy-assignee → Customer-assignee → Atanmamış atama önceliği M3-T01 kalıcı testlerinde kapsanıyor.
- Renewal ASSIGNED kapsamı Renewal veya Customer sorumluluğuyla sınırlı; kaynak Policy ataması tek başına Renewal yetkisi sağlamıyor. Task erişimi server-confirmed bağlı-parent okuma kanıtı gerektiriyor.
- Önceki fresh bağımsız M3-T01 follow-up sonucu: **ACCEPT, BLOCKER 0, IMPORTANT 0**; reviewer'ın focused testi **20/20 PASS**, yerel D1 generation testi çalıştırılmıştı.
- Bu devam oturumunda ortak authorization, T01 generation ve ilişkili Policy regresyon seçkisi **188/188 PASS** oldu. T01/T02 paylaşılan değişiklikleri güvenli biçimde iki ayrı commit'e ayrılmadı.

## M3-T02 kabul kanıtı — 24 Eylül 2026

Durum: **Tarihsel M3-T02 kabul checkpoint'i: ACCEPT — BLOCKER 0, IMPORTANT 0, OPTIONAL 0. Nihai M3 durumu aşağıdaki formal closeout bölümündedir; M4 başlamadı.**

- Bugünkü İşler API/UI; renewal primary Task assignment; Renewal ve Task sorumluluğunun birlikte, CAS/idempotency/audit ile atomik güncellenmesi; Task tamamlanırken replacement primary follow-up'ın aynı D1 batch içinde oluşturulması tamamlandı.
- `task.read/task.update ASSIGNED` artık yalnız Task'ın kendi sorumlusuna açılır; Customer/Policy/Renewal okuma ve kapsamı ayrıca doğrulanır. Atanmamış Task müşteri sorumluluğuyla ASSIGNED work listesine sızmaz; atama hedefi aktif ve bağlı işi okuyabilir olmalıdır. HEALTH yenilemeleri `policy.health.read` yoksa Today's Work'ten çıkarılır; politika bilgileri başka yetkilerle sızdırılmaz.
- WORK/UNASSIGNED cursor'ları ayrı; imleçler acente, üyelik, permissionVersion ve tüm ilgili permission scope'larına bağlanır. UUID tabanlı UNASSIGNED imlecinin 256 karakteri aşması yerel D1 API testinde kanıtlandı; query sınırı artırıldı ve 268 karakterlik bound-shape token parser'a ulaşıyor.
- Adversarial yerel D1 kanıtları: geçerli/uygunsuz assignee, aynı anda Renewal+Task assignment, rollback, exact replay ve changed target/payload/version, replay'de güncel yetki kaybı; replacement insert/audit/CAS rollback; sıfır-row/orphan ve eşzamanlı completion. Tamamlanma receipt'indeki `completedAt`, kalıcı Task `completed_at` ve başarı audit zamanı ile eşleşir; geçerli ISO değere yapılan receipt tampering replay'de reddedilir.
- Güncel focused seçim: T02 API **24/24 PASS**; route + Today’s Work React **18/18 PASS** (React **14/14**); T01/authorization/Policy regresyonu **188/188 PASS**; `tests/migration.0010.test.ts` **2/2 PASS**.
- Tam `npm run test`: **896/896 PASS, 44/44 dosya**. `npm run test:d1 -- --maxWorkers=1`: **26/26 PASS**.
- Migration `0010`: Wrangler local clean apply/no-op, `0009` seed korunarak upgrade, constraint/trigger/FK ve immutable event kanıtı **2/2 PASS**. `0000–0009` tarihsel SQL dosyaları değişmedi. `npm run db:generate`: **No schema changes, nothing to migrate**.
- `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm run verify:boundaries`, `npm run build` (client + Wrangler Worker dry-run), `git diff --check`: **PASS**.
- Bağımsız GPT-6 Sol High incelemeleri: ilk incelemedeki **2 BLOCKER + 2 IMPORTANT** giderildi; ikinci fresh incelemenin bulduğu cursor boyutu ve completedAt bütünlüğü için testli düzeltmeler yapıldı. Son fresh inceleme: **BLOCKER 0, IMPORTANT 0, OPTIONAL 0 — FINAL VERDICT PASS**. İnceleyici M3-T02/migration seçkisini **44/44**, T01/shared authorization seçkisini **188/188** çalıştırdı; bu oturum ayrıca yukarıdaki tam suite ve `test:d1` sonuçlarını üretti.
- Birleşik M3-T01/T02 checkpoint commit'i `0f5043bd4e3451f3de0aafb34205fc68325e53d2` origin/main'e normal push ile yayımlandı. Push sonrasında `HEAD == origin/main == af02311fe311bad9c982f9adc6e92f55ce546b8a` ve worktree temiz olarak doğrulandı; bu satırlar bu takip amaçlı durum güncellemesinden önceki push kontrolünü kaydeder. Yalnız local sentetik veri kullanıldı; deployment, remote D1, DNS/Cloudflare production yapılandırması veya gerçek müşteri verisi işlemi yapılmadı.

## M3 terminal outcome bounded slice — 24 Eylül 2026

Durum: **Tarihsel bounded-slice checkpoint'i: LOST, VOIDED ve LOST/VOIDED reopen kabul edildi. Bu ara durum aşağıdaki nihai M3 COMPLETE kaydıyla superseded edilmiştir; M4 başlamadı.**

- `renewal.close-lost`, `renewal.void` ve `renewal.reopen` için açık API komutları eklendi. `VOIDED` yalnız teknik hata, duplicate veya iptal/yeniden yapılandırma sonrası uygun olmayan iş kodlarını kabul eder; ticari kayıp kodları reddedilir. WON reopen yalnız secure correction yolu ile mümkün olacak; bu dilimde uygulanmadı.
- LOST/VOIDED komutları aktif birincil Task'ı, Renewal state/version/closure alanlarını, receipt, `RenewalStateHistory` ve audit'i tek D1 batch içinde CAS ile günceller. Reopen eski tamamlanmış Task'ı ve terminal history kanıtını korur; önceki açık state'e döner ve yeni tek bir birincil takip Task'ı oluşturur. Açıklama/audit free text'e kopyalanmaz; LOST OTHER açıklaması değiştirilemez history satırında kalır.
- Additive migration `0011_m3_terminal_history_evidence.sql`, `RenewalStateHistory` üzerinde LOST reason ID/OTHER açıklaması ve VOIDED reason code kanıtını saklar. D1 insert trigger'ları aynı-acente/aktif loss reason, açıklama semantiği ve kapalı VOIDED kod kümesini doğrular; tarihsel kanıta başvurulmuş reason ID/acente/kodu silinemez veya değiştirilemez. `0000–0010` SQL migration dosyaları değiştirilmedi.
- Completed receipt replay aynı D1 proof sorgusunda güncel AuthIdentity, user, membership/permission_version, permission graph ve dependency scope'ları, HEALTH-sensitive izni, mevcut target/parent scope'u ve immutable Task/history/audit kanıtını tekrar denetler. Kaynak Policy sonradan CANCELLED olsa veya reopen sonrası yeni Task başka üyeye atansa dahi yetkili aynı sonucu alır; eski tamamlanmış Task ile yeni açık Task'ın assignee farkı exact replay'i bozmaz.
- Gerçek local D1 testleri: `tests/renewals.m3-t03-terminal.test.ts` **10/10 PASS** (LOST/VOIDED/reopen, audit/task rollback, exact/concurrent replay, stale versions, LOST/VOIDED yarışı, live identity revoke, grant scope/dependency TOCTOU, policy cancellation ve reopen sonrası re-assignment). Migration 0010 **2/2 PASS**; migration 0011 clean apply, 0010 upgrade/seed preservation, invalid/cross-agency evidence, history/reason immutability ve no-op **2/2 PASS**.
- İlgili T01/T02 regression'ları: bağımsız reviewer'ın Authorization/Task seçkisi **30/30 PASS**. `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm run verify:boundaries`, `npm run build` (Wrangler Worker dry-run), `git diff --check`: **PASS**. `npx drizzle-kit generate`: **No schema changes, nothing to migrate**; 0000–0010 tarihsel SQL farkı yok.
- Fresh bağımsız GPT-6 Sol High bounded-slice review: **BLOCKER 0, IMPORTANT 0, OPTIONAL 1 — PASS**. Optional follow-up: Member/ASSIGNED başarılı terminal akışı ve HEALTH izni geri alınmış terminal replay için ek doğrudan testler. Bu sonuç M3 kabulü değildir.
- Bu satır önceki bounded-slice checkpoint'inin commit/push durumunu kaydeder; nihai M3 commit/push ve remote readback aşağıdaki kapanışta doğrulanmıştır.

Sonraki görev: **M3 kapanmıştır.** Faz 4–7, ayrı kullanıcı yetkisi olmadan başlatılmayacaktır.

## M3 / Faz 3 formal closeout — 27 Eylül 2026

Durum: **M3 COMPLETE — BLOCKER 0 / IMPORTANT 0 / FINAL VERDICT PASS. M4 başladı; yalnız document metadata/state schema slice kabul edildi. M4 genel kabulü tamamlanmadı.**

- Faz 3 çıktıları tamamlandı: Renewal üretimi ve takip Task'ı, Today’s Work/UNASSIGNED, history, RenewalPolicyLink allocation/split-merge, LOST/VOIDED, single/group WON, secure WON correction, Quote/immutable SENT QuoteVersion, Interaction contact-vs-attempt ve Workspace UI.
- Sent QuoteVersion–Policy ürün/prim/para birimi farkı UI'da gösterilir; fark için güvenli gerekçe kodu zorunludur ve audit/replay kanıtı korunur. Individual ve Company synthetic D1 E2E akışları geçer.
- OWNER normal izinleri implicit AGENCY olarak kalır; SENSITIVE izinler OWNER dahil explicit kalır. `task.create` katalog sözleşmesi UNSCOPED'dir; düzeltme akışı bu grant'i boolean olarak doğrular ve Customer/Policy/Renewal/Task kayıt kapsamını ayrı, doğru read/update izinlerinden alır. Cross-customer grup düzeltmesi MEMBER için gerçek D1 testinde geçer.
- Flaky regressions: allocated split-WON exact replay **3 ardışık PASS**; exact concurrent allocation retry/single-use grant yarışı **5 ardışık PASS**. Tarihsel 404 kontrollü tekrarlarla yeniden üretilmedi; eski başarısız yanıt/target/receipt kanıtı mevcut olmadığından kök neden doğrulanmış değildir. Final terminal dosyası replay koruması dahil **19/19 PASS**.
- Group correction artık grup WON makbuzunu üye kapanış audit'iyle bağlar; preallocated link ve sonraki premium reallocation zinciri doğrulanır. Yerel D1 regresyonu, iki üyeyi de yeniden açıp premium düzeltmesiyle oluşan iki aktif linki supersede ettiğini doğrular. Premium düzeltmesinde aynı anahtar/payload yarış testi iki istek için 200 ve tek iş etkisi/makbuz/audit doğrular.
- Final current-tree unit suite: `npm run test -- --maxWorkers=4` **52/52 dosya, 945/945 test PASS**. Final D1 integration: `npm run test:d1 -- --maxWorkers=1 --testTimeout=180000` **26/26 PASS**. Focused terminal **19/19 PASS**; premium correction **4/4 PASS** (eşzamanlı exact retry dahil); migrations 0012–0014 **7/7 PASS**; UI Workspace **4/4** (tam suite içinde).
- Migrations 0012–0014 additive ve yerel kabul zincirinde PASS; tarihsel 0000–0011 migration dosyaları değişmedi. Clean apply/sequential upgrade, preservation/constraint/trigger/no-op testleri geçti. Cloned migration tree'de `drizzle-kit generate`: **No schema changes, nothing to migrate**; clone unchanged.
- `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm run verify:boundaries`, `git diff --check` ve `npm run build` PASS. Build yalnız Wrangler `--dry-run` idi.
- Fresh bağımsız GPT-6 Sol High follow-up final review: **BLOCKER 0 / IMPORTANT 0 / OPTIONAL 0 — FINAL VERDICT PASS**.
- Yalnız sentetik/local D1 kullanıldı. Production deployment, remote D1, DNS/Cloudflare yapılandırması veya gerçek müşteri verisi işlemi yapılmadı. M3 follow-up normal push ile yayımlandı; `HEAD == origin/main` ve temiz worktree closeout sırasında doğrulandı.

## M4 başlangıç dilimi — Document metadata/state schema — 27 Eylül 2026

Durum: **Metadata schema dilimi `2dad35f` ile kabul edilip push edildi: fresh Sol High PASS (BLOCKER 0, IMPORTANT 0, OPTIONAL 1). Sonraki kabul edilmiş M4 checkpoint'leri aşağıda kayıtlıdır; M4 COMPLETE değildir.**

- İleri yönlü `0015_living_frog_thor.sql` migration'ı Document, DocumentVersion, BackgroundJob, BackgroundJobRun, DocumentScanEvidence ve DocumentBackupCopy metadata tablolarını ekler. Dosya baytları D1'e konmaz; private quarantine/backup object-key biçimleri kısıtlanır.
- DocumentVersion geçmişi, checksum/scan-run/lease bağları, fail-closed quarantine, generation sıralaması, retry/available_at, 5 scan denemesi, dead-letter sonrası SCAN_FAILED, backup nesli ve current-version pointer geçişleri D1 kısıt/trigger'larıyla korunur. Timestamp biçim kontrolleri başarılı parse ve canonical, geçerli takvimli UTC milisaniye round-trip'ini ayrı ayrı zorunlu kılar; offset biçimleri reddedilir. Scan imzası freshness kapısı biçim kontrolünden ayrıdır; canonical 48 saatten eski imza CLEAN sayılmaz.
- Wrangler D1 focused şema suite'i: **1 dosya / 3 test PASS**; temiz migration apply, 0014'ten sıralı upgrade ve mevcut synthetic seed korunumu, tekrar/no-op, canonical zaman, 24-karakter ayrıştırılamayan/imkânsız tarih, offset ret, canonical >48 saat freshness ret, NULL sözleşmesi ve kısıtları kapsar. `npm run test:d1 -- --maxWorkers=1 --testTimeout=180000`: **1 dosya / 26 test PASS**. Python SQLite parser 0015 içinde **71 statement segmenti** parse etti. Tarihsel 0000–0014 migration'ları değişmedi.
- Tam Vitest gate (`--maxWorkers=1 --testTimeout=180000`) ve D1 gate (53/53 dosya, 948/948; D1 26/26), no-drift ve build kanıtları yalnız `2dad35f` metadata-schema checkpoint'ine aittir. Paralel test koşusunda 0011 upgrade testi timeout oldu; izole tekrar 2/2 geçti ve tam seri gate başarılı tamamlandı.
- Yeni, bağımsız ve salt-okunur GPT-6 Sol High incelemesi `2dad35f` metadata-schema checkpoint'i için: **BLOCKER 0 / IMPORTANT 0 / OPTIONAL 1 — FINAL VERDICT PASS**. Tek OPTIONAL, run ve scan-evidence timestamp alanlarına ayrı 24-karakter bozuk-değer negatif testleri eklenmesidir; mevcut CHECK'lerde açık parse ve round-trip koruması vardır. Bu inceleme sonraki yerel kod değişikliklerini kapsamaz.
- Document authorization/preflight/private local R2 quarantine/Queue dispatch follow-on dilimi kabul edildi; M4 genel kabulü değildir. ASSIGNED scope, Customer için kendi assignee'sini, Policy için Policy veya Customer assignee'sini, Quote için Renewal veya Customer assignee'sini kabul eder; her tür typed parent kimliği ve server-derived parent-read kanıtı ister. Kimlik/sağlık belge action'ları normal belge iznine ek olarak explicit sensitive grant gerektirir. Preflight 20 MiB, uzantı/MIME/signature uyumu ve DB-safe dosya adı denetler; R2 writer Blob'u yeniden doğrular, checksum ve rastgele server-key ile yalnız `QUARANTINE_ONLY` yazar. Beş dakikalık dispatcher kalıcı BackgroundJob'dan due işleri identifier+generation+version+checksum bağıyla Queue'ya yollar; Queue consumer henüz yoktur.
- Düzeltme sonrası odaklı auth/preflight/R2/Queue suite'i **7 dosya / 199 test PASS**; tam seri Vitest **58 dosya / 967 test PASS**; D1 integration **26/26 PASS** (0015 veya D1 kodu değişmedi ve testler tam suite içinde de geçti). `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm run verify:boundaries`, `npm run build` (client + Worker dry-run), `git diff --check` ve cloned Drizzle no-drift (**No schema changes, nothing to migrate**) PASS.
- Current follow-on için fresh, bağımsız, salt-okunur GPT-6 Sol High incelemesi: **BLOCKER 0 / IMPORTANT 0 / OPTIONAL 1 — FINAL VERDICT PASS**. Önceki ASSIGNED parent daralması bulgusu typed parent assignment kontrolleri ve farklı üyelik regresyonlarıyla kapatıldı. Tek OPTIONAL, consumer/idempotency ve gerçek tablo yaşam döngüsü kanıtının Queue consumer dilimine bırakılmasıdır; upload route, scanner, backup/restore ve temiz belge erişimi de sonraki M4 işleridir. Gerçek belge modülü açılmadı.
- Yeni M4 upload/API transaction dilimi bağımsız fresh GPT-6 Sol High incelemesinden **BLOCKER 0 / IMPORTANT 0 / OPTIONAL 0 — FINAL VERDICT PASS** aldı. Belge yükleme API'si parent/authz doğrulaması, strict multipart allowlist ve sınırlı gövde, kalıcı D1 `PENDING_UPLOAD` rezervasyonu/receipt, quarantine-only R2 yazımı, canlı authorization CAS, checksum/version bağlı `DOCUMENT_SCAN` işi ve atomik audit/receipt finalizasyonu uygular; R2 yazımı sonrası D1 finalizasyonu başarısızsa aynı key ile kalıcı rezervasyondan güvenle tekrar denenebilir. HEALTH Policy/Renewal-backed Quote için minimum `HEALTH` sınıfı zorunludur; Quote akışında ASSIGNED kaynak Policy yetkisi, Renewal/Quote kapsamından ayrı olarak finalization ve completed replay'de yeniden doğrulanır. `DOCUMENTS_ENABLED` Wrangler varsayılanı `false` kalır; route yalnız açıkça etkinleştirilmiş test ortamında çağrılabilir.
- Son dilim doğrulaması: odaklı belge/yetki **8 dosya / 213 test PASS**; tam seri Vitest **59/59 dosya / 981/981 test PASS** (`--maxWorkers=1 --testTimeout=180000`); D1 entegrasyonu **26/26 PASS** (migration/schema değişmedi; aynı D1 test dosyası tam seri suite içinde de geçti). Format, lint, typecheck, boundary, build (Worker dry-run), `git diff --check` ve Drizzle cloned no-drift PASS. HEALTH-backed Quote Policy/renewal reassignment yarışları hem R2 sonrası finalization hem de stored-result replay için regresyon testleriyle kapsanır.
- Queue/scanner/dead-letter dilimi fresh, bağımsız ve salt-okunur GPT-6 Sol High incelemesinde **BLOCKER 0 / IMPORTANT 0 / OPTIONAL 1 — FINAL VERDICT PASS** aldı. `0016_document_queue_dead_letter_events.sql` değişmez ve idempotent D1 olay kaydı ekler; ana kuyruktaki poison mesajlar ACK edilmeden DLQ'ya retry edilir, terminal consumer D1 kaydını dener, güvenli fallback ve `deadLetterReplayId` tekrarları birleştirir. Tek OPTIONAL, 4 günlük varsayılan hold retention ile 14 günlük önkoşul yorumunun tutarsızlığıydı; Wrangler açıklaması operasyon runbook'uyla hizalandı.
- Güncel seri Vitest gate **59/59 dosya, 1012/1012 test PASS**; D1 **26/26**; odaklı upload **35/35**, Queue dispatch **12/12**, M4 schema **4/4** ve `0014 → 0015 → 0016` yerel upgrade testi **1/1 PASS**. Format, lint, typecheck, boundaries, Worker dry-run build, `git diff --check` ve Drizzle no-drift PASS. Tarihsel `0000–0015` migration SQL dosyaları değişmedi.
- `M4_QUEUE_DEADLETTER_OPERATIONS.md` hold queue için backlog alarmı, 14 günlük retention ve pull/push/ack replay önkoşul/prosedürünü kaydeder. Bu dış Queue retention/alert ayarları veya replay gerçek altyapıda uygulanıp denenmedi; remote kaynaklara erişilmedi. `DOCUMENTS_ENABLED=false` kalır.
- Bu dead-letter checkpoint'inin sonraki parser işi aşağıdaki içerik-inspection kabulüyle tamamlandı. Gerçek ClamAV/EICAR, backup/restore, reconciliation, authorized CLEAN streaming ve WhatsApp etkileşim kanıtı beklemede. M4 COMPLETE değildir; M5 başlamaz.
- Yalnız sentetik verili yerel D1 kullanıldı. Production/staging deployment, remote D1/R2/Queue, DNS/Access, Cloudflare secret veya gerçek müşteri verisi işlemi yapılmadı.

## M4 içerik-inspection/parser checkpoint — 1 Ekim 2026

Durum: **Parser ve CLEAN inspection-evidence dilimi kabul edildi — fresh, bağımsız, salt-okunur GPT-6.1 Sol: BLOCKER 0 / IMPORTANT 0 / OPTIONAL 1 — FINAL VERDICT PASS. M4 COMPLETE değildir; `DOCUMENTS_ENABLED=false`.**

- `8e98dac03ec53674d174c4ba197da477e1f887e9` tabanındaki kesilmiş oturumun 14 yerel dosyası korunup yeniden incelendi; ilk typecheck zaten geçti. Doğru mevcut parser, migration ve test çalışması yeniden yazılmadı; eski eksik-helper uyarısı güncel ağaçta bulunmadı.
- PDF yalnız sınırlı yapısal alt kümeyi kabul eder: 20 MiB giriş, 200 sayfa, 4.096 nesne, 65.536 token, 64 nesting ve sayfa/geometri sınırları. Filtreli/object stream, desteklenmeyen veya güvenle sınırlandırılamayan içerik decode/rasterize edilmeden reddedilir. Tek ileri nesne ayrıştırması xref offset/generation eşleşmesini doğrular; attacker-selected xref offsetlerinde tekrar tokenizasyon yoktur. Typed delimiter stack, hex string sözdizimi, escaped adlar, katalog/page AA ve JavaScript dışı action yüzeyleri denetlenir. Bu sınıflandırma/ret akışıdır; genel PDF sanitization iddiası yoktur.
- JPEG: 8.192 kenar, 4 milyon piksel, 256 KiB toplam segment/header ve 1.024 segment; sampling/table/frame/SOS kontrolleri decoder öncesinde uygulanır. Yalnız tek baseline frame/scan; DRI kesin uzunluk 4, DNL/TEM ve bilinmeyen marker'lar ret. Strict `jpeg-js` decode allocation muhasebesi 32 MiB ile sınırlıdır; async timeout senkron decoder interrupt'ı sayılmaz. `jpeg-js@0.4.4` production dependency'dir; `npm audit --omit=dev`: **0 vulnerability**.
- PNG: chunk/CRC/order, geometri/piksel, PLTE ve palette index kısıtları; compressed ancillary/animation ret. DEFLATE literal/length/distance ön geçişi, IHDR/Adam7'dan hesaplanan en fazla 32 MiB gerçek çıktı sınırını native decompressor açılmadan doğrular; block/symbol/chunk sayaçları da sınırlıdır. Fazla açılımın decompressor'a hiç ulaşmadığı kalıcı regresyon vardır.
- CLEAN; exact DocumentVersion/checksum, güncel parser sürümü/sonucu, fresh scanner/imza, tam stream tüketimi ve ikinci R2 stream'inin bağımsız hash'iyle bağlıdır. Değişmiş etag/gövde, eksik/eski/uyuşmayan inspection, parser hatası ve scanner unavailable CLEAN olamaz. Sonuç lease/generation/attempt/deadline CAS ile kalıcı kanıta ve yalnız `BACKUP_PENDING` durumuna ilerler; AVAILABLE/backup kapısı atlanmaz.
- Migration `0017_document_scan_inspection_evidence.sql` yalnız iki nullable inspection kolonu ve iki guard ekler; legacy AVAILABLE varsa upgrade fail-closed durur. Gerçek Wrangler local clean apply, `0016 → 0017` upgrade, synthetic Customer/membership/queue seed korunumu, FK/check/unique/index/trigger ve no-op kanıtı: M4 schema **4/4 PASS**. Tarihsel `0000–0016` SQL dosyalarının **17/17** tanesi HEAD ile byte-equal. Haricî migration clone'u üzerinde Drizzle **No schema changes, nothing to migrate**; 36 dosyalı clone değişmedi.
- Güncel odak kanıtı: parser **19/19**, upload/scan **40/40**; gerçek minimal PDF/JPEG/PNG, MIME/uzantı aldatması, PDF CPU amplifikasyonu/bozuk delimiter/hex, JPEG gizli DRI/DNL scan'leri ve decoder öncesi ret, PNG pre-decompression limit/PLTE, CLEAN kanıt bağları kapsanır.
- Tam seri Vitest koşusu **60 dosya / 1036 test** çalıştırdı: **59 dosya / 1016 test değişmeden PASS**; kalan M3 generation dosyasında ilk koşu 17 PASS / 3 FAIL idi. Kök neden eski test fixture'ının sabit `2026-10-01T00:00:00.000Z` cleanup zamanının D1 gerçek `created_at` değerinden önce kalması ve sonraki iki teste state taşınmasıydı. Yalnız cleanup saati aynı D1 saatinden alınacak şekilde düzeltildi; M3 production kodu ve negatif assertion'lar değişmedi. Etkilenen dosyanın tamamı tekrar **20/20 PASS**; bu dar düzeltme ayrı fresh salt-okunur incelemede **BLOCKER 0 / IMPORTANT 0 / OPTIONAL 0 — PASS** aldı. Böylece 60 dosyanın 1036 testinin tamamı doğrulanmıştır; tek bir yeniden tam koşu 1036/1036 PASS iddiası değildir. Değişmeyen 59 dosya gereksiz tekrarlanmadı.
- Ayrı güncel `npm run test:d1 -- --maxWorkers=1 --testTimeout=180000`: **26/26 PASS**. Format, lint, typecheck, kaynak + client-bundle boundaries, `git diff --check`, client build ve Worker **dry-run** build PASS. Worker **2151.74 KiB / gzip 351.13 KiB**; production deploy yapılmadı.
- Son security PASS'in tek OPTIONAL önerisi, CLEAN döndüren scanner'ın hiç/kısmen/EOF'suz tüketimi ve `complete:false` için ayrı kalıcı testlerin eklenmesidir. Mevcut kodun fail-closed kontrolleri reviewer'ın bellek-içi problarında doğrulandı; kabulü engelleyen açık değildir ve kapanışta ek iş açılmadı.
- Docker, `clamscan`, `clamdscan` bir kez kontrol edildi: **NOT FOUND**. Gerçek ClamAV/EICAR ve Cloudflare CPU/peak-memory/region/backup yetki sınırı/restore altyapı kanıtı tamamlanmış sayılmaz. Yalnız local/synthetic işlem; remote D1/R2/Queue/Container, DNS/Access, production secret ve gerçek belge/veri kullanılmadı. Hermes skill/tooling değişikliği yapılmadı.

Sonraki tek bağımlılık-doğru dilim: **scanner-independent, local/synthetic DOCUMENT_BACKUP object akışı**; exact güncel CLEAN inspection/version/checksum doğrulaması, dar write-only backup adapter, kopyalanan bayt checksum kanıtı, kalıcı job/lease/idempotency/retry ve AVAILABLE geçişi. Ardından authorized CLEAN stream, reconciliation, D1+R2 restore proof ve WhatsApp preview/open≠CONTACT_CONFIRMED gelir. Bu takip dilimi henüz başlamadı; M5 ve remote/production işlemleri başlatılmayacak. Gerçek ClamAV dış doğrulaması belge modülünü açma kapısında beklemeye devam eder.
