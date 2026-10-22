# OPS-001 — sentetik D1 kurtarma çalıştırma ve entegrasyon notları

## Kabul sınırı

22 Ekim 2026 gerçek Cloudflare D1 deneyi: 46 tablo (migration ledger dahil), 114 sentetik satır, 23 migration; kaynak/hedef şema ve bütün tablo fingerprint'leri, financial/receipt/audit/history/FK, bağımsız current-authority ve revoked credential/session kontrolleri PASS. Owned D1 tek DELETE ile silindi; exact UUID404 ve tam envanterde UUID/ad yokluğu ayrı readback ile doğrulandı. Güvenli, byte-exact tarihsel receipt'ler `evidence/2026-10-22/` altındadır; manifest SHA256 kontrolü `tests/recovery.retained-evidence.test.ts` içindedir. Bu receipt'ler yeni işlem yetkisi değildir.

Başarılı yöntem dört atomik REST `/query` batch'idir: schema → data → guards/views → authority. `FILE_IMPORT` eski API uyumluluğu için korunur; gerçek `/import` deneyi D1_RESET_DO ile başarısız kaldı. Başarılı upload bu import'u PASS yapmaz. Otomatik file-import/query fallback yoktur.

Bu entegrasyon gerçek deneyin query yöntemini ortak provider CLI, durable executor, kaynak doğrulama ve owned-cleanup yoluna bağlar. Güncel birleşik CLI ve deterministic resume hardening yalnız yerel/native D1 ve ayrı-process provider simülasyonunda test edilir; bu görevde yeni Cloudflare deneyi yapılmaz. HTTP authorization, monitoring/deadman/alarm teslimi, production RPO/RTO, gerçek backup custody, populated sensitive-grant/tombstone uzlaştırması ve publication kabulü verilmez. Provider-managed geçici staging object's absence kanıtlanmış değildir.

## Araçlar ve güvenli varsayılan

- Node 24 (`node:sqlite`), kilitli npm bağımlılıkları ve Wrangler 4.133.0 kullanılır. Yeni bağımlılık yoktur. Temiz checkout'ta `npm ci` ile kurulur. Windows native TLS testi OpenSSL ve curl.exe ister.
- `node scripts/recovery/executor-cli.mjs` ve `node scripts/recovery/provider-cli.mjs` varsayılan olarak OFFLINE_DRY_RUN; provider isteği 0'dır.
- `node scripts/recovery/executor-cli.mjs --generate-synthetic "<kalıcı-özel-dizin>/bundle"` yeni yerel sentetik kaynak, native/derived SQL, manifest ve ayrı current-authority fixture'ı üretir. Üst dizin önceden var olmalı; bundle dizini yeni olmalıdır. Yalnız hash pinleri çıktılanır; SQL ve tokenlar çıktılanmaz. Sonraki üretim yeni timestamp/hash verebilir; yeni fixture tarihsel hash diye sunulmaz.
- Bundle/options/run/journal dosyalarını repo ve Desktop dışında tutun. Raw SQL, credential, session verisi ve SQLite journal Git'e eklenmez. Kalıcı fixture üreticisi `synthetic-portfolio.ts` kodudur; testler kendi yeni özel fixture'larını üretir. Geçmiş Temp dizini veya Desktop evidence klasörü gerekmez.

Bir offline options dosyasının alanları:

```json
{
  "mode": "OFFLINE_DRY_RUN",
  "restoreTransport": "QUERY_BATCH",
  "bundleDirectory": "<özel-dizin>/bundle",
  "manifestSha256": "<generator manifestSha256 çıktısı>",
  "authorityPath": "<özel-dizin>/bundle/current-authority.json",
  "authoritySha256": "<generator authoritySha256 çıktısı>",
  "runId": "<yeni UUID>"
}
```

`node scripts/recovery/provider-cli.mjs --options "<options.json>"` kaynağı doğrular ve plan/code/source/authority pinlerini, queryBatches=4 ve fileImports=0 bilgisini üretir. Bu komut remote işlem yapmaz. Varsayılan legacy FILE_IMPORT olduğundan çalışan alternatif için QUERY_BATCH açıkça seçilir.

Canlı EXECUTE_REMOTE için ayrı yeni OWNER onayı, exact disposable account/name/EU/operation limits ve en fazla 15 dakikalık UTC pencere gerekir. `--live`, plan SHA'ya bağlı TTY challenge ve env'den token olmadan canlı capability kurulmaz. Options/receipt tek başına yetki değildir. Token kaynağı otomatik aranmaz; Desktop/1.txt okunmaz. Mevcut onaylar ve tarihsel -03 hedefi yeni deney için devralınmaz. Yeni disposable adı gerekiyorsa source constant ve test pinleri güncellenir, yeni code/plan üretilip yeniden açık onay alınır. Production UUID yasaktır; var olan ada çarpılırsa STOP; kayıp create yanıtından isimle kaynak sahiplenilmez.

