# Faz 2 — Müşteri poliçe görünürlüğü

Bu belge yalnız bu fazın uygulama ve doğrulama kaydıdır; mimari otorite veya yeni yol haritası değildir. Mimari otorite mevcut `NIHAI_MIMARI_VE_UYGULAMA_PLANI.md` dosyasıdır.

Karar: LOCAL GO. Yerel test/kalite kapıları ve Edge matrisi tamamlandı. Bağımsız son salt okunur kaynak incelemesi GO verdi; doğrulanmış BLOCKER/IMPORTANT bulgu yok. İnceleyen yeni test çalıştırmadı; kaynak ve mevcut artefaktları inceledi. Ayrıntı: `independent-review.md`. Bu kayıt tek başına commit/push kanıtı değildir.

## Gerçek değişiklik

- Modern müşteri kimliği/header altında bağımsız yüklenen, erişilebilir “Sigorta özeti”: yürürlükteki poliçe sayısı, gerçek branş adları, en yakın bitiş ve en fazla üç gerçek poliçe bağlantısı.
- Müşteri satırlarında üçe kadar gerçek branş etiketi, diğer branşların `+N` sayısı, yürürlükteki poliçe sayısı ve en yakın bitiş. Dar görünüm yalnız bu tabloya ait kart yerleşimini kullanır. Sidebar rengi ve genel tasarım değiştirilmedi.
- Tam ilgili poliçe geçmişi 20 kayıtlık sayfalarda korunur. Poliçe numarası yanında gerçek ürün/sigortacı/branş adları gösterilir. “Kayıt durumu” ile bitiş tarihi ayrı etiketlenir; arşiv ayrı belirtilir.
- Aynı doğrulanmış SPA ömründe müşteri araması, tür seçimi, uygulanan filtre, cursor zinciri ve profil açılırkenki kaydırma konumu korunur. Sunucu DTO’ları cache’lenmez; listeye dönünce yetkili veri yeniden okunur. Arama navigasyon URL’sine, localStorage veya sessionStorage’a yazılmaz. Mevcut HTTP arama API’sinin query sözleşmesi değiştirilmedi.
- İlgili poliçe/yenileme sayfalama linkleri mevcut `workReturn` state’ini taşır. RED testinde poliçe sayfasını değiştirdikten sonra kaybolan tam Task A dönüşü düzeltildi. Not çalışma alanının mounted taslak yapısı değiştirilmedi.

## Sunucu okuma sözleşmesi

- `GET /api/customers?limit=20&include=coverage`: yalnız mevcut yetkili müşteri sayfasına `coverage` alanı ekler. Opt-in özet sayfası en fazla 20 müşteridir. `include` verilmezse eski DTO ve 100’e kadar eski sayfa sınırı korunur. Arama/tür/cursor eski servis üzerinden işler.
- `GET /api/customers/:customerId/coverage`: tek müşterinin aynı yetkili projeksiyonu. Yok/yetkisiz müşteri için veri dönmez.
- `GET /api/policies?customerId=...&pageSize=20&includeLabels=true`: mevcut yetkili, filtreli, cursor’lı poliçe listesine tarihsel katalog display name’lerini ekler. Opt-in yoksa eski DTO davranışı korunur.
- `activePolicyCount` bu projeksiyonda “bugün yürürlükte” sayısıdır: `ACTIVE`, arşivlenmemiş ve `start_date <= acentenin yerel bugünü <= end_date`. Ham `ACTIVE` durumunu vadesi dolmamış olmakla karıştırmaz. `asOfDate` ve `timezone` açıkça döner.
- `CANCELLED`, `VOIDED`, arşiv, süresi dolmuş, henüz başlamamış ve bozuk takvim tarihleri ayrı sınıflanır; yürürlük sayısına eklenmez. Sayaçlar sayfalı poliçe örneklerinden çıkarılmaz. Tekrarlanan aynı branş tek etikette gruplanır; poliçeler ayrı sayılır.
- En yakın vade yalnız halen yürürlükte olan, görüntülenebilir poliçelerden seçilir. Yenileme tarihi veya yeni iş kuralı türetilmez. Özette branş etiketleri ve poliçe örnekleri en fazla üçtür; tam kayıt geçmişine doğrudan sayfalı erişim vardır.
- Poliçe sahibi yalnız `policies.customer_id` ilişkisidir. Sigortalı/lehtar taraf kaydı sahiplik diye sayılmaz.
- Katalog isimleri aynı acentenin gerçek insurer/product/branch kayıtlarından join edilir; seçilebilir katalog listelerinden veya sabit isim/ID sözlüğünden türetilmez. Pasif tarihsel katalog adı korunur. Dahili katalog ID’leri çalışan metnine basılmaz.

