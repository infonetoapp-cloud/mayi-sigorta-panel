# UX-003 — Türkçe parasal giriş ve gösterim

Yerel fonksiyonel kabul: GO. Production GO, OPS-001 kabulü veya Phase 3 görsel onayı değildir.
Başlangıç: `cb5bd6cc2e80aa6099b42b9bcffce0eba91f45ce` (canlı uzak main doğrulandı). Ayrı `C:/Users/sinan/Desktop/panel-ux003`, `fix/ux003-money-input` worktree/branch. Kirli Phase 3 çalışma ağacıyla kod karıştırılmadı.

## Dar kapsam ve davranış

- Poliçe oluşturma/düzenleme; teklif oluşturma ve değişmez sürüm; WON CREATE_POLICY; doğrudan ilişkili imzalı zeyil prim farkı.
- Tek UI ayrıştırıcısı: `12500,50`, `12500.50`, `12.500,50` → canonical `12500.50` → BigInt `1250050` minor. Önceden virgül destekleyen teklif yolu aynı ayrıştırıcıya delege edilir.
- `12.500`, `12,500`, `12,500.50`, bozuk gruplama, ikiden fazla ondalık, izin verilmeyen eksi, bilimsel gösterim, NaN/Infinity ve safe-integer taşması reddedilir; tahmin/yuvarlama yok. Gruplama yalnız açık ondalık virgülüyle kabul edilir.
- Mevcut finans sözleşmesi bütün desteklenen para birimlerinde iki minor basamaktır. JPY gibi ISO'da farklı fraction-digit varsayımları olan birimler yeniden ölçeklenmez. Gösterimde yalnız integer grouping ve currency etiketi için Intl kullanılır; tutar dönüşümü BigInt'tir. Örnek `12.500,50 ₺`; USD/CAD/AUD etiketleri `$`/`CA$`/`AU$` ayrımını korur.
- Alan yazılırken ham taslak değiştirilmez; canonical değer yalnız yeni request/review snapshot'ında oluşturulur. Frozen body/key, CAS, accepted-write GET-only recovery ve mevcut controller'lar korunur. Ayırıcı değiştirmek tek başına poliçe PATCH'i üretmez.
- Backend/shared/db/migration/config/dependency/financial-domain değişikliği yok. Renk, CSS ve workspace yerleşimi değiştirilmedi. Private taslak için storage eklenmedi.

## Gerçek kabul sonuçları

- Son ilgili unit/UI paketi: 12 dosya, 306 PASS, 0 FAIL, 0 SKIP. Para sınırları, input grammar, canonical snapshot; poliçe create/edit/zeyil; quote create/revision/SENT; WON; task navigation, customer note ve coverage regresyonları.
- Gerçek yerel D1/API: poliçe paketi 9 PASS; seçilmiş WON 8 PASS/18 filtreli; seçilmiş quote 4 PASS/9 filtreli. Toplam 21 PASS, 0 FAIL, 27 filtreli; tam backend suite iddiası yok.
- Görünür Microsoft Edge, final bundle: OWNER 1440, Ahmet 360, Ayşe 768. Her biri üç gerçek para girişi, belirsiz girişte sıfır POST, committed-response-loss sonrası aynı body/key ile exact retry, gerçek CAS PATCH sonrası enjekte GET503 ve GET-only recovery, gerçek quote create/revision ve WON CREATE_POLICY/allocated premium D1 readback. Runtime error 0. `*-final/result.json` ve ekran görüntüleri kanıttır. Önceki iki `owner-desktop`/`ahmet-mobile` koşusu son currency-label ayrımından önceki supporting evidence'dır; final koşularla karıştırılmaz.
- Typecheck, repo lint, client build, Worker top-level dry-run, source/client security boundaries, diff-check PASS. Worker log `--dry-run: exiting now`; çoklu environment uyarısı saklıdır, production build/deploy/readback iddiası yok.
- İlk varsayılan `npm run format:check` FAIL: Windows `core.autocrlf=true` checkout CRLF'leri ve henüz biçimlendirilmemiş iki yeni JSON raporu dahil 585 uyarı. Mevcut dosyalara toplu write yapılmadı. Salt-okunur `prettier --check --end-of-line auto .` PASS; onaylı kaynak/test ve yeni evidence üzerinde varsayılan scoped format ayrıca kontrol edilir. Bu istisna normal default repo-wide PASS diye sunulmaz.
- İlk RED para/WON/zeyil/currency logları ve ilk API/UI başarısızlık raporları korunur; final sonuç yerine sayılmaz. İlk API testinin varsaydığı 400, mevcut değişmemiş backend'de gerçekte 500 idi; test bu gerçeği ve sıfır kalıcılığı açıkça kaydeder.

