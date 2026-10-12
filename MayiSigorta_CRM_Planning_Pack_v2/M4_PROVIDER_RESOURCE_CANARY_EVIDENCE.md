# P4 isolated synthetic provider resource canary — 12 Ekim 2026

Starting clean main/HEAD/origin-main/remote `b231de4a835a217987d49d182b00e3f278bd1189`. One writer/operator; two parallel READ-ONLY specialists. Hermes/profile/skills/tooling değişikliği yok. Scope COPY-only/prevalidated synthetic fixture; parser/public ingestion/employee/real document kabulü değil.

## Sonuç — escalation STOP

M4_PROVIDER_RESOURCE_CANARY=FAIL (acceptance evidence incomplete, proven runtime failure değil).
M4_FREE_RUNTIME_RESOURCE_ACCEPTED=NO.
1 MiB functional/integrity execution succeeded, resource acceptance NOT_PROVEN. 10 MiB=NOT_PROVEN/not executed;20 MiB=NOT_PROVEN/not executed. Original `receipt-1048576.json` pass=false preserved; retry/replay/second canary yok. Negative provider probe NOT_EXECUTED, yalnız bütün normal sizes PASS sonrası yetkiliydi. TEMP_RESOURCE_CLEANUP=PASS; leftover0.

CLOSED_INFRASTRUCTURE_ACCEPTED=YES; FEATURE_ENABLED=NO; M4_COMPLETE=false; POPULATED_REMOTE_RECOVERY_STATUS=OPEN. Production Queue consumer/Cron/publicdocuments yok; paused=true; allthreeflagsfalse. No WorkersPaid activation.

## Minimum isolated topology / created then deleted

- ONE EU D1 `mayisigorta-m4-canary-20261012-p4-db`, UUID `85a71dfd-3a77-4e05-b687-ee9d20c3a046`.
- ONE Queue `mayisigorta-m4-canary-20261012-p4-jobs`, ID `5c9880d9bc0f47de9184fdb5c3ed81cc`; consumer only temporaryCRM/batch1/concurrency1/retries0; Free24hretention.
- TWO EU/private R2 `mayisigorta-m4-canary-20261012-p4-primary` / `mayisigorta-m4-canary-20261012-p4-recovery`; no r2.dev/customdomains/CORS/longlock. Canonical separateprimary/recovery authority requires two buckets.
- TWO private Workers `mayisigorta-m4-canary-crm` / `mayisigorta-m4-canary-leaf`; routes/dev/previews/Cron off, sourceflagsfalse, no CPU override. TemporaryCRM version `704cab97-029a-46eb-a193-ece0039d6301`, deployment `ae442c9a-5202-42a9-bd00-9e41ecbd0528`; leaf version `b6828016-f4d6-4013-846c-65e00ccd21ff`, deployment `64da8d44-d9fd-4ab2-ac72-bbf67d1f2a5f`; both100% before cleanup.

PRODUCTION_LEAF_USED=NO. Tested leaf is unchanged accepted implementation source inherited through unchanged P0 measured wrapper plus canary-only inventory subclass. Label BYTE_IDENTICAL_TEMP_LEAF applies only to the reused accepted copy implementation, NOT entire measured/inventory Worker bundle equality with production. Both live temporary JS bundles independently GET/readback byte-equal frozen reviewed builds. Production leaf/bucket not rebound/redeployed/exercised; permanent locked recovery receives no synthetic object.

Actual isolation settings, privacy, version, bindings, Queue association and bundle hashes read back after creates/deploys. Canonical21 source-controlled migrations applied only disposableD1; previously accepted CASE-parenthesis transport validator/source hashes/canonical schema equality used, no production backup/rows/import. Empty44applicationtables/authcounts verified before kickoff. P0 requires fresh empty graph per size; planned sameUUIDschema recycling after each accepted stage was locally proved twice, but provider reset never reached due first-stage STOP.

## Canonical path / narrow provider adaptation

P0 `document-worker.ts` generates deterministic repeated73byte fixture, authoritative synthetic version/job + primary object + reference-only Queue message → actual exported CRM queue via opaque env/message-bound permit → unchanged private copy RPC → immutable destination/readback/hash → D1 CAS completion → controlled reconcile SAFE_NOOP → persisted aggregate health. Existing seed/permit/normal jobs code unchanged.

