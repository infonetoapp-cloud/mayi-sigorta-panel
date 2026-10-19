# Quote kimliği bütünlüğü — dar backend düzeltmesi

## Kapsam ve karar

Başlangıç HEAD: `2b06394882cccc405a05c322437db4ef9e043884`.
Mimari otorite: `MayiSigorta_CRM_Planning_Pack_v2/NIHAI_MIMARI_VE_UYGULAMA_PLANI.md`, bölüm 7.3.
Farklı insurer/product alternatifi yeni Quote; aynı Quote'un sürümleri ilk değişmez sürümün insurer/product kimliğine bağlıdır.

Yalnız `src/server/renewals/engagement.ts`, bağımsız backend regresyon dosyası `tests/renewal-quote-identity.api.test.ts` ve bu kanıt commit kapsamındadır.
Phase 4D frontend adayı, mevcut modern API/UI testleri ve mevcut plan/durum değişiklikleri commit kapsamı dışındadır.
Phase 4D **NO-GO** kalır; bu backend düzeltmesi frontend kabulü değildir.

## RED → GREEN

- Değişiklik öncesi gerçek yerel D1/API: `npx vitest run tests/renewal-quotes-modern.api.test.ts -t 'preserves the same quote identity' --maxWorkers=1`.
  Sonuç: **1 FAIL / 12 filtre skip**, 44.28s. Beklenen HTTP409/1 sürüm/orijinal kimlik; gerçek HTTP201/2 sürüm/alternatif insurer-product. Skip PASS sayılmadı.
- Aynı mevcut dosya düzeltme sonrası bütünüyle: **13/13 PASS**, 196.81s. Orijinal negatif test ve dosya byte'ları değiştirilmedi.
- Yeni bağımsız backend dosyası: **11/11 PASS**, 138.34s.
- Mevcut terminal entegrasyon dosyası: **19/19 PASS**, 287.18s.
- Son dosya-bazlı doğrulanmış toplam: **43/43 PASS**. Tüm tarihsel repo suite'i veya frontend kabul paketi tekrar çalıştırılmış sayılmaz.

Son komutlar:

```text
npx vitest run tests/renewal-quote-identity.api.test.ts --maxWorkers=1
npx vitest run tests/renewal-quotes-modern.api.test.ts --maxWorkers=1
npx vitest run tests/renewals.m3-t03-terminal.test.ts --maxWorkers=1
```

Tarihsel ara sonuçlar korunur: yeni dosyanın ilk koşusu 9PASS/2FAIL verdi. Bir fixture var olmayan `is_active` kolonunu kullandı; gerçek `status` kolonuna düzeltildi. Diğer beklenti replay'in değişken timestamp/replayed üst alanlarını eşit saydı; sözleşmedeki original `data` eşitliği kontrol edildi. Backend'i gevşeten düzeltme yapılmadı. İlk odaklı format kontrolü yalnız yeni test dosyasında uyarı verdi; yalnız o dosya formatlandı. Üç dosyalık birleşik koşu araç sınırında 420s timeout verdi ve toplu PASS sayılmadı; yukarıdaki dosya-bazlı koşular açık sonuçla tamamlandı.

## Uygulama ve atomiklik incelemesi

- `createRenewalQuoteVersion`, mevcut authorization/receipt replay ve quote CAS/ACCEPTED kontrollerinden sonra `version_number=1` satırını agency+quote kapsamında okur. Eksik orijinal veya insurer/product farkı HTTP409 ile reddedilir. Current pointer, en büyük sürüm veya poliçe varsayılanı kimlik otoritesi değildir.
- Mevcut D1 batch'inde authority assertion ve receipt INSERT'ten sonra, ilk business INSERT'ten önce gerçek `d1_cas_assertions` SQL assertion'ı vardır. Agency+renewal+quote+v1+insurer+product birlikte eşleşmelidir.
- Receipt INSERT'in assertion önünde kalması mevcut aynı-key unique-race reconciliation sırasını korur. Assertion hatası tüm batch'i, receipt dahil geri alır. Mevcut assertion trigger'ı ABORT üretir; mevcut hata eşlemesi bunu HTTP409 yapar. Başarılı assertion satırı mevcut cleanup trigger'ıyla silinir.
- Identity assertion sonrasında version INSERT, current-pointer/CAS UPDATE ve SUCCESS audit aynı batch'tedir. JavaScript'te batch sonucuna bakıp sonradan ret yoktur.
- SQL yeni dinamik identifier/interpolation almaz; agency/renewal/quote/kimlik değerleri bind parametreleridir. Yeni audit metadata, serbest metin kopyası, log, secret, network erişimi veya yetki genişletmesi yoktur.
- Exact receipt replay yeni iş kurallarının önünde bırakıldı. Testte eski kusurlu kimliğe sahip tarihsel v2+receipt fixture'ı aynı sonucu yazımsız replay eder; yeni key ile aynı alternatif reddedilir. Eski immutable row onarılmış/yeniden yazılmış sayılmaz. Orijinal v1 kimliğiyle yeni revizyon mümkündür.
- `createRenewalQuote` ayrı alternatiflere açık kalır; `sendRenewalQuote` yeni sürüm yaratmaz. Version yazan public route aynı domain fonksiyonuna gider. Şema/migration/trigger değiştirilmedi; bu servis düzeltmesi yetkili doğrudan SQL yöneticisine karşı yeni bir DB-wide trigger kuralı iddiası değildir.