## Açık sınırlar

Doğrudan API'ye canonical olmayan `12500,50` göndermek mevcut backend'de 500 üretir; finansal yazma yoktur. Yeni UI bu isteği göndermez. Backend hata sınıflandırması bu frontend diliminde değiştirilmedi. Windows çalışma kopyasının default CRLF format hatası ayrı tutulur; kanonik Git ağacında biçim borcu olduğu iddia edilmez.

Format kapısının son doğrulaması: staged Git index `git -c core.autocrlf=false checkout-index --all --prefix=<isolated-temp>/` ile ayrı Temp dizinine çıkarıldı. Aynı Prettier sürümüyle bu ağacın tamamında varsayılan `--check .` PASS. Repo/config/çalışma dosyalarının EOL ayarı değiştirilmedi. Böylece ilk çalışma-kopyası FAIL saklanırken yayımlanacak kanonik Git içeriği ayrıca doğrulandı.

Phase 3 candidate ve 19443 önizlemesi UX-003'e yükseltilmedi. Aşama A'da HTTP200 alındı; kapanışta 19443 bağlantıyı reddetti (WinError10061), yeniden başlatılmadı. Kaynak/bundle hash'leri ve geçmiş HTTP200 kanıtı korunur; son okuma `phase3-technical-closeout/final-preview-readback.json` içindedir. Phase 3 teknik snapshot/manifest yalnız orijinal çalışma dizininde `phase3-technical-closeout/` altındadır; adayın görsel onayı PENDING, aday commit/push edilmez. Original `main` HEAD'i eski base'de bilinçli korunur; yeni uzak main ile kirli adayın ileride uzlaştırılması ayrıca yapılmalıdır.

Edge kapsamı üç rol/genişlik eşleşmesidir; dokuz hücrelik matris veya fiziksel mobil klavye/gerçek personel onboarding kabulü değildir.

## Yeniden çalıştırma

`acceptance.json` test raporlarını; `manifest.json` exact kaynak, bundle ve evidence/Git-blob hash'lerini; `allowlist.json` commit dosyalarının tamamını tanımlar. `logs/` tarihçeyi korur. `.log.json` sarmalayıcıları komut çıktısını `rawText` ve `rawSHA256` ile byte-exact saklar; padding/son boş satırlar silinmeden diff-check yapılabilir. İlk staged diff-check raw log whitespace nedeniyle FAIL oldu; uygulama kodu değiştirilmeden bu kayıpsız evidence paketiyle kapatılır.

- `npx vitest run tests/ux003-money-input.test.ts --maxWorkers=1`
- `npx vitest run tests/policy-forms.api.test.ts --maxWorkers=1`
- `npm run typecheck`; `npm run lint`; `npm run build:client`; `npm run build:worker`; `npm run verify:boundaries`; `git diff --check`
- Tam ilgili UI/API seçimleri rapor JSON dosyalarındaki exact dosya/test adlarından yeniden üretilebilir; seçilmiş API durumları SKIP olarak kalır.
- Final Edge: `npm run build:client` ardından Windows'ta ayrı ve boş UX003_RUN değerleriyle `UX003_RUN=owner-new UX003_ACTOR=owner node.exe tests/browser/ux003-money.smoke.mjs`, aynı komutta `ahmet` ve `ayse`. Microsoft Edge kurulumu ve Node bağımlılıkları gerekir. Harness yalnız 20443'te geçici sentetik D1/API çalıştırır ve kapatır; 19443'e dokunmaz. Parolalar rastgele/ephemeral, raporlanmaz.

OPS-001 yürütme sınırı `OPS001-next-boundary.md` içindedir. Production mutation, deployment, gerçek müşteri verisi, external message, ücretli kaynak ve Documents/R2 enablement yoktur.
