# OPS-001 — entegrasyon kabul kaydı

Durum: **READY — review/commit hazırlığı**. Commit/push ve production deployment yapılmadı.

## Kaynak ve kapsam

- Entegrasyon branch'i: `ops/ops001-recovery-integration`; taban/HEAD `44c314b8ee522c6593448aa2c44fdbfe03f4fa6b` (doğrulanmış güncel origin/main).
- Ana Desktop/panel worktree'sinin `cb5bd6cc2e80aa6099b42b9bcffce0eba91f45ce` HEAD'i ve onaysız Phase3 UI değişiklikleri korunur. Geçici panel-ux003 worktree'sinin benzersiz içeriği ve diğer eski recovery worktree/kanıt klasörleri hash doğrulamalı özel arşive alındıktan sonra ayrı OWNER temizlik yetkisiyle Desktop'tan kaldırılmıştır. Protected planning/durum belgeleri değiştirilmez; bu dosya recovery entegrasyon durumudur.
- Başarılı dört-batch QUERY_BATCH yöntemi ortak provider CLI'ye bağlandı. Exact checkpoint/resume, tek writer, durable journal, deterministic authority metadata, kaynak ve finans/audit doğrulaması ile owned cleanup korunur. Pending phase cleanup yalnız readback yapar; kalan restore fazlarını yürütmez. File import uyumluluk yolu ayrı ve otomatik fallback kapalıdır.
- Test sonuçları artık historical evidence klasörlerine yazılmaz. Her fixture kendi geçici dizininde üretilir; kalıcı source producer Git'tedir. Başarılı remote deneyin exact source bundle'ı OS Temp'ten özel retained arşive alınıp hash-exact korunur; güncel CLI bu kalıcı kopyadan OFFLINE_DRY_RUN/providerRequests0 ile doğrulandı.

## Gerçek doğrulama

Önceki entegrasyon kapısında 18 ilgili test dosyasının dosya-bazlı izole koşuları: **305 PASS / 0 FAIL / 1 SKIP**. Skip, açık opt-in isteyen tarihsel private-source inspector'dır; bu görevde gerçek backup erişimi yasaktır ve opt-in kapalı tutulmuştur. Bu sayılar tek bir monolitik Vitest invocation iddiası değildir; her dosyanın JSON/log'u ve toplamı özel arşivde `validation/summary.json` altındadır.

Typecheck, root lint, repository-wide format check, client build, Worker yalnız dry-run, built-client/security boundary ve git diff-check: **PASS**.

Son Git kayıt öncesi kapı: provider37, provider-wire35, query-phase9, native query-batch2, retained-evidence4, auth restore63 ve boundaries51; yedi dosyanın bütün halinde ayrı-process koşularının son sonuçları toplam **201 PASS / 0 FAIL / 0 SKIP**. Ek whitespace düzeltmesinden sonra etkilenen retained-evidence ve boundaries dosyaları bütün halinde yeniden PASS verdi; ilk200 sonucu ayrıca korunur ve yeni toplamla toplanmaz. Typecheck/lint/full-format/client-build/Worker-dry-run/security-boundary/diff-check yeniden PASS. Bu sayılar önceki305 ile toplanmaz. Regresyon JSON/log'ları `git-integration-review/final-checks.json` altında saklanır. Final Git kontrolünde yeni Cloudflare isteği, commit, push, merge veya deployment yoktur.

İlk 300s operator timeout ile kesilen provider whole-file koşusu korundu; aynı provider dosyası filtrelemeden yeniden PASS verdi. İlk global format/boundary hatası 625 değişmemiş dosyadaki Windows CRLF–Prettier LF uyumsuzluğuydu. Salt-okunur end-of-line-auto tanılaması PASS verdi; yalnız `.prettierrc`'ye explicit native EOL politikası eklendi. SQL/migration/evidence veya ilgisiz UI dosyaları topluca yeniden formatlanmadı. Exact boundary dosyası ve tam format gate yeniden PASS verdi. İlk test TS Uint8Array/Buffer decoding type hatası TextDecoder ile düzeltildi; ilk hatalar silinmedi.

## Güvenlik ve kanıt ayrımı

Git kayıt hazırlığında ek bir taşınabilirlik kusuru gerçek checkout ile üretildi: `core.autocrlf=true`, hash-exact JSON receipt'lerini CRLF'ye çeviriyordu. İlk 33 dosyalık adaya yalnız bu kusur için `.gitattributes` eklendi; aday artık 34 dosyadır. Yalnız `/docs/recovery/evidence/**` kapsamında `-text` ve `whitespace=blank-at-eol,blank-at-eof,space-before-tab,cr-at-eol` kullanılır: normal whitespace kontrolleri korunurken immutable CRLF metadata yanlış trailing-space sayılmaz. Migration, uygulama kaynakları veya diğer belgelerin Git politikası değiştirilmez. Kalıcı regresyonlar RED→GREEN verdi; ayrı index ve boş checkout hedefinde `core.autocrlf=true` ve `false` ile dört evidence/manifest dosyasının byte-exact korunduğu doğrulandı. Normal index değiştirilmedi; commit/push yapılmadı. Bu son yerel Git kontrolleri ve yeni regresyon sonuçları özel arşivin `git-integration-review/` dizinindedir.

Git adayı yalnız source/test/runbook ve üç güvenli byte-exact tarihi receipt içerir. Raw SQL, SQLite journal, gerçek token ve eski Temp/Desktop bağımlılığı Git'e alınmaz. Source/credential taramasında hit yoktur. Eski worktree'lerin benzersiz kaynakları, binary patch'leri ve bütün anlamlı evidence/log/build çıktıları Git dışındaki hash-manifest/CAS arşivinde tutulur. Yeni Cloudflare deneyi yoktur; yalnız açık yetkili token-status GET yapılmıştır. Token revoke, credential dosyası silme veya production kaynağı değiştirme bu kabul kapsamında yapılmaz.

Gerçek önceki Cloudflare kabulü `evidence/2026-10-22/` içindeki SQL-only/synthetic/SEALED→owned-delete receipt'lerine aittir: 46 tablo, 114 satır, 23 migration, exact source/target ve authority proof. Güncel birleşik CLI'nin integration/resume hardening kanıtı yerel/native D1 + process-simulated provider testleridir; yeni bir remote kabul olarak sunulmaz.

Native `/import` D1_RESET_DO başarısızlığı korunur. HTTP authorization, remote fault injection, monitoring/deadman/alarm teslimi, populated sensitive-grant/tombstone genel production reconciliation, gerçek custodied backup, production RPO/RTO ve publication kapıları hâlâ ayrı/kanıtlanmamıştır. Provider-managed geçici staging object's absence iddia edilmez. Yeni migration, runtime auth/UI değişikliği, deploy, DNS veya ücretli kaynak yoktur.

Sonraki tek karar: bu scoped branch'in review'ı ve ayrı OWNER commit/push izni. Yeni remote veya production işi otomatik başlamaz.
