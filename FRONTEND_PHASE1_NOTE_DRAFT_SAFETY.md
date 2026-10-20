# Phase1 — müşteri notu taslak güvenliği

20 Ekim2026. Dar kullanıcı yetkisi: profil not taslağı kaybını kapat; otomatik kayıt, backend iş değişikliği, yeni tasarım ve production yok. Korunan `UYGULAMA_DURUMU.md` bu kayıt yerine yazılmadı.

## Bağımsız değişiklik

- `src/app/pages/customers/CustomerProfilePage.tsx`: not alanı ilk ziyaretinde lazy mount olur, aynı müşteri bölüm değişiminde yalnız hidden sunumuna geçer. Customer-keyed ProfileWorkspace kimliği korunur.
- `src/app/pages/customers/CustomerNoteWorkspace.tsx`: yalnız profil notu için mevcut NavigationDecision/erken native POP sınırını kullanır. Aynı müşteri section geçişi serbest; farklı customer/route dirty durumunda açık karar ister. Stay tam aynı input/state'i korur. Pending/uncertain durumunda ayrılma engelli. Yeni genel router/guard framework'ü yok.
- `src/app/components/CustomerNotesSection.tsx`: dar risk yayını, açık Cancel ve uncertain request kilidi. Belirsiz request varken textarea/normal submit/Cancel kilitlenir; gecikmiş change handler da frozen body'yi değiştiremez. Aynı retry body/key kalır. Kabul edilmiş POST sonrası geçmiş GET hatası yeni POST üretmez; mevcut not geçmişini yeniden okuma kullanılır. Backend/idempotency/audit değişmez.
- `tests/customer-note-navigation.ui.test.tsx`:5 davranış testi; section/input DOM kimliği, başka müşteri+Stay/Cancel, pending tek submit, uncertain frozen retry ve validation failure/accepted-write GET-only recovery.

## Önce → sonra

Önce: not yaz → Genel bilgiler → Notlar: eski textarea unmount, metin boş. Yeni regresyon ilk koşuda1FAIL verdi; hata eski ve yeni textarea DOM kimliği ve içeriği arasındaydı.

Sonra: aynı geçişte textarea instance'ı ve boşluk/satır sonları dahil exact draft aynı. Section değişimi POST veya tekrar not GET'i üretmiyor. Başka müşteriye sessiz ilişki taşıma yok. Otomatik not yazımı yok.

Guard için ikinci RED testi Stay düğmesinin bulunmamasını gösterdi. Ek frozen-change negatifi önce RED verdi; handler kilidiyle GREEN. Tüm başarısız checkpoint'ler yeni faz kanıtlarında tutulur; önceki audit değiştirilmez.

## Gerçek otomatik kanıt

Not düzeltmesi navigasyon değişikliğinden ayrı, accepted main üzerinden oluşturulmuş4-file tree'de çalıştırıldı:

`customer-note-navigation.ui`5 + `customer-notes.ui`4 + `customer-pages.ui`12 + `customer-create-navigation.ui`5 = **26/26 PASS**,0FAIL/0skip. Aynı bağımsız tree'de tsc PASS. `customer-notes.api` gerçek yerel D1/API14/14PASS birleşik kabul koşusunda yeniden çalıştı: replay/concurrent duplicate, cross-agency, customized scope, live permission/session revoke, audit rollback ve archived sınırları dahil. Bu14 vaka frontend testinin mock'u değildir; endpoint kodu bu fazda değiştirilmedi.

Birleşik final UI koşusunda not navigasyonu5/5 ve eski operasyon guard'ları ayrıca geçti. Test koşuları aynı vakaları tekrar içerir; bağımsız26 ile toplam310 yeniden toplanmaz. Tam envanter `phase1-navigation-evidence/tests-summary.json` dosyasındadır.

## Tarayıcı ve kabul — LOCAL GO

Gerçek görünür Edge155.0.4283.62 nihai koşusu exit0: OWNER/Ahmet×1440/360 **4/4 hücre PASS**. Her hücrede notun aynı DOM/değerle section ve browser Back/Forward geçişinde kalması, native POP ile Task'a çıkışta Stay, explicit Cancel, pending ayrılma engeli ve gerçek POST yanıtı kaybında same body/key retry ile DB'de1not doğrulandı. İlk başarısız kurulumlar ve nihai kapsam `FRONTEND_PHASE1_NAVIGATION_INTEGRITY.md` ve `phase1-navigation-evidence/` altında ortak tutulur. Ayşe/768 bu fazda yeni hücre değildir. Eski araştırmanın14PNG'si bu fazın yeni kanıtı değildir.

Karar: **not taslak güvenliği LOCAL GO**. Protected belge hash'i beklenenle aynı; mevcut UX-002 hunk'ları bu bağımsız değişikliğe alınmaz. Production/ops kabulü değildir.

## Sınırlar

Taslak yalnız mounted React belleğinde. Refresh/browser kapanması için native uyarı mutlak garanti değildir; private draft/request browser storage'a yazılmaz. Logout/authority loss protected state'i kapatabilir; bu taslağı yeni müşteri/oturuma taşıma gerekçesi değildir. İletişim/şirket yetkilisi formlarının genel redesign'ı veya tüm legacy guard migrasyonu bu değişiklikte yapılmadı.

Not değişikliği bağımsız commit scope'u: yukarıdaki4 kaynak/test + bu kanıt dosyası. CustomerProfilePage içindeki Task dönüş import/JSX/state hunk'ları not commit'ine alınmaz; ikinci navigasyon değişikliğinde ayrı kalır. UX-002 ve protected dosya hiçbir biçimde bu scope'a alınmaz.
