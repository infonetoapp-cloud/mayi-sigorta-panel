# M4 — provider-native attribution ve staged Free runtime kanıtı

Tarih: 13 Ekim 2026. Başlangıç: `8f0a29c55960711e97b9395512c1d146b63cb635`, main/HEAD/origin/main/remote main eşit, worktree temiz.

## Kabul sınırı

Yeni tek isolated P4 attempt'in 1/10/20 MiB functional, integrity, attribution ve provider outcome sonuçları PASS. Farklı fresh independent post-HIGH 0 BLOCKER/0 IMPORTANT/PASS ile bu dar checkpoint kabul edildi: P4_ATTRIBUTION_PROTOCOL_ACCEPTED=YES, M4_PROVIDER_RESOURCE_CANARY=PASS, M4_FREE_RUNTIME_RESOURCE_ACCEPTED=YES. CLOSED_INFRASTRUCTURE_ACCEPTED=YES; FEATURE_ENABLED=NO; M4_COMPLETE=false; POPULATED_REMOTE_RECOVERY_STATUS=OPEN. Önceki iki failed attempt ayrı historical FAIL olarak kalır.

Kapsam yalnız single-job-at-a-time, önceden doğrulanmış sentetik COPY workload'u; exact üst boyut 20,971,520 byte. Queue → Worker → private RPC → conditional R2 copy/readback → D1 finalization → reconcile/health. Public upload format parser/auth HTTP, concurrency, throughput, toplam free allowance, production IAM veya genel memory headroom kabulü değildir. Temporary wrapper tüm production bundle ile byte-identical değildir; canonical copy/CAS/job uygulaması reuse edilir. Workers Paid ve Tail kullanılmadı; CPU override yok.

`PEAK_MEMORY_NOT_OBSERVABLE`. RPC CPU enforcement inheritance UNKNOWN; Queue ve RPC CPU süreleri bağımsız bütçeler gibi toplanmaz. Gözlenen all-ok provider outcome'ları bu exact workload'un gerçek Free hesabında başarıyla yürüdüğünü gösterir; gelecekteki ölçeği garanti etmez.

## Gerçek attribution problemi

Önceki mekanizma emitted marker'ın exact JSON şekli ile provider stored envelope'u karıştırıyordu. `console.info` source'a `level` ekledi; null job alanı indexing sırasında kayboldu. İlk okumalar bazı lifecycle/CPU kayıtlarını eksik döndürdü. Önceki iki failed receipt FAIL/NOT_PROVEN olarak immutable kalır; bu çalışma onları retroaktif kabul etmez.

En güçlü destekli primitive provider'ın `view=invocations` grup anahtarı → olaylar ilişkisidir. Marker ile CPU kaydı aynı provider invocation grubunda bulunmalıdır. Event payload'ında optional requestId/traceId gerekmiyor; timestamp-only join yok. Receipt/event hash'leri integrity anchor'dır, cryptographic provider signature değildir.

Resmî kaynaklar:

- [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
- [Query Builder / invocation ve event görünümleri](https://developers.cloudflare.com/workers/observability/query-builder/)
- [Telemetry query API](https://developers.cloudflare.com/api/resources/workers/subresources/observability/subresources/telemetry/methods/query/)
- [Resmî SDK tipi](https://github.com/cloudflare/cloudflare-typescript/blob/main/src/resources/workers/observability/telemetry.ts)
- [RPC lifecycle](https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/)

Public API/kurulu SDK'da `invocationIds` parametresi bulunmadı; böyle bir özellik uydurulmadı. `events.count` toplam olay eşleşmesidir; invocation sayısı değildir. Genel ingestion SLA/snapshot completeness garantisi bulunmadı. Önceki eksik backup grubunun kesin nedenselliği hâlâ NOT_ESTABLISHED.

## Seçilen protokol

- Emitted owned altı alan strict kalır: kind/run UUID/stage/size/job/outcome. Stored envelope'da observed typed `level` enrichment ayrı kabul edilir; owned identity mutation veya eksik alan tolere edilmez.
- Null job yerine exact `no-job` sentinel emit edilir. Actual job olarak bu reserved değer reddedilir. Eksik job alanı null'a tahmin edilmez; legacy explicit null regression desteği yokluk için fallback değildir.
- Her stage ayrı opaque random UUID; expected script/current deployed version/job/stage/outcome/type pinlenir. Tam lifecycle ve aynı grupta tek numeric CPU/wall invocation, açık truncated=false, unique event IDs ve all-current-run marked-group closure zorunludur.
- Dry service-only invocation query marker/CPU AND filtresi olmadan yapılır. Marker'lar gruplarda yerel bulunur; unmarked inventory komşuları kanıt değildir.
- Ayrı complete service-only Events görünümündeki current-run marker inventory, gruplardaki inventory ile exact event ID/owned fields/script/version/type/truncated/timestamp üzerinden eşit olmalıdır. Bu completeness kontrolüdür; CPU başka görünümden/gruptan eklenmez.
- Query limit2000/count equality/cap ve küçük group bound guard'ları vardır. Cap/ambiguous pagination STOP; küçük bu workload'da cap'e ulaşılmadı. Bilinmeyen enrichment otomatik temizlenmez.
- Eksik ingestion için mevcut invocation'lar bounded read-only polling ile okunur; handler/publish/copy retry yapılmaz. Full executor en fazla 12 read / 10 saniye aralık kullanır. Provider failure STOP; eksik/ambiguous evidence NOT_PROVEN. Stabil okumalar tek başına kabul değildir: expected lifecycle/CPU ve inventory closure gerekir.

## Zero-business / zero-document provider probe

İki private Worker `mayisigorta-m4-canary-native-20261013-probe` ve `...-probe-leaf`, bir Queue `...-probe-jobs`. D1/R2/document/business kayıtları yok. Exact aynı canary emitter kullanıldı; 64 zero byte memory-only stream private jsrpc ile tüketildi, scalar cevap döndü. `d1_finalization` burada yalnız marker'dır, D1 write veya document copy kanıtı değildir.

Tek publish → prepare/backup/reconcile üç Queue ve iki jsrpc invocation. Sampling1/invocation_logs=true; dev/preview/routes/Cron kapalı. Poll0–3 incomplete NOT_PROVEN, poll4 tam lifecycle + beş numeric CPU/wall receipt PASS. Exact-marker ve service-only final görünüm sonuçları uyuştu: Queue grup boyutları 4/5/5, leaf3/3. Bu gözlenen ingestion gecikmesidir, evrensel süre garantisi değildir.

Probe prepare CPU/wall4/253ms; backup Queue1/90, leaf3/4; reconcile Queue1/3, leaf0/1. Tüm provider outcomes ok. Tüm probe resources silindi; direct404 + inventory absence. Probe native association ve normalization sözleşmesini kanıtladı; gerçek belge functionality yerine geçmedi.

## Review, test ve korunan başarısızlıklar

Fresh independent pre-HIGH session `20261013_090603_3d34c6`, gpt-6.1-sol/openai-codex/high/parentNULL metaverisi doğrulandı. İlk 0 BLOCKER/1 IMPORTANT FAIL: Events'te görünen fakat grouped görünümde eksik marker atlanabiliyordu. Actual AST+CLI counterexample RED → exact inventory reconciliation; aynı reviewer final0/0/0 PASS, protocol accepted YES. Independent59 parser/emitter ve51 query closure kontrolü; supplied native matrix tekrarlanmadı.

Source regression'ları level enrichment ve explicit sentinel için RED→GREEN. Focused actual logging-enabled native + parser: 2 files/3 tests PASS,69.13s; native1/10/20 local copy path mevcut. Typecheck/target lint/full format/boundaries/dry builds PASS. Frozen execution source371/371 ve40 static preparation artifact hash bağlandı; source/operator custody korundu.

Provisioning, append-only API journal'ın yanlışlıkla static artifact hash listesine girmesiyle kaynaklar oluştuktan sonra durdu. Yalnız journal hash'i değişmişti; initial gate bytes saklandı. Aynı reviewer74 local/14 GET/15 live invariant ile source değişmeden0/0 PASS verdi. Journal static manifest'ten çıkarıldı,40 static hash korundu. Kaynaklar yeniden oluşturulmadı; ilk eksik install fazından devam edildi.

1 MiB PASS sonrası10 MiB hazırlığı canonical schema guard'da durdu: yalnız üç canary tabloya ait dört SQLite autoindex prefix exclusion dışında kalmıştı. Canonical application schema değişmemişti;10 MiB kickoff/reset başlamamıştı. Exact table/index/name/owner/type/sql-null whitelist ile guard düzeltildi; arbitrary ekstra index/trigger dışlanmaz.10 MiB leaf tekrar deploy edilmedi, tamamlanmış consumer DELETE tekrarlanmadı.

Yeni resume gate için ilk review0 BLOCKER/1 IMPORTANT FAIL: strict boolean/hash/version/stage custody parity eksikti. Dar düzeltmeyle receipt+attribution raw hash, strict True, script/version map ve1→10 stage tuple any-save öncesine bağlandı. Aynı reviewer final0/0 PASS/68 RAM checks; current operator `acb54d59d616a59f0a55225ec1f422f191cc61c8199ce6771b4651905f0fb8ae`. Initial FAIL'ler ve reviewer fixture47/51,67/68 düzeltme tarihçeleri saklandı; source/parser/telemetry değiştirilmedi.41 parent resume RAM kontrolü geçti.20 MiB normal prior-PASS transition kullanıldı.

Bunlar preparation/custody guard STOP'larıdır, failed document size veya ikinci full attempt değildir. Her boyutta tek kickoff, functional replay0. Negatif provider fault injection bu mission acceptance standardında zorunlu değildi ve çalıştırılmadı; adversarial attribution regression'ları yerel incelendi.

## Tek yeni staged P4 — gerçek sonuçlar

Tek EU disposable D1/Queue, iki private EU unlocked R2, iki private Worker:

- `mayisigorta-m4-canary-native-20261013-db` — `7530340d-5baa-48a9-9bc5-de056e285bca`
- `mayisigorta-m4-canary-native-20261013-jobs` — `5ca458e6d5f84caba65de8e3a40dec60`
- `mayisigorta-m4-canary-native-20261013-primary`, `...-recovery`
- `mayisigorta-m4-canary-native-20261013-crm`, `...-leaf`

Closed flags, private exposure, isolated bindings, head sampling1, batch/concurrency1/retries0; canonical21 source migrations ve41 application +3 auth empty-table count kontrolü. Arada aynı disposable D1 schema source'dan reset edildi, önceki immutable receipt'ler ve R2 objects retained kaldı. Production D1 dump/import yok. Script versions/live bundle bytes/config her stage'de read-back ile doğrulandı.

| Boyut | Byte | Functional/integrity/attribution | Prepare Queue CPU/wall ms | Backup Queue CPU/wall ms | Copy jsrpc CPU/wall ms | Reconcile Queue CPU/wall ms | Observe jsrpc CPU/wall ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 MiB | 1048576 | PASS/PASS/PASS | 21/4401 | 59/4547 | 57/1427 | 40/2433 | 32/286 |
| 10 MiB | 10485760 | PASS/PASS/PASS | 39/4574 | 336/5674 | 411/2281 | 258/3115 | 229/623 |
| 20 MiB | 20971520 | PASS/PASS/PASS | 77/7355 | 766/7975 | 852/4148 | 711/4271 | 523/973 |

Her boyutta exact-marker baseline0; tek kickoff, iki COMPLETED job/attempt=max1/errornull, iki SUCCEEDED run, SAFE_NOOP reconcile, AVAILABLE/current exact, bir verified copy/audit, health counts0/truncatedfalse, Queue retry0. Independent destination readback exact size/hash; primary/recovery SDK complete object sets ve yalnız beklenen yeni immutable key eşitliği PASS. Her stage üç read-only telemetry read içinde complete association PASS oldu. Tüm15 expected provider invocation outcomes ok; CPU timeout/exceededResources/memory/resource failure/RPC truncation/unexpected retry/dead gözlenmedi. Hiç peak memory rakamı üretilmedi.

Kalıcı güvenli machine evidence: [M4_PROVIDER_NATIVE_RECEIPTS.json](M4_PROVIDER_NATIVE_RECEIPTS.json). Marker grupları, original-event integrity hash'leri, exact contracts/versions, functional projections ve raw original receipt hash'leri saklanır. Original Windows CRLF byte hash'i kullanılır; line-numbered/LF-normalized read-file text hash'iyle karıştırılan ilk export hash doğrulama FAIL'i ileri yönlü düzeltildi. Original receipts değişmedi.

## Cleanup ve production isolation

Full consumer → Workers → Queue/D1 → exact altı unlocked synthetic R2 object → iki boş bucket silindi; delete intent/result kayıtları mevcut. İlk final inventory read guard `INCOMPLETE_INVENTORY_STOP` verdi; initial exact shape kaydedilmediği için kesin provider nedeni iddia edilmez. DELETE tekrarlanmadı. Fresh read-only completion altı exact404 ve complete inventory absence doğruladı;13 successful cleanup DELETE journals, leftovers0. Probe ayrı temizlenmişti. Post-HIGH bağımsız cleanup doğrulaması kapanış şartıdır.

Permanent before/after config/bindings/deployments/domains/routes/subscriptions/backup alert/bucket lock/lifecycle eşit. CRM version `b05105e3-94c4-4b0e-a8e5-9ba3739d64b5`, deployment `ad0e8610-4ebb-438e-af2a-7a5e21ea9e33`/100%. DOCUMENTS/JOBS/CRON false; production Queue consumer[]/pausedtrue; document Cron[]; public beş canonical document POST404. Private leaf/recovery36daylock, auth/D1/KDF, DNS, backupWorker/Cron/alert ve Workers Paid unchanged/off. Own production-row/auth/session/document/DNS/paid/backup/restore writes0. Fixed application+auth aggregate counts unchanged; bu tüm satır fingerprint'i veya external actor audit kanıtı değildir.

Post natural backup995486/export2026-10-13T07:00:31.163Z/COMPLETE07:00:38.208Z/224121byte metadata contract/COMPLETE-last/healthy PASS. Daha yeni generation doğal ilerleyebilir; SQL body/restore okunmadı veya çalıştırılmadı.

## Nihai post-HIGH / sonraki gate

Fresh farklı bağımsız post-HIGH `20261013_102353_4cac2a`: gpt-6.1-sol/openai-codex/high/parentNULL/ended-cli_close gerçek metaverisi parent tarafından da doğrulandı. Final BLOCKER=0/IMPORTANT=0/OPTIONAL=0/PASS. 617/617 local evidence/custody/functional kontrolü,49/49 adversarial parser/emitter,15/15 query closure ve88/88 live invariant PASS; bunlar product suite veya invocation sayısı değildir. Fresh unit1/1 PASS273ms; supplied native2files3PASS69.13s ve unchanged static/build evidence reuse edildi, expensive rerun0.

Reviewer56 official GET ile dokuz exact temporary resource404/complete inventory absence ve permanent before/after eşitliğini doğruladı. Ayrıca cleanup sonrası saklı Worker loglarına12 dry telemetry POST yaptı: üç stage'in complete Events marker inventory'si gruplarla eşit, actual CLI her stagePASS ve CPU/wall/event ID/script/version receipt'leri durable evidence ile birebir eşit. Böylece kabul yalnız parent'ın offline projection'ına dayanmaz. İki fixed aggregate SELECT POST before counts ile eşit; provider mutation/reviewer source edit0. Metaveri row fingerprint/DNS record fingerprint/restore garantisi diye sunulmaz. Post backup995486 sağlıklı; public HTTP kanıtı mevcut parent after-probes'tan reuse edildi. Report: `C:/Users/sinan/AppData/Local/Temp/mayi-native-post-high-result.txt`. Kapsam yalnız üç ölçülmüş single-job COPY boyutu ve exact20MiB üst sınırdır; ara boyutların hepsi ayrı ölçülmüş değildir.

Production feature commissioning, Queue consumer/unpause, Cron, flags, gerçek belgeler ve separate populated recovery issue başlatılmadı. Başarılı P4, M4_COMPLETE veya feature enablement değildir; sonraki feature commissioning için ayrı açık yetki ve kabul kapısı gerekir.

Local operational evidence: `C:/Users/sinan/AppData/Local/Temp/mayi-native-20261013/`; parent operators/probe/pre-HIGH reports aynı Temp altında `mayi-native-*`. Historical first failed receipt SHA124eb290... ve second failed receipt SHA289a69f2... pass=false unchanged.
