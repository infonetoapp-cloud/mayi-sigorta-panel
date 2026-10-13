# M4 public feature activation preflight — NO-GO

Başlangıç `cb3fef546e558697d14955e34ff8f0ed0287ca32`: main/HEAD/origin/main/remote eşit, worktree temiz. Public DOCUMENTS=false korunur; bu görev launch değildir. Local isolated acceptance dışında enabled feature yoktur. Production mutation/deploy0; source/config candidate henüz production'da değildir.

## Gerçek surface ve employee lifecycle

Authoritative source `src/server/documents/route-contract.ts`, actual Hono registry regression ile exact eşit:

- POST `/api/documents`: tek PDF/JPEG/PNG multipart upload; ownerType CUSTOMER/POLICY/QUOTE, ownerId, classification GENERAL/IDENTITY/HEALTH, file. Agency/actor/object key/checksum/version/job server-owned.
- POST `/api/documents/:id/download`: normal yetkili attachment stream.
- POST `/secure/api/documents/:id/download`: recent own-password assurance+single-use grant ile sensitive stream.
- POST `/secure/api/documents/:id/download-grants`: canonical version/payload-bound grant.
- POST `/secure/api/documents/:id/download-confirmation`: current authorized confirmation metadata.

Liste/detail/status/archive/classification-correction route yok; upload/version/retention lifecycle'ın varlığı archive/delete UI demek değildir. React customer/policy/quote belge bölümü yok. Ana CUSTOMER/POLICY/QUOTE ownership mevcut ama employee product navigation/status/retry yüzeyi eksiktir. Bu gerçek HARD GO-LIVE BLOCKER, büyük gelecek CRM redesign'iyle karıştırılmamalı veya NONBLOCKING diye saklanmamalı. Yeni read authority surface'i, bu kusurların dar kapanışında acele generic query/helper ile eklenmedi; parent-scoped list/status DTO+UI tam güvenli vertical slice ayrıca tamamlanmalıdır.

İstenen ürün akışı: parent detayında izinli belge listesi → tek dosya/sınıflandırma upload → PROCESSING → canonical private backup exact byte/evidence + AVAILABLE → indirmeye hazır → yetkili attachment download. 202 hazır demek değildir. Kimlik/sağlık: NORMAL operational permission + explicit sensitive grant + current own-password reauth + payload-bound tek kullanımlık confirmation. İşlem başarısız/gecikmişse personel-friendly failed/wait/retry/contact admin; teknik Queue/R2/RPC/job/key/hash/SCAN isimleri DOM/URL/storage'da gösterilmez. Mevcut source bu ürün yüzeyinin tamamını henüz sağlayamaz.

## Kanıtlanmış güvenlik bulguları ve local fix

BLOCKER: completed upload replay final authority `.run()` çağrısı sessionBoundDatabase.batch guard'ını atladı; son persisted-row read sırasında session revoke edilince202 replay disclosure döndü. Native realD1/R2/regression RED bunu doğruladı. Final assertion aynı canonical authority SQL'i session-bound batch içinde yürütür; session/credential/current membership permission version canlılığı aynı atomic boundary'ye katılır.

Sibling confirmation/download: son joined snapshot current resource graph'ı pinler ama session/recent-password lifetime yoktu. Confirmation artık requireRecentPassword; final unchanged check+authorityAssertion session-bound atomic batch. Native real-session revocation regressions confirmation/download dönen metadata/bytes'i engeller. OWNER implicit NORMAL/explicit SENSITIVE model değişmez; production credentials/auth/session mutation yok. Session guard standalone direct source caller'a uydurma session vermez: gerçek request composition sessionBoundDatabase sağlar; injected fixture auth eski testlerde ayrı supporting scope.