Account-level R2 object-list GET returned resultLIST and result_info=null, even on knownempty bucket. Missingpagination never treated complete. New `provider-inventory.ts` requires actualSDKlist({limit:4}) truncated===false, max3unique canonicalUUIDkey/size/etag/date and safeprojection. New private `provider-leaf.ts` adds parameterless metadata inventory only on canarybinding. New `provider-worker.ts` accepts strict nonce/run-bound private Queue inventory control, reserves nonce/persists canary-only observation/ACKafterpersist, delegates normalP0 messages unchanged. No generic storage/write/admin/public endpoint. BEFORE/AFTER inventory overhead separately observed, not included as copy operations or exact productioncost. Two bounded storage inventory invocations add coordination deliveries, not extra documents/jobs.

## Frozen tests and pre-canary HIGH

Fresh parent baseline5files56/56PASS114.79s; nativeRPC8PASS/33SKIP35.73s; SKIP not relabeledPASS. SDKhelperRED undefinedfunctionFAIL, initialnativeasyncRPCmatcherFAIL preserved; correctedSDKwrapper2/2PASS66.84s includes actualnativeQueue/RPC/SDKlist/P0copy1/10/20 and20MiB+1beforeseedreject, overflowfailclosed/noextrajobs. Two localnativefullP0 reset cycles onephysicalD1+R2/21migration/schemamatch/FK0. Typecheck/targetlint/fullformat/boundaries/productiondryruns/canarydryruns PASS. Bash stdin-not-TTY tooling invocation failure preserved; native node.exe quality commands passed, environment/tooling not changed.

ONE fresh pre-reviewer `20261012_203656_844cb0`, gpt-6.1-sol/openai-codex/high/parentNULL actualmetadata verified. Initial0BLOCKER/4IMPORTANT/1OPTIONAL FAIL: telemetryidentity, exactobjectset, interruptedcleanup, settingsreadback. Same reviewer firstfollowup0/1/0FAIL pagination; SDKfollowup0/0/0PASS. After partialprovision metadata-saveguard failure (deploymentauthor_email deliberately NOToutput), GET-only reconciliation preserved successfulleaf/no retry; same reviewer narrow recoveryfollowup0/0/0PASS. Pre-high receipts immutable/hash-bound operator+29artifacts+367source tree (original363 unchanged+fournewsource/tests). Reviewer independent21SDK/38wrapper/26operator checks plus recovery7projection/10resume/6gate checks PASS; priorfailures retained. Source bytes unchanged throughout execution.

Queue provider readback used `script` not `script_name`. Exactconsumername/settings independently reconciled GET-only; deploy/migration not repeated. Cleanup applies narrow in-memory compatibility alias only after exact actualscript/type equality. This is representation correction, not an alternate resource/provider mutation retry.

## Actual 1 MiB observations

ExactlyONE 1048576-byte kickoff; no normalcanaryretry. Synthetic source and destination exactSHA256 `c0978704744126c3999901381b5bbd1bb2a0ab5b20be30ed82816118643de894`; independentcanaryGET fullsize/hash PASS, no body output. ExplicitSDK inventory BEFOREbothempty/AFTERoneprimary+onedestination/metadata delta PASS.

- Backup COMPLETED/SUCCEEDED, attempt1/maxattempt1/errornull/ACK1/retry0; applicationwall2775ms.
- Reconcile COMPLETED/SUCCEEDED/SAFE_NOOP, attempt1/maxattempt1/errornull/ACK1/retry0; applicationwall1862ms; health136ms/sixcounts0/truncatedfalse.
- Version AVAILABLE/currentversionexact; completionaudit1/copy1; repair/discrepancyaudit0; DEAD0; nofalseCOMPLETE.
- Metered copy+reconcile:11D1APIcalls/27statements,4R2get/1conditionalput,read4xsize/write1xsize; RPC16chunks/1048576bytes. Seed/control/inventory/operatorreadback excluded; not providercharging orpeakmemory.
- Distinct observed normalQueue records outcomeok CPU11/35/29ms; providerwall3398/3618/2027ms. NormalprivateRPC records outcomeok CPU36/19ms; wall976/344ms. SDK BEFOREinventory overhead QueueCPU4ms/wall885ms andRPC1ms/wall175ms.

No observed CPUtimeout/memoryexception/RPCtruncation/Queueinstability/R2hashmismatch/D1finalizationmismatch. PEAK_MEMORY_NOT_OBSERVABLE; no heap/headroom guarantee. Queue defaultCPU30s documentedforFree; HTTP/CronFree10ms separately; RPC enforcement inheritance UNKNOWN. CPU values not added as independentbudgets, noPaid dependency observed.

## Why 1 MiB resource acceptance is NOT_PROVEN

