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
| M2-T02 | Hassas Alanlar (TCKN/VKN/Vergi Dairesi, AES-GCM envelope encryption, Key-Derivation) | BAŞLAMADI |
| M2-T03 | Harici Müşteri Referansı (ExternalCustomerReference) | BAŞLAMADI |
| M2-T04+ | Policy / Amendment / Renewal Domain modelleri | BAŞLAMADI |

## Gerçek uygulama durumu

| Faz | Durum |
|---|---|
| Planlama ve kararların kapatılması | TAMAMLANDI |
| Faz 1 — Güvenli temel | TAMAMLANDI — M1-T01–M1-T10 ve RG-00 PASS |
| Faz 2 — Müşteri/poliçe domain'i | SÜRÜYOR (M2-T01 henüz kabul edilmedi, M2-T02+ BEKLEMEDE) |
| Faz 3 — Yenileme ve takip | BAŞLAMADI |
| Faz 4 — Belge ve iletişim | BAŞLAMADI |
| Faz 5 — Raporlar ve operasyon arayüzü | BAŞLAMADI |
| Faz 6 — Veri aktarımı | BAŞLAMADI |
| Faz 7 — Üretim kabulü | BAŞLAMADI |

M2-T01 Customer ve CompanyContact recovery bulguları giderildi: gerçek-D1 audit failure rollback fixture'ı business mutation ve aynı-key retry yoluna ulaşıyor; Customer ile CompanyContact add/set-primary/deactivate retry'ları logical request snapshot'ı ve aynı idempotency key'i koruyor; CSRF cache testi `private` ve `no-store` direktiflerini ayrı doğruluyor. Generic `parseServerConfig` kabul edilmiş M1 sözleşmesine döndürüldü; CSRF secret doğrulaması yalnız issuance ve protected mutation yollarında fail-closed çalışan `parseCsrfConfig` sınırına ayrıldı. Önceden başarısız olan altı M1 testi geri kazanıldı ve LEVEL-B M2 + seçili M1 paketi 520/520 PASS oldu. BLOCKER 0, IMPORTANT 0; M2-T01 checkpoint commit'e hazırdır fakat commit/push yapılmadı. M2-T02+ başlatılmadı; staging/production deployment, gerçek veri importu veya Cloudflare remote mutation yapılmadı. Çalışma ağacı uncommitted bırakıldı.

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

M2-T01 tamamlandı. M2-T02 ve sonraki Milestone 2 işleri **BAŞLAMADI**; ayrı kullanıcı yetkisi olmadan başlatılmaz.

## Gelecek ajanların güncelleme biçimi

Her çalışma sonunda tarih/kapsam, değişen dosyalar, çalıştırılan test ve sonuç, migration ortamı, deploy durumu, varsa somut engel ve sonraki tek görevi buraya kaydet. Mimariyi bu dosyada tekrar tanımlama. Fazı yalnız kendi kabul kapısı gerçekten geçtiğinde TAMAMLANDI yap.