İlk fresh finalHIGH SOURCE_FIX=FAIL/1BLOCKER2IMPORTANT ayrıca persisted-target classification/archive await yarışı, yalnızreceiptclassification corruption ve eskiHTTPDTO testini buldu. OriginalFAIL korunur. Üç kalıcınativeRED regression buvektörleri yenidenüretti. Completedreplay finalbatch şimdi immutablecontent/typedparent/creator/agency/document/version/classification/currentACTIVE bağını aynı session-bound atomic sınırda pinler; response.classification===canonicalinputclass şartı vardır. Canonical BACKUP_PENDING→AVAILABLE ilerleme exactretry'ı bozmadan doğru202replayed sonucu verir; independentnative olumlukontroldejob/document/version/SUCCESSaudit totals aynı. MevcutloadCompletedUpload auditjoin yapmaz; yeniimmutableaudittargetcheck var denmez. Kapanışkanıtı canonicalfingerprint/preparedbytes+immutablestoredcontent+typedparentcreator+atomiccurrenttarget kapsamındadır.

IMPORTANT abuse: plan upload10/min/download30/min admission yoktu. Yeni production namespaces2703/2704 source config, peragency/user limiter auth+CSRF sonrası route body/JSON parser/storage öncesi uygulanır; global security JSON transport pre-read bundan öncedir, ANY BODY READ0 iddiası yok; missing/error/malformed binding503, limited429 Retry-After60. Local test fallback production proof değildir; live bindings henüz deploy edilmedi. Platform-local approximate rate limit global distributed concurrency/capacity garantisi değildir. Yetkili session ve CSRF sahibinin parent yetkisi body metadata sonrası tam service'de tekrar denetlenir; rate limit bu maliyeti sınırlar, tam scoped authorization yerine geçmez.

Body resource correction: arbitrary chunk başına JS allocation yerine sabit64KiB blocks; byte cap20,971,520+65,536; max65536 read work; idle5s/total30s; requestabort/timeouts/cancel; generic sanitized413/503. Synchronous PDF/JPEG/PNG parser async timer ile preempt edilmiş sayılmaz. Raw HTTP upload+multipart+crypto/parser FreeCPU/peakmemory/headroom/concurrency provider kabulü OPEN; P4 prevalidated COPY buna taşınamaz.

Upload error texts database/quarantine/multipart/idempotency key developer jargonundan product messages'a daraltıldı. Public upload data allowlist `{documentId,classification,status:PROCESSING}`; internal durable receipt same `{documentId,versionId,classification,versionNumber,state:BACKUP_PENDING}` kalır. Sensitive checksum/version/grant token yalnız opaque protocol field; UI olmadığı için employee DOM kabulü verilmez. Raw provider exception/SQL/key/source stack response'a aktarılmaz.

Interrupted upload visibility: eski PENDING_UPLOAD reservation nojob durumunda health6metrics0 idi. Yeni operational-only bounded SQL ayrı `overdueUploads`>15m agregatı ve warning/silent predicate ekler. Native RED missing metric→corrected PASS; mevcut BACKUP_PENDING sayacı ayrı kalır. Automatic finalize/authority üretimi/SQL cleanup/orphan deletion yok. Production henüz eski health6metrics source'u çalıştırır; seventh metric source-ready, deployment proof değildir.

## Validation / tenant / isolated flow

Exact file cap20,971,520 Blob/preflight/materialized/parser/storage sınırlarında; multipart envelope allowance dosya cap bypass'ı değildir. PDF bounded objects/tokens/xref/nesting/geometri/active content; strict baseline JPEG/pixel/header/decoder; PNG CRC/order/pre-inflation/expectedoutput bütçeleri unchanged. SVG/HTML/Office/ZIP/executable/malformed/truncated/unsupported coding default-deny; malware-free/CLEAN iddiası yok. Syntax/content envelope admission tests supporting; provider HTTP resource gate ayrı.

Yeni native isolated test: default exported Worker gerçek opaque cookie+session-bound CSRF (verifier/resolver injection yok) → synthetic PDF upload202PROCESSING → actual canonical backup processor+nativeR2 readback/D1finalization → duplicate backup ACKED/idempotent → defaultWorker attachment download exactbytes → otherAgency OWNER same documentID404. Canonical backup adapter doğrudanlocal, yeni private provider jsrpc resource proof değildir. Completed replay/confirmation/download final revoke races native D1 ile corrected deny. Yeni fixture başlangıçMiniflare V4 option error ve duplicatepermission ONCONFLICT trigger error beforebug tarihçesi saklandı, bugPASS sayılmaz.