İnceleme uygulayıcının kaynak/çağrı yolu/SQL ve test incelemesidir; bağımsız reviewer/ikinci ajan raporu değildir. Projenin ayrı ajan için açık kullanıcı izni kuralı nedeniyle başka ajan başlatılmadı. İncelenen dar değişiklikte açık güvenlik/atomiklik engeli bulunmadı; tüm uygulama için yeni güvenlik kabulü verilmedi.

## Kalıcı test kanıtı

- Aktif farklı insurer+product, aynı insurer altında farklı product ve insurer-only sapmaları HTTP409; tüm iş/evidence snapshot'ları aynı.
- Geçerli same-identity revizyon ve iki alternatif için ayrı yeni Quote; orijinal immutable v1 aynen korunur.
- Üç adversarial preflight fixture'ında yalnız kimlik SELECT sonucu yanıltılır; batch SQL'leri değiştirilmeden gerçek D1'e gider. Farklı insurer/product, aynı insurer/farklı product ve eksik v1 durumlarında batch'e ulaşıldığı ve gerçek assertion'ın ret verdiği doğrulanır.
- Ret sonrası quotes/pointer/version, versions, events, receipts, audit, renewal, Task ve assertion tablolarının exact snapshot'ı değişmez. Yeni receipt veya SUCCESS audit kalmaz.
- Divergent historical current/latest row yerine v1 pin'i ve tarihsel exact receipt replay korunur.
- Daha yeni revizyon, LOST ve pasif katalog sonrasında exact eski key/body eski sonucu döndürür; aynı key/değişen payload409 ve yazım yoktur.
- İki istek son batch öncesinde barrier'da buluşur: aynı key `[200,201]` ve aynı original data; farklı key/aynı CAS `[201,409]`. Her iki yarışta yalnız bir yeni version, bir receipt ve bir audit; current pointer ve CAS tutarlı.
- Mevcut modern API dosyası OWNER/MEMBER, tenant/HEALTH/session, lifecycle, CAS, immutability, create-race ve send/WON yollarını; terminal dosyası mevcut sonuçlandırma/replay akışlarını doğrular.

## Kalite ve korunma

`npm run lint`, `npm run typecheck`, iki değişen kaynak/test dosyasının Prettier check'i, `npm run build` (client + Worker **yalnız dry-run** + boundaries), `git diff --check`: **PASS**.
Wrangler'ın mevcut çoklu environment seçim uyarısı vardır; gerçek deploy yapılmadı.

Başlangıçtaki 12 kirli/untracked dosyanın SHA256 envanteri repo dışında tutuldu; son karşılaştırmada 12/12 aynı, drift0. Korunan `MayiSigorta_CRM_Planning_Pack_v2/UYGULAMA_DURUMU.md` SHA256:

`f272a14efce57f2ef47d960c2ac387e11cdaeda96aa6fda71db8585844e28930`

Durum belgesi kullanıcı talimatıyla byte-for-byte korunur; bu görevin kanıtı buradadır. Frontend adayına reset/clean/stash/overwrite uygulanmadı. Yalnız explicit allowlist dosyaları stage/commit edilir; mevcut untracked modern API regresyonu da frontend adayının parçası olarak dışarıda kalır.

Production deployment, Cloudflare kaynak mutasyonu, yeni migration, Paid servis, gerçek müşteri verisi, document veya R2 aktivasyonu yoktur. Yerel testler disposable D1 ve sentetik verilerle çalışır. Phase 4D'nin tamamlanması ve kabulü ayrıca yetkilendirilmelidir.
