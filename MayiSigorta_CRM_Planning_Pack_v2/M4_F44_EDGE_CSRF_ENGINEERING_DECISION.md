# F-44 — bounded EDGE/CSRF mühendislik kararı

Başlangıç main/HEAD/origin/main/remote441b484e875f7a9273d41fdaff3160780a1a44b2 eşit ve temiz. Protected production11GET: version7e97419b-241a-4cf1-92de-d4ee62d70002/deployment182b1c6d-0542-4568-8e20-6453a73d297b/traffic100, DOCUMENTSfalse/JOBStrue/CRONtrue/üçQueue-Cron-Free/KDF-only/old-owned absence aynı. F41 core/F42 negatif/F43 PNG functional kabulleri korunur; eski başarılı upload veya tüketilmiş historical telemetry sorgusu tekrar edilmedi.

## Kaynak ve platform açıklaması

Missing positive EDGE native root cause UNKNOWN. worker.ts exact POST upload'u dispatch'e aktarır; dispatch origin/config/source-IP SHA/source-rate/private fixed DO.fetch bekler. DO canonical app.fetch içinde parser/auth/CSRF/authorization/hash/final atomic D1/R2 işi yanıt öncesinde await edilir. Küçük JSON response'u aktarmak desteklenen bir akıştır; kanıtlanmış sahiplik/lifecycle kusuru bulunmadı. F43 wrapper EDGE start'ı await öncesi, complete'i return öncesi senkron çağırıyordu. Bütün EDGE context'inin yokluğunu response-sonrası cancellation, ingestion, request context veya CPU exhaustion olarak açıklayacak kanıt yok. waitUntil/clone/body-drain/context hack'i eklenmedi. Source inspection platformun hatasız olduğunu da kanıtlamaz; açıklama UNKNOWN kalır.

Resmî Workers limits: HTTP Free nominal10ms; seyrek aşım için isolate esnekliği var, sustained aşım termination/exceededCpu/1102 ile ayrıdır. D1/fetch bekleme CPU değildir. Workers Logs invocation CPU/wall kaynağıdır; sampling1 delivery garantisi gibi yorumlanmadı. Traces root span native CPU/wall/outcome dokümante eder, native truncation bütünü garanti edilmez. Traces/Logs collection ve read API şekilleri aynı değildir; bir trace özeti invocation CPU kanıtı değildir.

CSRF tam dış HTTP yolu: index.ts worker.fetch parseServerConfig ve canonical path/origin/host kontrollerinden geçer, security boundary ardından auth route tek fresh loadLocalSession(...,true) yapar; canonical D1 joins/revocation/status/version/expiry/idle predicates, session SHA, gerekirse idle last_seen UPDATE, parseCsrfConfig, nonce16/HMAC import/sign/encoding çalışır. index auth middleware bu namespace'i atladığı için duplicate full session verification yok; CSRF GET'te KDF yok. Boundary'nin kendisi parseServerConfig çağırmaz, fakat outer worker çağırır. Önceki options/preflight brief'lerindeki “CSRF'de parseServerConfig yok” ifadesi yalnız route/boundary için doğrudur; tam external path için düzeltilmiştir. İlk raporlar silinmedi.

## Tek hedefli kaynak değişikliği ve yerel kanıt

src/server/index.ts: statik tamamlanmış default app.router.match('GET','/api/health') module initialization'da çağrılır. İlk request'teki SmartRouter seçimi/route kurulumu startup'a taşınır; gerçek110-route graph SmartRouter+TrieRouter seçer. RegExpRouter kesinliği iddia edilmez. Handler/I/O çalışmaz; createApp/configureRoutes composition açık, env/principal/session/membership/credential cache yok. Guard, SQL, rate limiter, auth/CSRF/idempotency ve document validation değişmedi. Production deploy yok.

