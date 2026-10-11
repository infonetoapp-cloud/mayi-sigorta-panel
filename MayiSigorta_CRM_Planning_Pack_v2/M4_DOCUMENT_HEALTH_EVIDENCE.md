# M4 durable document health — LOCAL implementation evidence

Başlangıç clean main/HEAD/origin/main/remote main: `84ed910dc65fb8000fbd7557567bf0e4aaeddb8a`. Kullanıcı Cloudflare support'u erteledi; recovery OPEN kalacak, production'a dokunmadan sıradaki önemli geliştirme yetkisini verdi. Tek writer/integrator + iki bağımsız salt-okunur uzman kullanıldı. Güncel plan bölüm9/15 (`NIHAI_MIMARI_VE_UYGULAMA_PLANI.md:423,565–569`) esas alındı.

## Seçim ve scope

Default exported-native-session core business acceptance önceki checkpoint'te kabul edildi. Sonraki öncelik M4 kalıcı DEAD/backlog/investigation görünürlüğü: D1'de iş kalması sessiz belge backup/reconcile arızasını gidermez; yalnız DEAD count, COMPLETED+PERMANENT_ERROR investigation'ı kaçırır. M4 backup/reconcile storage-capability composition ayrı boşluktur; ham D1 recovery bucket binding'i veya var olmayan service RPC bu dilimde icat edilmedi.

Yeni `src/server/documents/health.ts` tek parametrik SELECT ile kalıcı D1 metadata'sından yalnız aggregate metrics üretir. `src/server/index.ts` gerçek default scheduled composition'ına bağlar: exact `*/5 * * * *` + `DOCUMENTS_ENABLED==='true'`; Queue binding koşulundan bağımsız. Mevcut dispatch/reclaim ve renewal cron semantiği değişmedi; evaluator reclaim/dispatch/copy/repair/mutation çağırmaz. Production configuration/cron/consumer/feature flag/bindings/secret ve migrations değişmedi. Bu source hazır olması production enablement değildir.

## Metrik sözleşmesi

- `dead`: yalnız DOCUMENT_BACKUP/DOCUMENT_RECONCILE DEAD.
- `due`: aynı iki tür QUEUED/RETRY_WAIT, available_at<=tek captured read clock.
- `stalledDue`: aynı due işi 15 dakikayı aşmış; yeni operational noise-control eşiği, Queue doğruluk kaynağı değildir. Normal kısa bekleme tek başına alarm üretmez.
- `expiredLeases`: aynı tür RUNNING ve lease_expires_at<=clock; aktif lease alarm sayılmaz.
- `completedInvestigations`: DOCUMENT_RECONCILE COMPLETED + last_error_code non-NULL + aynı agency/job/current attempt run PERMANENT_ERROR. Başarılı run veya backup'ta korunmuş QUEUE_DELIVERY_EXHAUSTED marker'ı bu kategoriye karışmaz. Kalıcı investigation kanıtı sayımıdır; acknowledgement/resolution schema yok, **hâlen çözümsüz olay sayısı** veya otomatik kapatma iddiası yok.
- `overdueBackups`: document_versions BACKUP_PENDING ve updated_at < clock−15 dakika. Tam15dakika alarm değil; ilk reservation created_at veya retry available_at backup bekleme başlangıcı olarak kullanılmaz. Geçerli source transition updated_at'ı günceller; yeni backup generation timestamp'ıyla pending yaşı karıştırılmaz.

Her kategori iç SELECT LIMIT1001; dış count en fazla1001. Payload count'ları1000cap; aşım `truncated=true`, 1000değerleri alt sınır gibi okunmalı, exact total/healthy iddiası yok. Tek snapshot SQL / sabit allowed fields / bounded result boyutu. Bu mevcut indekslerle hard DB rows-read/CPU bütçesi garantisi değildir. Await5s deadline ve finally timer cleanup; D1 cancel capability yok, timeout altta çalışan query'yi durdurmuş sayılmaz. Timeout/malformed/null/query failure healthy duruma çevrilmez; retry yok. Büyük dataset ve Free runtime/cost proof deployment/enablement kapısında ayrıca gerekir.

## Güvenli olay ve hata yolu

Ops-only `console.warn` JSON: version, global `ALL_AGENCIES_OPERATIONS_ONLY` scope, fixed code/severity, checkedAt, fixed counts/truncated, beş dakikalık slot eventKey. HTTP route/tenant DTO/Queue payload/R2 dosyası/DB audit writer eklenmedi. Global infrastructure-operations metric'i, personel/acente API yetkisi değildir.

DEAD/stall/expired lease/investigation/overdue backup veya truncated snapshot varsa `DOCUMENT_DURABLE_BACKLOG`; sağlıklı snapshot ve yalnız kısa due iş sessiz. Query/timeout/invalid result -> sanitized `DOCUMENT_HEALTH_READ_FAILED` event + rejected waitUntil; log sink failure -> `DOCUMENT_HEALTH_SINK_FAILED`. Provider/sink error message/cause/SQL/raw metadata korunmaz ve loglanmaz. Job/agency/document id, object key, filename, checksum, lease hash, email/credential/session/body çıktısı yok.

