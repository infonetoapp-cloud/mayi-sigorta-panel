# Uygulama durumu

Son güncelleme: **20 Eylül 2026**. Mimari kaynak: [NIHAI_MIMARI_VE_UYGULAMA_PLANI.md](NIHAI_MIMARI_VE_UYGULAMA_PLANI.md), sürüm 1.0. Authorization source-of-truth: [RG-00_AUTHORIZATION_CONTRACT.md](RG-00_AUTHORIZATION_CONTRACT.md).

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
| M2-T04+ | Policy / Amendment / Renewal Domain modelleri | BAŞLAMADI |

## Gerçek uygulama durumu

| Faz | Durum |
|---|---|
| Planlama ve kararların kapatılması | TAMAMLANDI |
| Faz 1 — Güvenli temel | TAMAMLANDI — M1-T01–M1-T10 ve RG-00 PASS |
| Faz 2 — Müşteri/poliçe domain'i | SÜRÜYOR (M2-T01, M2-T02 ve M2-T03 COMPLETE; M2-T04 BAŞLAMADI) |
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

M2-T02 ve M2-T03 Batch-A kabulü tamamlandı. M2-T04 **BAŞLAMADI**; yeni kullanıcı yetkisi olmadan başlatılmayacaktır.

## Gelecek ajanların güncelleme biçimi

Her çalışma sonunda tarih/kapsam, değişen dosyalar, çalıştırılan test ve sonuç, migration ortamı, deploy durumu, varsa somut engel ve sonraki tek görevi buraya kaydet. Mimariyi bu dosyada tekrar tanımlama. Fazı yalnız kendi kabul kapısı gerçekten geçtiğinde TAMAMLANDI yap.