Frozen pre-change yerel createApp().fetch + mock-D1 profilinde3 fresh Node process×16 request/variant: lazy ilk wall13.585–14.118ms, router3.909–4.240ms; startup-precompiled ilk wall8.607–10.617ms, router0.081–0.106ms; sonraki median wall yaklaşık0.65–0.85ms. Bunlar LOCAL WALL, provider native CPU değildir. Windows process CPU coarse/quantized v1 korunur; sıfır örnekler sıfır gerçek CPU sayılmaz. Profil yalnız app seam'indedir. Sonraki full exported worker.fetch probe parseServerConfig'i kapsar fakat source global router zaten precompiled olduğundan kontrolü temiz original-vs-candidate baseline değildir; ayrı sınırlı artifact olarak tutuldu.13ms'nin kök nedeni veya native kazanç yüzdesi çıkarılmadı.

TDD: yeni static-router test RED(expected SmartRouter) →GREEN. İlk focused4file15PASS/1FAIL: yeni fixture route'u API catch-all sonrasına eklenip404 aldı; yalnız fixture non-API pathe taşındı. Yeni dosya corrected3/3PASS; önceki native auth.local/uploadDO/recovery üç dosyası yeşil kaldı. Başka üç gerçek static-app consumer file143/143PASS. Bu iki koşu temiz tek16/16 aggregate diye birleştirilmedi. Lint/typecheck/build(client+worker dry-run+boundaries)PASS; ilk format uyarısı yeni test formatting ile kapandı. Değişmeyen expensive full migration/auth suites tekrar edilmedi.

## Tek yeni provider deneyi

Yeni owned EU run57a8930d-b3b1-4344-8014-6e87221d90f9 / mayi-http-cd3ad01ea7; yeni D1/privateR2/privateSQLiteDO,21 canonical migration/350schema/FK0/new syntheticsession ve exact proposed/deployed bundle. App source candidate yalnız startup-match farkı; canary-only wrapper gerçek external dispatch'i64-byte streaming transport path'e bağlar, private DO bu sentetik path'te gerçek byte bound/content kontrolü yapar. Bu yol document parser/auth/security/capacity testi değildir; diğer canonical auth yolları unchanged. DOCUMENTStrue yalnız disposableconfig, JOBS/CRONfalse/noQueue/noCron/no production binding. Tracing enabled/head_sampling1 ve log invocations enabled/head_sampling1 actual readback ile doğrulandı. Paid/OTel üçüncü taraf/Tail/Logpush servisi yok.

Fresh independent options HIGH20261016_102055_fbd7f3 mevcut capacityBLOCKER1/CSRFIMPORTANT1/yerel ölçümOPTIONAL1 kaydetti; bu rapor deney yetkisi değil, risklerin korunmasıdır. Yeni exact source/executor preflight HIGH20261016_104449_537e12 PASS0BLOCKER/0IMPORTANT/1OPTIONAL,51RAM assertion/415pin0drift. OPTIONAL yalnız gerçek router adının TrieRouter olduğunun düzeltilmesidir. Closed actual HIGH/model/provider/reasoning/final JSON/hash kapısı mutation öncesi zorunluydu. İlk ve following client sırası cold/warm/same-isolate garantisi değildir. En fazla3 canonical CSRF GET +1 transport POST önceden sabitlendi; retry0/document upload0.

| Yeni explicit client sırası | HTTP | EDGE CPU/wall ms | DO CPU/wall ms |
| --- | ---: | --- | --- |
| csrf-first |200|18 /110|NOT_APPLICABLE|
| csrf-warm-a |200|11 /48|NOT_APPLICABLE|
| csrf-warm-b |200|19 /63|NOT_APPLICABLE|
| transport64byte |200|4 /457|1 /6|

Bütün ölçülen native kayıtlar exact owned Worker/version881676d3-72a5-4c30-b342-30d8cf1f8bdc/method/origin-path-stage/defaultEDGE/namedDO, ayrı native IDs, finite nonnegative CPU/wall, outcome=ok, truncated=false. Native log teslimi bu dört invocation'da gerçekleşti. Lightweight transport, F43 canonical PNG EDGE kaydını geriye dönük tamamlamaz; reliable arbitrary positive upload veya sustained Free kapasite kabulü üretmez. Provider Worker Startup Time47ms; budget1s altında, startup bedeli sıfır değildir.