## Yetkilendirme ve veri sınırı

- Mevcut `customer.read`, `policy.read`, etkin üyelik/session ve ASSIGNED/AGENCY kapsamları kullanılır. Son batch sınırında güncel müşteri erişimi ve canlı session tekrar doğrulanır.
- HEALTH için OWNER dahil açık hassas izin gerekir. İzin dışı poliçeler sayıya, etiketlere, `+N` değerine veya örneğe katkı yapmaz.
- Poliçe okuma yetkisi yoksa `available=false`, sayaçlar `null`: yanlış “0 poliçe” sonucu verilmez. Hata/yükleniyor durumu da boş portföy diye gösterilmez. Gösterilen sayılar yalnız çalışanın görüntüleyebildiği poliçelere aittir.
- Task tablosu/özel çalışan kuyruğu özet sorgusuna katılmaz. Ortak müşteri görünürlüğü özel Task yetkisini genişletmez.
- Özet ek TC/VKN, iletişim, prim, özel not, Task veya tıbbi alan açmaz. Doğrudan poliçe linkinde yalnız mevcut kayıt kimliği kullanılır; kayıt ekranı kendi yetkilendirmesini uygular.
- Yeni iş verisi mutasyonu, migration, dependency, framework, dağıtım veya R2/Documents aktivasyonu yoktur. Canlı yetki fence’i mevcut D1/session assertion mekanizmasını kullanır; iş tablolarına yazmaz.

## Sorgu maliyeti

Bir veya yirmi müşteri için bir aggregate SELECT çalışır; müşteri başına poliçe SELECT’i yoktur. Ön yetki okumaları ve son assertion/session guard’ları ayrıca sabit maliyet taşır. `EXPLAIN QUERY PLAN` testi mevcut müşteri/poliçe indeksinin kullanımını doğrular. Veritabanı, seçili müşterilerin yetkili geçmişini kesin saymak için okur; bu maliyet geçmiş büyüklüğüyle artar. Bütün portföy tarayıcıya aktarılmaz. Bu, sabit süre veya 15.000 poliçede ölçülmüş performans iddiası değildir.

## Çalıştırılmış doğrulama

Yeni kanıt klasöründeki altı log kopyasında yalnız satır sonu boşlukları/son boş satırlar diff-check için temizlendi; test çıktısı ve sonuçlar değiştirilmedi. Ham özgün koşu logları `node_modules/.cache/phase2-*.log` yollarında korunur. Önceden mevcut tarihsel kanıtlara dokunulmadı.

- Yeni D1/API özet testleri: 14 PASS. Katalog adları, sıfır/bir/çok/tekrar eden tür, 20’nin ötesinde kesin sayım, durum/tarih/arşiv, HEALTH, OWNER/MEMBER/ASSIGNED, yabancı acente, taraf-sahip ayrımı ve son sınırda erişim/session kaybı kapsanır.
- Aynı son API koşusunda mevcut policy browsing: 6 PASS. Toplam 20/20; skip yok.
- Son etkilenmiş UI koşusu: 14 dosya, 121/121 PASS; skip yok. Bunun içinde yeni 8 UI testi, müşteri/not taslakları, gerçek Task dönüşü, müşteri/şirket oluşturma ve poliçe form/liste regresyonları vardır.
- Önceki birleşik komşu koşuda ayrıca `customers.identity.auth` 11/11 ve `task-context.api` 8/8 tamamlandı. O koşunun bir yeni UI testi asenkron yüklenmiş metni senkron aradığı için başarısızdı; bekleme düzeltilerek tüm etkilenmiş UI dosyaları yukarıdaki son koşuda tekrar geçti.
- İlk geniş koşu dış 420 saniye sınırında kesildi. Kesilmeden tamamlanan Task işlemleri 10/10, müşteri notları 14/14 ve müşteri gündelik API 4/4 kanıtı korunur. Aynı koşuda policy browsing 6/6 geçti; son 20’lik koşuda tekrar geçtiği için iki kez sayılmaz.
- Böylece farklı tamamlanmış shard’larda 21 benzersiz dosyada 188 benzersiz test PASS kanıtı vardır. Bu, 188 testlik tek kesintisiz veya tüm-repo koşusu iddiası değildir. İlk başarısızlık/timeout kayıtları silinmedi.
- Son temiz kabul ağacında typecheck, focused ESLint, tam format check, client build ve gerçek security boundary checker PASS. Worker `deploy --dry-run` PASS; deployment yapılmadı.
- İlk node_modules-altı izolasyon Node’un TS stripping kısıtına takıldı; son standart kapılar Temp altındaki kabul ağacında çalıştı. İlk CSS module import’u boundary checker tarafından reddedildi; projenin mevcut `index.html` stylesheet bağlantısı modeli kullanılarak düzeltildi ve kapılar tekrar geçti.