Tam MEMBER/suspended/reassigned/sensitive-grant UI+list/status enabled E2E hâlâ OPEN. Existing focusedauthorization/stream/upload parent/sensitive tests supporting; frontend-specific doc tests yok. P4 COPY1/10/exact20MiB önceki measured kabul korunur yalnız unchanged copy/private-leaf/back-up/reconcile/resource-admission identity/workload altında; yeni replay/HTTP/health değişikliği P4 entire prepare/runtime timing receipt'inin yeni kaynak için ölçüldüğü anlamına gelmez. Full production COPY/private primary/createAndVerify/AVAILABLE boundary ayrıca NOT_PROVEN.

## Queue/Cron/custody ve production negatives

v2 batch1/concurrency1/maxRetries5/DLQ source/runtime accepted değişmez; oldQueuepaused consumerless decision untouched. Production front custody full supportedJSON beforeACK-capable handler; unknown/orphanJSONarchive, unsupported/bounds/conflict/error retry+payload-free diagnostic. No forever/unsupported payload/IAM-no-delete/expiry guarantee. Public poison-custody volume/privacy/retention/retention-before-incident handling operations gate OPEN. D1 authoritative due redispatch/idempotency preserved. Cron document-only*/5 and backupCron unchanged; no dequeue/purge/restore or product-facing job diagnostics.

Actual source inventory5×POST/GET/PUT/DELETE production20probes all404/noSetCookie; no auth fixture, no business writes. SameWorker399a2/e647 stillDOCUMENTSfalse/JOBStrue/CRONtrue. Protected finalprovider/source exactcomparison kapanışta recorded; source fixes notdeployed.

## Launch rollback

Eventual feature incident first: DOCUMENTS_ENABLED=false exact binding/deployment readback + all route negative probes; keep JOBS/CRON active when issue onlyemployee frontend/API disclosure and background preservesauthoritativeevidence. If queue/private capability/custody incident: pausev2 first, JOBSfalse, disable/remove ownconsumer; CRONfalse/remove documentCron when dispatcher unsafe. Explicit consumer API needed: Wranglerconsumers[] isnotremoval proof. Keep publicfalse throughout, observe active lease/job terminal state (pause doesnotinstantcancel), preserve D1 immutable audit/run/receipt and R2 recovery/custody evidence. No normal rollback SQL/R2 deletes. Actual rollback earlieracceptedinternalcheckpoint reused; thismissiondidnotrehearse/deploynewsource.

## Remaining issue classification

HARD GO-LIVE BLOCKER:
1. Minimal employee document product vertical slice: authorized parent-scoped list/status DTO+route, real React upload/status/normal+sensitive download/reauth/confirmation/retry behavior, enabled userflow acceptance including membership/scope/failure/race cases. NotmajorCRMredesign.
2. Production-like Free HTTP upload/multipart/parser/crypto resource+abuse/concurrency acceptance at supported limits; rate knobs+byte caps+P4COPY are not this proof.
3. Live independent backup freshness/deadman + human notification delivery, and requireddocument job/custody incident visibility before24h expiry. Local observer/component/log-only health isnotlive notification.
4. POPULATED_REMOTE_RECOVERY_STATUS=OPEN: separate disaster-recovery acceptance, notnewdocumentIDOR; soleplan10.3/§15/§16 requiresreal restore/RPO/RTO beforedocumentgo-live. Thus hard operational blocker undercurrentnormativecontract, not automaticallywaived asgenericdebt. No populated restore executed here.
5. Accepted source mustbe deployedCLOSED withdocumentrate bindings andnewHealth readbacks before finalflip; thenfinalsecurity/runtime/userflow/go-livegates verified. Currentproductionoldsource remainspublicclosed.