Traces-enabled candidate CSRF CPU18/11/19 nominal10ms altında headroom göstermedi. Üç örnek tek eski13ms'den güçlü risk girdisidir fakat production sustained exceededCpu veya candidate'ın kötüleştiğinin nedensel kanıtı değildir: untouched provider A/B baseline yok, tracing overhead/colo/isolate/JIT ve session idle UPDATE etkileri ayrıştırılmadı. Last_seen seed'den değişmişti; idle bookkeeping çalıştı. Yanıtların200/ok olması nominal bütçeyi güvenli saydırmaz, overrun değerleri de1102 kanıtı değildir. Startup optimization için native headroom mitigation PASS verilmedi.

Native observer stage başına max6 finite poll/8s gaps/4cursorpage1000, count/dedupe/identity/type/outcome/truncation; optional console progress şartı yok. Mandatory native Logs bu dört çağrıda tamam. Exploratory events-view projection root trace CPU candidate çıkaramadı. Ardından yalnız aynı yeni run penceresinde bir bounded traces-view dry query4 trace özeti (span sayıları5/2/2/3) buldu. Bu, tracing etkinliğinin/persistence'in mevcut olduğunu; event projection'ın root native receipt sağlamadığını gösterir. Platform tracing arızası, ingestion root cause veya native truncation güvencesi çıkarılmaz. Trace summary CPU/truncation yerine geçirilmedi. Bu kolektörün exact root retrieval/identity/truncation sözleşmesi KANITLANMADI; kanal sessizce kabul edilmedi.

Her aşama business tables documents/version/receipt/job/audit0; final owned actual readback private R2 objects0. CSRF token/header/cookie/raw document/SQL parameter loglanmadı; safe native/trace summary projection kullanıldı. İkinci provider deneyi, canonical upload, historical query/replay,20MiB/overlap/burst/sustained yürütülmedi.

## Alternatifler ve açık karar

1. Mevcut F36 + Logs: en düşük source/security riski; canonical güvenlik ve recovery kabulünü korur. F43 exact positive EDGE kanıtı açık, bu deney yalnız lightweight/full-CSRF native gösterir. Aynı sorgu/canary döngüsü tekrar seçilmedi.
2. waitUntil/response clone/body drain/instrumentation rewrite: kanıtlı lifecycle hatası yok; native receipt teslimi sağlamaz. Güvenlik/akış riski karşılığında kanıtlı yararı olmadığı için RED.
3. Statik startup seçimi: düşük karmaşıklık, ek servis yok, yerel first-match işi kaldırıldı ve startup47ms ölçüldü. Yalnız startup-work relocation olarak tutulur; CSRF Free headroom çözümü değildir. HMAC/session/config cache veya guard atlama eklenmedi.
4. Mevcut privateDO içinde dar canonical CSRF CPU delegation: bir sonraki local-only tasarım/fizibilite adayı. D1 authoritative, fresh revoke/version/expiry/membership/session-bound CSRF aynı kalmalı; public exact path/method/origin/source-rate, private allowlist, ayrı bounded auth admission, upload contention/availability ve failure semantics test edilmelidir. Yeni auth/session store gerekmez. Free DO30s CPU yönü belgeli, gerçek auth delegation CPU/memory/request-duration allowance ve yoğunluk FEASIBILITY henüz ölçülmedi. Bu görevde uygulanmış/izinli provider mimari değişikliği değildir.
5. Ayrı thin Worker veya ayrı auth servisi: eager graph/entrypoint identity izolasyonu sağlayabilir; native teslim garantisi yok, ek binding/deploy/rollback ve maliyet scope'u getirir. Şu an mevcut DO'ya dar cost-placement adayından daha yüksek karmaşıklık; seçilmedi.
6. Paid Tail/Logpush veya requirement/budget değişimi: teknik seçenek olabilir, Free yetkisini aşar; hiçbir ücretli kaynak/upgrade uygulanmadı. Sampled GraphQL quantile'ları exact invocation CPU/outcome/truncation yerine kullanılmadı.