## Edge kanıtı ve sınırlamalar

Kabul edilmiş main ile UX-002 hariç aynı kontrollü kaynak ağacının sentetik OWNER/Ahmet/Ayşe hesaplarında 1440/768/360px önce görüntüleri alındı: `before-attempt1/`. Bunlar önce kanıtıdır, yeni özelliğin kabul testi değildir.

Sonrası gerçek görünür Microsoft Edge (`msedge`, headless=false, tamamlanan koşuda 155.0.4283.62) matrisi 9/9 tamamlandı: OWNER/Ahmet/Ayşe × 1440/768/360px. İlk koşu 240 saniyede kesilmeden dört tam hücre tamamlandı; kalan beş hücre ayrı koşuda 5/5 ve exit 0 ile tamamlandı. `edge-results.json` benzersiz dokuz hücreyi birleştirir; timeout’u dokuzlu başarıya çevirmeden her satırın kaynağını belirtir.

Her hücrede gerçek katalog ve sayım, liste poliçe sorgusu fan-out olmaması, profil/poliçe klavye bağlantısı, durum-dönem ayrımı, liste arama/tür/cursor/kaydırma dönüşü, sayfalı tam geçmişten Task A’ya dönüş, mounted not taslağı/POP/Stay/iptal ve boş browser storage kontrolleri geçti. Liste ve profil yatay taşma kontrolleri geçti; her hücrede runtime page error sayısı sıfır. Önce 18 ve sonra 18 olmak üzere 36 gerçek PNG kaydı `edge-results.json` içinde dosya/hash olarak doğrulandı. Bu programatik iş akışı ve DOM geometri kontrolüdür; kapsamlı manuel görsel/a11y audit’i iddiası değildir.

15.000 poliçelik performans benchmark’ı, tüm-repo test paketi, gerçek müşteri verisi, dış mesaj, production deployment, OPS-001 veya Faz 3 çalıştırılmadı.

## Mevcut çalışmanın korunması

Başlangıç HEAD: `e66e49b4ccbac8b74511bd07916cc93d37ed58ad`. İlk index boştu. 19 kaynak/test dosyalık allowlist başlangıçtaki kirli dosyalarla kesişmiyor. Kabul ağacı HEAD + yalnız bu allowlist ile üretildi; UX-002 kaynakları baseline HEAD sürümünde kaldı.

Başlangıçtaki 212 mevcut kirli/untracked dosya bayt hash’leriyle karşılaştırıldı, değişmedi. `UYGULAMA_DURUMU.md` mevcut yerel değişikliğiyle korundu; reset/stash/clean/edit/stage/commit yapılmadı. Beklenen/korunan SHA256: `f272a14efce57f2ef47d960c2ac387e11cdaeda96aa6fda71db8585844e28930`.

UX-002’nin TodayWorkPage/RenewalQuotesSection/today-work.css ve renewal-quotes-modern test değişiklikleri; aday belgesi; bağımsız audit ve eski kanıtlar bu faza dahil edilmedi. Ayrı `preservation-initial.json` ve `source-allowlist.json` kanıtları eklidir.

Bu kayıt korunan uygulama durumu belgesini değiştirmek yerine faza özgü kanıt olarak tutulur. Yayın sınırı yalnız `source-allowlist-final.json` içindeki 19 kaynak/test dosyası ve bu yeni kanıt klasörüdür. Commit SHA ve uzak HEAD eşitliği Git readback ile ayrıca raporlanır; önceden yapılmış gibi yazılmaz. Sonraki tasarım sprinti veya production operasyonu için yetki verilmiş sayılmaz.