Originalstricttelemetryattest=false: actualeventType jsrpc ratherthan assumedrpc; invocation requestId/traceId absent; BEFOREinventory's endingrecord overlaps timestamps withnormalwindow (4Queue/3leaf records returned, notassumed3/2). DistinctmetadataIDs and exactdeployedversions/outcome/CPUwall are present; functionalRPC/D1/R2 receipts coherent, but claimed perstage invocation attribution/correlation is not independently accepted. No inventedtrace/CPU0/pseudo-limit, no retrospectivefalsePASS. Firstfailure/unknown stops10/20; no canary replay or telemetry-driven redeploy. Further supported telemetry correlation is next separatelyauthorized gap, not copied evidence as capacityproof.

## Cleanup / production / backup / alert

Consumer removed and GETempty → temporaryCRM/leaf deleted with exactGET404 → Queue/D1deleted/directGET404 → exactcanaryprimary/recoveryobjects deleted (unlockedonly) → buckets empty/delete/directGET404 → inventories absence. Once-only DELETE intents/results preserved, no blindretry/replacements. Final permanent inventories services3/D1one/Queueone/EU R2three; alternate leftovers0. Safe full receipts captured before teardown.

Permanent BEFORE/AFTER config equality PASS: activeCRM b05105e3/ad0e8610 unchanged, allflagsfalse, oldbindings/authD1/KDF/rates/CSRFname same; queueproduceronly/consumer0/pausedtrue, schedules[], onlypaneldomain/publicdocument5x404, privateproductionleaf/config/recovery36daylock unchanged, D1backupWorker/Cron/alert/WorkersPaid unchanged. Two fixedSELECT-only before/post application+authcount snapshots equal; production-target write0 according exactmutationledger. Counts+write-targetevidence are not every-row-contentfingerprint or proof against externalconcurrentedits. No realcustomer/employee/document/password/sessionvalues used or read. No permanentobjectbody/download/backupartifactwrite/restore.

Post natural `d1-backup-slot-995462`, export2026-10-12T19:00:25.484Z, COMPLETE2026-10-12T19:00:36.117Z,224121bytes; source/generation/state/key/sizeETag/COMPLETE-last/healthy PASS. DifferentSQLartifactsize vs earlier223011 is observed, notclaimedrawSQLdriftdiagnosis; bodynotdownloaded/restored.

Read-only alert history since priorhealthy995455: START15:52:52.888079Z andEND16:37:51.975495Z, samepolicy, renewedcycle observed; ALERT_TUNING_OPEN=YES. No alerttuning. Firstlocalstate-stringclassifierwrongfalse projection retained; corrected actualALERT_STATE_EVENT_START/END strings evidence separatelysaved. Notificationhistory != everyevaluatorrun orhumanreceipt.

## Post-canary acceptance

Fresh independent `20261012_221956_0b9f8b`, actual gpt-6.1-sol/openai-codex/high/parentNULL/ended-cli_close metadata parent tarafından verified: BLOCKER0/IMPORTANT0/OPTIONAL0/PASS yalnız dürüst failed/not-proven checkpoint/source/cleanup/isolation kapanışı. Pre-reviewer'dan farklı session. Resource verdict FAIL/NOT_PROVEN ve Free acceptance NO korunur. Bağımsız56officialGET+5publicdocumentGET+2fixedSELECT-onlyPOST; actual temporarydirectGET404/inventoryleftover0 ve permanentconfig/counts/closedgates equality PASS.72/72wrapper-helperRAM,577/577offlineevidence/hash/definition checks ve213/213persistedlivechecks PASS;577producttest veya remoteexecution sayılmaz. Supplied56PASS/8PASS33SKIP/2nativeSDK/fullP0reset kanıtları hash-reused, expensive tekrar0. Reviewer mutation/source edit0; secret/outputscanPASS. Safe final result `C:/Users/sinan/AppData/Local/Temp/mayi-p4-post-high-result.txt`; original receiptSHA256 `124eb2907c13890b8c99303a8b0162d758931d9d669cf280fb413b7612e6b9d1`. No further providercanarymutation authorized in this checkpoint after escalationSTOP.

Safe evidence directory: `C:/Users/sinan/AppData/Local/Temp/mayi-p4-20261012/`; original test/review failure and finalreceipt files retained. Next separate gate: supported invocation attribution/telemetry-source correction and fresh isolated P4 attempt approval; not productionQueueconsumer/unpause/Cron/feature/realdata/restore. M4 remains incomplete.