## İşlem güvenliği

- Source hash/byte pinleri, decoder'dan exact derived SQL, schema0022/23 official migration source/ledger, bütün kaynak verisi ve operational proof herhangi bir provider mutation'dan önce doğrulanır.
- Her query batch tam statement nesnelerini kullanır; trigger gövdesi `;` ile parçalanmaz. Query/response/statement/row/storage/request/time sınırları korunur. Her write batch'ten önce exact owned UUID/name/EU identity tekrar okunur.
- `query-state/query-phases.sqlite`: target+plan hash binding, FULL synchronous INTENT/CONFIRMED journal ve tek writer lock. Kayıp yanıt yalnız bütün şema/veri checkpoint'i eşleşiyorsa olmuş sayılır. Absent/partial/corrupt effect UNKNOWN kalır; mutation kör tekrarı yoktur. Kaynak ilerletilmez, publication açılmaz.
- Deterministic authority batch önce pinned authority instant ile session'ları revoke eder; yeniden yaratılan grant metadata'sına explicit created_at/updated_at yazar. Böylece wall-clock trigger/default farkları checkpoint'i bozmaz. Eski forensic revocation timestamp'leri ve iş kayıtları korunur.
- `recoverDeadLock=true` yalnız kaydedilmiş PID gerçekten ölmüşse kilit kurtarır; canlı PID kilidi kırılmaz. Salt `action=cleanup`, pending query phase'i readback ile doğrular; kalan restore fazlarını çalıştırmaz. Çözülemeyen belirsiz write varken DELETE gönderilmez.
- `action=cleanup` aynı run/plan/authority/options pinleri ve fresh yetki kapsamıyla kullanılır. DELETE yalnız bir kez; kayıp yanıtın ardından tekrar DELETE değil exact404+tam inventory kontrolü yapılır. Query resume/cleanup toplam request bütçesini de tüketir; limit dolarsa daha geniş yetki varsayılmaz.
- Recovered DB production Worker'a bağlanmaz. SEALED sonucu publication yetkisi değildir.

## Yerel regresyon komutları

```text
npx vitest run tests/recovery.provider.test.ts --maxWorkers=1
npx vitest run tests/recovery.provider-wire.test.ts --maxWorkers=1
npx vitest run tests/recovery.query-phase-executor.test.ts tests/recovery.query-batch.test.ts --maxWorkers=1
npx vitest run tests/recovery.executor.test.ts tests/recovery.executor-local.test.ts tests/recovery.populated-native.test.ts --maxWorkers=1
npx vitest run tests/auth.restore-proof.test.ts tests/recovery.ordered-import.test.ts tests/recovery.import-diagnostics.test.ts tests/recovery.phased-restore.test.ts tests/restore-history.test.ts --maxWorkers=1
npm run typecheck
npm run lint
npm run format:check
npm run build
npm run verify:boundaries
```

Ağır Wrangler/native dosyalarını eşzamanlı build/lint yüküyle çalıştırmayın. Kesilen veya hata veren toplu koşu saklanır; bütün etkilenen dosya ayrı process'te yeniden doğrulanır. Skip'ler PASS sayılmaz. `recovery.source-structure.test.ts` tarihsel özel kaynak inspector'ıdır; bu sentetik görevde opt-in kapalı kalır, gerçek backup'a erişilmez.

## Özel arşiv ve Git kapsamı

`/docs/recovery/evidence/**` için `.gitattributes` içindeki `-text` kuralı zorunludur: Windows `core.autocrlf=true` checkout'u bile historical receipt/manifest byte'larını değiştiremez. Hash kontrolünü line-ending normalizasyonuyla gevşetmeyin. Kalıcı attribute testi ve her iki autocrlf kipindeki gerçek checkout karşılaştırması bu korumayı doğrular.

Tam tarihsel worktree/evidence snapshot'ları, uncommitted binary patch'ler ve exact accepted synthetic bundle repo dışında korunur. Kapanış arşivi `C:/Users/sinan/MayiSigorta_Recovery_Retained/2026-10-22-closeout/` altındadır. CAS manifest'leri orijinal dosya adını/byte sayısını/SHA256'yı, objects dizini deduplikasyonlu exact içeriği tutar. Restore yardımcısı ve doğrulayıcı arşivin operations dizinindedir. Kaynak/kanıtların Desktop'tan kaldırılması Git'teki güvenli receipt'leri veya fixture üretimini etkilemez.

Bu branch yalnız review/commit hazırlığıdır. Commit/push, production deploy/migration, token revoke ve publication ayrı yetki ister. Ana `panel`, içindeki Phase3 adayı ve protected planning belgeleri değiştirilmez. Eski `panel-ux003` ve recovery worktree'leri ayrı OWNER temizlik yetkisiyle arşivlenip Desktop'tan kaldırılmıştır; benzersiz içerik ve hash manifest'leri özel retained arşivin `final-desktop-cleanup/` dizininde korunur.
