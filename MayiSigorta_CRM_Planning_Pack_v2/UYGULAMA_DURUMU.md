# Uygulama durumu

Son güncelleme: **23 Eylül 2026**. Mimari kaynak: [NIHAI_MIMARI_VE_UYGULAMA_PLANI.md](NIHAI_MIMARI_VE_UYGULAMA_PLANI.md), sürüm 1.0. Authorization source-of-truth: [RG-00_AUTHORIZATION_CONTRACT.md](RG-00_AUTHORIZATION_CONTRACT.md).

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
| M2-T06 | Milestone 2 final integrated acceptance gate (later-phase scope excluded) | **DETERMINISTIC GATES COMPLETE — READY FOR FINAL INDEPENDENT REVIEW** |

## Gerçek uygulama durumu

| Faz | Durum |
|---|---|
| Planlama ve kararların kapatılması | TAMAMLANDI |
| Faz 1 — Güvenli temel | TAMAMLANDI — M1-T01–M1-T10 ve RG-00 PASS |
| Faz 2 — Müşteri/poliçe domain'i | SÜRÜYOR (M2-T01–T05 ve Batch-B COMPLETE; M2-T06 deterministic gates complete; bağımsız final incelemesi başarısız bulundu, remediation tamamlandı ve yeni bağımsız inceleme bekleniyor) |
| Faz 3 — Yenileme ve takip | BAŞLAMADI |
| Faz 4 — Belge ve iletişim | BAŞLAMADI |
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