Mühendislik kararı: F36'yı ve kabul edilmiş domain/security/recovery'yi koru; kanıtsız lifecycle düzeltmesi yapma. Bu source/capture yöntemini bir kez ölçtük; aynı pozitif upload veya generic native probe'larla yeni NO-GO zinciri açma. Full Free capacity authorization YOK. Sonraki somut çalışma telemetry mükemmelliği için yeni app invocation değil: canonical CSRF maliyetinin mevcut privateDO'ya dar yerleşimi için local-only security/contention/failure tasarımı ve documented root-span retrieval sözleşmesini eldeki trace'lerle değerlendiren tek karar kapısı. Bu aday onaylanmadan mimari değiştirilmez; yeni HIGH exact executor gate olmadan provider/capacity devam etmez. Bunlar kaynak maliyetinin ve ölçüm sözleşmesinin ayrı riskleridir. Salt startup optimizasyonu veya transport4/1ms, bu gate'leri kapatmaz.

## Cleanup ve kapanış

Owned cleanupONCE PASS: private class deletion→namespace absence/permanentKDFexact, Worker404, emptyEUbucket404, ownedEUDB404. Final08:03:08Z11GET production version/deployment/traffic/bindings/üçQueue/Cron/Free aynı; DOCUMENTSfalse, FEATURENO, M4_COMPLETEfalse. Production business/deploy/Paid/DNS/auth infrastructure/frontend/Excel/backup değişikliği yok. Farklı fresh final Sol HIGH20261016_143500_97afa1 kaynak/startup farkını, bounded kararı, lightweight native capture ve cleanup'ı PASS kabul etti; actual kapalı gpt6.1sol/openai-codex/high/parentNULL/cli_close/son JSON eşitliği parent tarafından doğrulandı. Severity sayıları0'a indirilmedi:1BLOCKER mevcut canonical capacity/release kapısı,1IMPORTANT çözülemeyen CSRF headroom riski,1OPTIONAL gelecekteki root trace contract'ıdır; dar source/cleanup ret bulgusu değildir.623 bağımsız router match karşılaştırması ve0 handler execution, factory/configureRoutes açık/outer guards eşdeğer;508pin/98artifact drift0.11 bağımsız GET ile actual owned Worker/EU DB/EU bucket404/KDF-only/protected production/üçQueue-Cron-Free aynı;2 dry telemetry query+boş cursor sayfası5 unique native ID/gerçek18,11,19 ve4/1 CPU ölçümlerini yeniden doğruladı. App/provider mutation/historical query/cleanup repeat0; silinmiş D1/object yeniden okunmuş gibi sunulmadı. Kaynak kabulü capacityExecutor yetkisi değildir. Report/readback/RAM custody hash'leri receipts dosyasındadır. Önceki FAIL/STOP, coarse profile ve fixture/format FAIL kayıtları korunur.

Final HIGH kararına göre production için en düşük risk mevcut HTTP/F36 davranışını korumaktır; privateDO delegation yalnız yeni servis gerektirmeyen local-only adaydır, kanıtlanmış production çözümü değildir. Tek sonraki contract-first local gate; DOCUMENTS=false auth availability, aynı-isolate head-of-line, ayrı permit'in synchronous parser'ı preempt etmemesi, abort/deadline/lateD1 custody, exact method/path/origin/fixed target, ayrı source-rate, fresh authority ve aynı fail-closed semantiği HTTP'de tutma alternatifiyle karşılaştırmalıdır. Bu şartlar kanıtlanamazsa aday RED, HTTP korunur. Yeni generic probe/telemetry loop veya kaynak maliyetini ölçmeden başka cache/refactor seçilmez.

MISSING_F43_EDGE_ROOT_CAUSE=UNKNOWN
F44_LIGHTWEIGHT_NATIVE_TRANSPORT_CAPTURE=PASS
F44_CSRF_FREE_HEADROOM_ACCEPTED=NO
F44_TRACE_ROOT_NATIVE_ACCEPTED=NO
CAPACITY_EXECUTOR_AUTHORIZED=NO
M4_HTTP_ADMISSION_ARCHITECTURE_ACCEPTED=NO
M4_HTTP_SUSTAINED_FREE_CAPACITY_ACCEPTED=NO
DOCUMENTS_ENABLED=false
FEATURE_ENABLED=NO
M4_COMPLETE=false
