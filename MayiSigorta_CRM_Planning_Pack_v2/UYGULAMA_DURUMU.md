# Uygulama durumu

Son güncelleme: **17 Eylül 2026**. Mimari kaynak: [NIHAI_MIMARI_VE_UYGULAMA_PLANI.md](NIHAI_MIMARI_VE_UYGULAMA_PLANI.md), sürüm 1.0.

## Tamamlanan iş

- Kullanıcının verdiği kapsam ve önceki planlar incelendi; Cloudflare ve güvenlik sınırları resmi kaynaklarla kontrol edildi.
- Kişi bazlı izin listesi, başlangıç şablonları, kayıt kapsamları ve hassas alan izinleri kesinleştirildi. Son yetki kaynağı MembershipPermission; şablonlar yalnız başlangıç kopyasıdır.
- Veri modeli, poliçe/yenileme geçmişi, atama, görev devamlılığı, teklifler, raporlar, güvenli belgeler, yedekleme ve kurtarma kuralları tek dosyada birleştirildi.
- Yedi faz için teslimatlar, bağımlılıklar ve kabul testleri tanımlandı. Eski G0/OPEN mimari soruları yürürlükten kaldırıldı.
- Önceki AGENTS/README, 17 docs dosyası ve üç reference dosyası toplam 22 dosya olarak arşive taşındı. Taşınan her dosyanın SHA-256 değeri öncesi/sonrası eşleşti. Eski AGENTS adı, aktif talimat sanılmaması için `AGENTS.arsiv.md` yapıldı.
- Çalışma alanı ve proje AGENTS dosyaları sonraki ajanları tek nihai plana yönlendiriyor.
- M1-T01 için React/Vite/Hono/Worker temeli, strict TypeScript, kaynak sınırı doğrulayıcısı ve negatif güvenlik testleri oluşturuldu.
- M1-T01 açık bulgularındaki canonical junction, Vite production env yükleme/öncelik/genişletme, gerçek production tsconfig alias ve process runtime sınırı düzeltildi. Process koruması alias taint takibi yerine istemci/paylaşılan kodda Node/CommonJS ve global nesne indirection kimliklerini fail-closed yasaklayan sade AST politikasına geçirildi.

## Gerçek uygulama durumu

| Faz | Durum |
|---|---|
| Planlama ve kararların kapatılması | TAMAMLANDI |
| Faz 1 — Güvenli temel | DEVAM EDİYOR — M1-T01 PASS, sırada M1-T02 |
| Faz 2 — Müşteri/poliçe domain'i | BAŞLAMADI |
| Faz 3 — Yenileme ve takip | BAŞLAMADI |
| Faz 4 — Belge ve iletişim | BAŞLAMADI |
| Faz 5 — Raporlar ve operasyon arayüzü | BAŞLAMADI |
| Faz 6 — Veri aktarımı | BAŞLAMADI |
| Faz 7 — Üretim kabulü | BAŞLAMADI |

Yerel uygulama kabuğu ve otomatik testler vardır. DB migration, staging/production deployment, gerçek veri importu veya Cloudflare remote mutation yapılmadı. M1-T01 yerel kalite ve adversarial güvenlik kapılarını geçti; checkpoint sonrası M1-T02 Worker route/SPA/API sınırına geçilecektir.

## Doğrulama kanıtı

- Taşıma sınırları: kaynak ve hedef mutlak yolları `C:/Users/sinan/Desktop/panel/` altında doğrulandı; mevcut hedefin üzerine yazılmadı, reparse point taşınmadı.
- Dosya bütünlüğü: 22/22 SHA-256 eşleşti.
- Son kontrol: aktif projede yalnız dört güncel Markdown dosyası var; nihai planın 20 ana bölümü mevcut, TODO/TBD yer tutucusu yok. Aktif dosyalar ve arşiv bilgi dosyasının yerel bağlantılarında kırık hedef bulunmadı. Arşiv manifest özeti bağımsız yeniden hesaplamada da eşleşti.
- Sıralı eski göreli yol + SHA-256 manifest özeti: `BFBE2F1DE54D223101F698D8BFD56488C4344B3478BE6937779ACE73A65CE838`.
- Bu aşamada doğrulama doküman, bağlantı ve arşiv bütünlüğü kapsamındadır; uygulama testleri faz kabul kapılarına bırakılmıştır.
- Son M1-T01 yerel kapısı: `npm ci`, format, lint, typecheck, 40/40 test, Vite production build, Wrangler `--dry-run` Worker build ve `verify:boundaries` başarılı.
- `.env` ignore edildi ve tracked değil; dal `main`. Remote Cloudflare işlemi veya production veri kullanımı yapılmadı.
- Son adversarial fixture matrisi 22/22 geçti: doğrudan/dolaylı process, global nesne zincirleri, Reflect ve require alias varyantları reddedildi; yerel shadow/property/string/comment örnekleri kabul edildi; junction, Vite genişletme/öncelik ve çift kodlanmış secret sızıntısı tekrar doğrulandı. BLOCKER veya IMPORTANT bulgu kalmadı.

## Kurulum girdileri

Yeni mimari karar sorusu yoktur. Nihai planın 17. bölümündeki gerçek owner email'i, MFA/Access bilgileri, ayrı backup hesabı, hukuki retention profili ve işletim kişisi gibi değerler ilgili üretim kapısında doğrulanacaktır. Bunların hiçbiri sahte bilgiyle doldurulmadı; bağımsız sentetik geliştirmeyi engellemez.

## Sonraki tek görev

**M1-T02 Worker route / SPA / API boundary temelini uygula.** `/api/*` JSON sınırını SPA fallback'ten ayır; static asset, doğrudan SPA navigasyonu, route önceliği ve unsupported method davranışlarını Worker seviyesinde test et. M1-T03'e geçme.

## Gelecek ajanların güncelleme biçimi

Her çalışma sonunda tarih/kapsam, değişen dosyalar, çalıştırılan test ve sonuç, migration ortamı, deploy durumu, varsa somut engel ve sonraki tek görevi buraya kaydet. Mimariyi bu dosyada tekrar tanımlama. Fazı yalnız kendi kabul kapısı gerçekten geçtiğinde TAMAMLANDI yap.