Aynı signal class ve5minslot eventKey deterministik; aynı slotta yeniden invocation yine log üretebilir. **Durable dedupe veya delivered email yok.** Başarılı her job için spam yok; problem sürdükçe per-slot aggregate warning normaldir. Downstream recipient/dedupe/alarm acknowledgement operasyon kapısıdır. Plan567 uyarı email test teslimi CLOSED sayılmadı; monitoring COMPLETE değildir.

## Permanent acceptance

`tests/documents.health.test.ts`: current21migration native Miniflare D1, genuine trigger-safe synthetic job/run/document fixtures; default exported Worker scheduled called/awaited. Yalnız unused cloudflare:workers DO-base Node stub; workerd isolate/KDF proof değil. DEAD/due/future/15m±1ms/stall/lease/COMPLETED investigation vs successful run/legacySCAN exclusion; pending backup status/age; no Queue composition; documents false/missing/nonexact flag/wrong cron zero reads; SELECT-only wrapper ve all job/run/version/SYSTEM-audit before/after equality; safe D1/sink failures; count cap/malformed/null/unsafe clock; healthy silence; deterministic keys; timeout/timer cleanup kapsanır.

Eski `documents.queue-dispatch.test.ts` deliberately narrow historical schema fixture'a yeni read-only health'in boş document_versions/background_job_runs yüzeyleri eklendi. Runtime missing-table fallback veya accepted migration edit yok. Mevcut factory Queue/legacy consumer history korunur; gerçek default handler proof yeni current-schema fixture'dadır.

TDD history korunur: ilk fixture DEAD direct INSERT ve future run timestamp guard FAIL'leri, source guardları okunarak gerçek QUEUED→RUNNING/run-complete→DEAD seed ile düzeltildi; trigger kapatılmadı. Feature missing valid RED→GREEN; due/age/counter/composition/failure/timeout/success-marker classification RED→GREEN. Focused28/28PASS (health15+dispatcher13), typecheck/changed-filelint/fullformat/boundaries/diff PASS; clientbuild + production dry-run PASS, dry-run DOCUMENTS_ENABLED=false. Production deployment yapılmadı.

Coherent relevant acceptance **107/107PASS**,5files/354.86s/exit0: newhealth15, historicaldispatcher13, backup/reconcile regression files ve exported-native-session business file birlikte çalıştırıldı. Typecheck/changed-filelint/fullformat/boundaries/diff/clientbuild/productiondryrunPASS. Unrelated full-repo tests/lint tekrar çalıştırılmadı; eski baseline problemleri bu receipt ile silinmiş sayılmaz. ONE fresh independent GPT-6.1Sol/openai-codex/HIGH session `20261011_120800_569778`: **BLOCKER0/IMPORTANT0/OPTIONAL0/PASS** LOCAL-only. Reviewer independent28tests/12RAMprobes/2late-resolve-rejectprobes/typechecktargetlintformatboundariesdiffPASS; parent107receipt validated, slow backup/reconcile suites not rerun. Reviewer initial VM-realm probe harnessFAIL retained; same-realm correction12PASS, source edit0. Candidate6file hashes unchanged after review independently checked. Normal source/tests/docs commit-push accepted; deployment NOT performed. SOURCE_DEPLOY_READY_LOCAL=YES is not production authorization or document/Queue/Cron enablement. Existing recovery acceptance/status değişmedi: `POPULATED_REMOTE_RECOVERY_STATUS=OPEN`, support deferred. No cloud calls/resources/import/production writes/deployment/R2/DNS/secret/Paid/feature/Queue/Cron enablement. M4 COMPLETE=false; DOCUMENTS_ENABLED=false; M5 başlamadı.

## Local operations runbook

1. WARNING eventinde sayımlar/snapshot zamanı/cap işaretini okuyun; count1000+truncated kesin toplam değildir.
2. Yetkili operasyon ortamında durable job/run/current version state'i inceleyin. DEAD'i sıradan retry ile silmeyin; current attempt+input/generation+immutable audit kanıtını koruyun. COMPLETED investigation'ı başarı saymayın; eski discrepancy'yi sırf zaman geçti diye temizlemeyin.
3. BACKUP_PENDING>15m için pending updated_at, job dispatch/lease/retry ve backup verification state'ini birlikte denetleyin. Belgede AVAILABLE pointer'ını manuel açmayın; storage proof/authoritative D1 gate gerekir.
4. READ_FAILED sensör arızasıdır, zero-backlog/healthy değildir. Sadece authorized read-only schema/query/binding diagnosis; raw provider payload'ını loga taşımayın. SINK_FAILED alarm teslimi başarı değildir.
5. Bu source hiçbir requeue/reset/repair/delete yapmaz. Böyle düzeltmeler veya recipient/production cron/Queue/document enablement ayrı explicit yetki ister. Mevcut production belgeler/Cron disabled kalır.
6. Support deferred recovery OPEN engineering'i durdurmaz. Sıradaki LOCAL dilim M4 backup/reconcile private capability composition için mevcut architecture ile uyumlu create/readback-only adapter sınırının uygulanması ve exported queue acceptance; production activation ayrı kalır.