HUMAN ACTION REQUIRED:
- Freeexternalmonitorproject access + verifiedexistinghuman channel/humanreceipttest; secrets notchat. Actualprovider setup/notification plan+review follow.
- Employee endpoint protection/safe PDF/image opening/operatingresponsibility anddocumentretention/custody policy approvals requiredbycurrentplan; technical36dayBucketLock notlegalretention approval.
- Separate authorizedpopulated recovery acceptance/window andexplicitfinalproductactivation authority AFTERremainingengineering/ops gates; thismissionnogranttoflip.

ACCEPTED FOLLOW-UP:
- OldQueueretirement withseparatecustodydecision; currentpausedFreeexpiryhonestnotforever. No needunprovableemptyproof fornewv2line.
- Documentarchive/physicaldelete/versioncorrection UI notV1implementedcontract; no genericdelete/PATCHroute created. Futurefeature ownauthorization/retention scope.
- Broader modernCRMfrontend redesign later; document-only essentials notdeferredtoit.

NON-BLOCKING DEBT:
- Existingtechnical internalstate labels historicalSCAN_FAILED/QUARANTINE neveremployee labels; mapper/protocol separation partdocumentUIlaunchwork.
- Globalrow fingerprints/external-actor absence notprovenbyfixedaggregates; owncontrolledmutationplan/readbackscopehonest.

## Tests/review/history

Initialfocused4files46PASS6.51s. Native corrective4testsPASS31.21s; integrated7files39PASS62.27s (opaqueupload/download/wrongtenant,threefinalsessionrace,admission,streambounds,health,gates,config,routeinventory). Typecheck/rootlintPASS. Broad4docdomain chain(upload/stream/backup/reconcile)timeout300s beforecompletedsummary => NOT_PROVEN, notPASS; no inventedtotals. Prior specialistread-onlyfocusedresults separate supporting, notaggregatedasfullsuite. NativeCPU/memory/providerload tests notrun.

FreshfarklıfinalSolHIGH `20261013_210602_ed8cb1` actualgpt-6.1-sol/openai-codex/high/parentNULL/cli_close verified:SOURCE_FIX_CHECKPOINT=PASS/0BLOCKER0IMPORTANT; OVERALLPUBLIC_GO=NO, M4_SECURITY_ACCEPTED=NO, M4_DOCUMENT_USER_FLOW_ACCEPTED=NO. Independent7files42PASS40.86s; own2Tempfiles18PASS75.64s; selectedexistingupload/stream2files13PASS82SKIP60.81s; typecheck/rootlint/boundaries/formatPASS. İlkHIGH1B2I/v3adversarial11PASS3FAIL ve oldexpected429/actual413 aynen korunur. 413 rootglobalJSON65,536-byte guard'ının sonsuzbody'yi reddidir; yeni bounded'{}' fixture16route×admissioncases limited429+60s/diğer503, routeJSONreader0 doğruladı. Bu ANY_HTTP_BODY_READ0 değildir: global transportpre-read32 gerçekleşti; resource/runtime globalguard kapısıOPEN. Kullanıcı/providererrorecho yok. Reviewer397filehashdrift0/GitStatusEqualtrue; önceki initialstatusdelta parentF33+newprefightdocs idi, source17hashdrift0revieweredit0. Sonrasıdocs-onlyclosure ayrı.

Son protectedproviderreadback before/closeout workers/Queue/buckets/domains/routes/alert/subscriptions eşit; doğal995508/export18:00:08.106Z/COMPLETE18:00:16.778Z227547metadatahealthy. ProductionDOCUMENTSfalse/JOBStrue/CRONtrue unchanged399a2/e647100%; Paidfalse. Source fixes+ratebindings+overdueUploads NOTDEPLOYED, no productionwrite. [Kalıcısafe kabulreceipt](M4_PUBLIC_PREFLIGHT_RECEIPTS.json). EverypriorFAIL/STOP/NO-GO retained. Productionwrite0/customer/businessdataNO (syntheticlocalonly)/PaidOff/DNSauthbackupretentionchanges0. Public activationSTOP.
