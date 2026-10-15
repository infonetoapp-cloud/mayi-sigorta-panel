# M4 HTTP admission — interrupt recovery

15 Ekim 2026. INTERRUPT_RECOVERY=PASS; kaynak/yerel private DO adayı korunmuştur. Orijinal sustained-capacity mission tamamlanmadı: representative PDF'nin aynı EDGE invocation native CPU kaydı bounded salt-okunur uzlaştırmada gözlenemedi. Deney kontrollü durduruldu ve bütün owned kaynak türleri temizlendi. Bu kayıt sustained capacity veya production deployment kabulü değildir. Mimari otorite nihai plandır; güncel aday §10.10/F-36'dadır. Aşağıdaki ara checkpoint'ler tarihsel sırayla korunur; güncel sonuç son bölümdedir.

## Kesintiden kurtarılan durum

HEAD, main, origin/main ve remote main: 7da52fa6d597875dd8db82f8e5fdc6aa183aaf8d. Staged dosya yoktu. İki değiştirilmiş doküman ve on bir untracked dosya, toplam 13 worktree girdisi korundu. Kesinti başlangıç envanteri, tüm dosyaların SHA256/byte sayıları ve retained artifact bağları repo dışı C:/Users/sinan/AppData/Local/Temp/mayi-interrupt-admission-custody.json dosyasındadır. İlk recovery script'inin porcelain satırının başındaki boşluğu strip etme assertion hatası korunmuştur; yalnız yerel parser düzeltildi, provider işlemi tekrarlanmadı.

Önceki canonical 20 MiB HTTP CPU615ms; native-stream lower-bound tiny/1MiB/exact20MiB CPU3/3/4ms kanıtları retained. İki eski burst isteği HTTP202 olsa da tam attribution/gerçek overlap yoktur: concurrency NOT_PROVEN. Başarılı upload/provider create/deploy/delete veya eski canary tekrar edilmedi. Önceki transport-only HIGH session20261014_225214_28fb33 gerçek model/provider/HIGH/parentNULL/closed finalJSON ve üç frozen kaynak hash'i üzerinden yeniden doğrulandı; aynı review yeniden çalıştırılmadı. Kapsam FREE_NATIVE_TRANSPORT_SPIKE_ONLY, yeni canonical source kabulü değildir.

Kesinti anındaki son somut adım model-export RED testiydi. Yereldeki0021 draft durum dokümanından ilerideydi: attempt yanında admission/validation tabloları ve provenance/state guards içeriyordu. Native10GREEN log'u retained; eski log exact kaynak hash'ini bağlamadığı için yeni kabul sayılmadı. Drizzle export/journal/snapshot ve API/consumer entegrasyonu tamamlanmış değildi.

## Fresh provider reconciliation

2026-10-15T07:27:26Z salt-okunur snapshot ve ek Queue/metadata okumaları:

- Production CRM version7e97419b-241a-4cf1-92de-d4ee62d70002, deployment182b1c6d-0542-4568-8e20-6453a73d297b, traffic100%.
- DOCUMENTS_ENABLED=false; DOCUMENT_JOBS_ENABLED=true; DOCUMENT_CRON_ENABLED=true. FEATURE_ENABLED=NO ürün kabul durumudur; provider'da ayrıca aynı adlı binding olduğu iddia edilmez.
- Worker settings/deployment, eski Queue, buckets, domains/routes, backup alert ve subscriptions retained pre-mission baseline ile eşit.
- Üç Queue ayrıca exact detail readback ile retained CLOSED baseline'a eşit; yalnız modified_on semantik kıyas dışında. Eski Queue paused/consumerless/producerless; v2 unpaused/tek CRM consumer/batch1/concurrency1/wait1000ms/retries5/sameDLQ; v2DLQ paused/consumerless.
- Document Cron */5 * * * * değişmedi. Private leaf ve ayrı backup Worker değişmedi.
- mayi-stream-e58a0b4ce3 geçici Worker ve EU bucket ayrı GET404; tekrar DELETE yapılmadı.
- Envanter üç permanent Worker, bir D1, dört EU bucket, üç Queue. Yeni canary/verification Queue veya orphan Worker görülmedi.
- Production sqlite_master SELECT yeni üç admission tablosu için boş: draft production'a uygulanmamış.
- Workers plan free; mevcut r2_paid subscription unchanged. R2 Paid metadata'sı Workers Paid açıldığı anlamına gelmez. Yeni billing/resource/config mutation0.

Fresh readback receipt: C:/Users/sinan/AppData/Local/Temp/m4-admission-interrupt-20261015T072726Z-reconciliation.json. Tam metadata snapshot: C:/Users/sinan/AppData/Local/Temp/mayi-closed-infra-20261012/m4-admission-interrupt-20261015T072726Z.json. Credential, customer row ve SQL backup body yazdırılmadı.

## Devam edilen engineering işi

Salt-okunur uzman karşılaştırması F-35'in domain/state değişiklik yüzeyini private SQLite DO alternatifinden büyük buldu; bu final HIGH kabulü değildir. Kullanıcının mimari seçimi yetkisi altında F-36 dar adayı uygulandı:

- Production entrypoint yalnız enabled exact POST /api/documents yolunu body okumadan fixed private SQLite DO'ya aktarır. Binding/dependency failure503; eski pahalı HTTP parser'a fallback yok.
- DO aynı canonical app ile session-bound D1, CSRF, actor/tenant/typed-parent/sensitive authorization, parser, server SHA, audit/final batch ve completed replay kurallarını reuse eder. Yeni D1 ledger, client contract veya AV verdict yok.
- Isolate-wide tek nonwaiting permit; raw geç D1/R2 işi bitmeden replenishment yok. Bütün handler için60s logical timeout ve gözlenen Request abort future provider işlemlerini kapatır. Provider giriş kuyruğunun sıfırlandığı, synchronous parser'ın timer ile kesildiği veya cross-RPC client abort garantisi olduğu iddia edilmez.
- Dış dispatch source limiter ayrı hashed-IP key-space; authenticated upload limiter değişmedi. Missing production source IP/protection fail-closed.
- Production config adayı yalnız SQLiteDO binding ve additive document-upload-v1 class migration ekler; root/foundation değişmedi, DOCUMENTSfalse korunur. Provider'a uygulanmadı.

F-35'in yayımlanmamış0021 SQL ve iki test dosyası engineering-drafts/m4-async-admission altında .draft uzantısıyla exact-byte korundu. SHA256:

- SQL: b4045b5006882c68c5750756187ce26bfbedd80287970cbd353b4f903f79d5fe
- Native test: e3b9ef9f20f6db4fec766c3eb4d0cc1ac4781824fbcf3baf765546da0da57f33
- Model RED test: 08cdb4491d3e74389209719b55d89b25f1c45cfe373c768d88fd8cb829e9600b

Bunlar aktif migrations/tests dışında explicit superseded deneylerdir; eski RED GREEN'e çevrilmiş sayılmaz. Raw-stream/envelope prototipleri ve testleri tutuldu, production import graph'a eklenmedi.

## Yeni yerel doğrulamalar ve açık kapılar

Yeni runtime/dispatch/config ve mevcut production config focused gate11test PASS; workerd gerçek SQLiteDO→canonical parser/serverSHA/realD1/receipt/exact replay ile CSRF403/session-revoke401 iki test PASS. Node multipart/Miniflare FormData incompatibility ve local loopback Host rewrite harness failure'ları loglarda retained. Yalnız test shim'i loopback Host'u kaldırır; production Host kontrolü değişmez. Native test production edge Host veya provider CPU proof değildir.

Typecheck, touched lint, boundaries, git diff --check ve production Worker dry-run PASS. Eski pahalı accepted suite'ler tekrar edilmedi; full repository suite PASS iddiası yok. Yeni source için bağımsız HIGH pre-provider review henüz sonuçlandırılmadı.

Yeni DO adayının provider CPU/wall/outcome/overlap/sustained workload kanıtı henüz yoktur. Önceki615ms veya4ms bu adaya aktarılmaz. Main Queue→private leaf CPU-limit inheritance ve full pipeline kapasitesi OPEN; peak heap NOT_OBSERVABLE. Planlanan100upload/gün×60s×0.128GB=768GB-s/gün yalnız konservatif modeldir; gerçek billing ölçümü değildir, pending I/O residency60s ile bounded olduğu iddia edilmez.

## Devam checkpoint'i: kaynak review kapandı, izole provider hazırlığı başladı

Fresh bağımsız Sol HIGH20261015_104956_a0a874 ilk kaynak incelemesi0BLOCKER/2IMPORTANT/FAIL idi. I1 gerçek kimliksiz JSON stream admission-kilitleme kusuru kalıcıRED→runtime multipart-only precheck→GREEN ile kapandı; generic security middleware gevşetilmedi. I2 observedabort/lateR2 custody ve gerçek nativeD1 BEFORE/AFTER finalcommit+sessionrevoke+deadline+samebody/keyresume/replay yarışları kalıcı testlere eklendi. Aynı reviewer correction0BLOCKER/0IMPORTANT/1OPTIONAL/PASS; bağımsız3dosya12test61.31s PASS/371frozenhashdrift0. Generic busy-beforeauth occupancy sinyali OPTIONAL/nonblocking bırakıldı; tenant/actor/belge bilgisi sızıntısı kanıtı değildir. ÖncekiFAILreport exacthash retained.

Exact isolated executor ilkHIGH0BLOCKER/4IMPORTANT/FAIL:20objectcleanup eski6sınırına takılıyor, aynı nativeCPU EDGE/DO'ya çift atanabiliyor, partialnamespacecustody eksik ve requiredbindingreadback gevşekti. Yerel executor düzeltmesi ve AST-onlyRAM karşı-probları sonrası aynı reviewer dar correction0/0/0PASS;406frozeninputdrift0. EDGE/DO group/native/markerID ayrılığı ve cross-stage reuse reddi;20exactledgercleanup; namespaceidentity/foreignbaseline;partialDB/read-onlyreconcile;strictallrequiredtypes/CSRF/rates/DBR2/DO+bundle readback koşulları kapandı. Bu isolatedexecutorpreflight'tır; productiondeploymentyetkisi veya kapasitePASS değildir.

Yalnız yeni disposable scope run254a48b1-3c0e-49ec-ac15-0773285d2bb8 / mayi-http-6568760fe8 EUDB/EUbucket/Worker oluşturuldu. Canonical21migration350schemaobject/176trigger/FK0 importreadback, syntheticseed, SQLiteDOdeployment ve uploadedmodule=frozenproposedbuild exactbytes PASS. Version211da97c-d02f-4ac2-af84-d85855458499/deploymentdc182044-813b-432c-bcd3-aefd458a056d/namespace4014688542a84cc8b8d6ad536a20ccfd. İzolepublicWorkerDOCUMENTStrue/JOBSCRONfalse/nozone-route/noCron/noQueue/privatebucket; gerçekproductionDOCUMENTSfalse ve protectedbaselineequal. Productiondeploy/productionD1write yok.

İlk tinyPDF aşaması CSRFGET401'de, uploadPOSTintent oluşmadan durdu: uploadPOST0/documents0. Salt-okunur health200/CSRF401/me401 ve D1 tüm sessionversion/lifecycle/expiry canlı. Kesin fixture kusuru: yerel hazırlık urlsafe cookie üretmişti, canonical session reader64lowerhex ister; byte/token değeri yazdırılmadı. İlk nativeprep yalnızD1liveness kontrol etmiş, cookieformatı doğrulamamıştı. Eski seed/STOP korunur. Yenihexformatlı tekeksyntheticsessionINSERT sidecar preflight'ı sürüyor; Workerredeploy/resourcecreate/schemaimport/başarılıprovideroperation tekrarı yok. Bu hata WorkersFreeCPUfailure değildir; hiçbiruploadCPUsample oluşmadı.

Consolidatedparentintegration11files45tests ilk40PASS/5FAIL: eski public-session fixture privateDO binding sağlamadığı için503 ve gate-matrix'in4enabledcase'i aynı yenibinding yokluğunda eski401 bekledi. Productfallback eklenmedi; testfixturecorrection henüz yapılmadı. Source/typecheck/rootlint/fullformat/boundaries/productiondryrun ayrıPASS; fullintegrationPASS iddiası yok. Tarihsel ve yeniFAIL/STOP'lar retained.

## Güncel provider sonucu ve kontrollü duruş

Fixture düzeltmesi fresh aynıHIGH dar preflight ve scope-bound gerçek closed reviewer custody sonrasında yalnız mevcut isolated D1'e tek yeni64hexsyntheticsessionINSERT ile yapıldı; eski hatalı fixture retained. Başarılı create/import/deploy tekrarlanmadı. Reviewer'ın farklıscope raporuyla önceki kabulün lastJSON eşleşmesini bozması yerel gateSTOP üretti; latestactualJSON-by-exact-scope kontrolü ve missingINSERTreceipt'ten bağımsız mandatorycleanup/reconcile sırası aynıreviewer dar correction0/0PASS ile kapandı. Provider işlemi bu gateSTOP sırasında başlamadı. Bu historicalfailure'lar silinmedi.

Toplam dört yeni uploadPOST, hepsi HTTP202/canonicalparser/serverSHA/strictreceipt/audit/job/fullR2binaryintegrityPASS; retry0:

| Workload | Boyut | EDGE native CPU/wall | DO native CPU/wall | Kanıt |
|---|---:|---|---|---|
| Tiny PDF |369byte|3ms /1585ms|40ms /1021ms|Ayrı exact invocation/group/native ID, outcomeok/untruncated |
| Tiny JPEG |723byte|2ms /1458ms|43ms /1071ms|Ayrı exact invocation/group/native ID, outcomeok/untruncated |
| Tiny PNG |81byte|3ms /852ms|16ms /822ms|DO start console marker NOT_OBSERVABLE; exact complete202+pozitif native terminal ve inventory eşitliğiyle read-only completion |
|12sayfa PDF|1659byte|CPU/wall NOT_OBSERVABLE|44ms /1228ms|Canonical integrityPASS, partial resource evidence; capacity receipt kabul edilmedi |

İlk tinyPDF dar client-end+1000ms sorgu penceresi provider completion satırlarını dışarıda bırakmıştı. Aynı istek sabit+60s genişletilmiş bounded salt-okunur pencereyle tamamlandı; nedeninin clockskew olduğu varsayılmadı. TinyPNG console-start eksikliği yalnız samegroup exact complete/native terminal/entrypoint/version/outcome/CPU/markerinventory ve farklı EDGE/DO ID şartları altında forward-only dar evidence adapter'ıyla kapandı. Adaptörler aynıHIGH preflight0/0PASS; eskiSTOP preserved. Komşu CSRF native CPU18/11/12ms hiçbir upload'a ödünç verilmedi; authHTTP kapasitesinin tamamı kapandı denmez.

12sayfa PDF'de EDGE start+complete marker'ları var, fakat aynıgroup native lifecycle/CPU yok; DO44ms pozitif kaydı veya komşu CSRF12ms onun yerine kullanılmadı. Bounded read-only polling ve broad inventory sonrasında M4_HTTP_SUSTAINED_FREE_CAPACITY_ACCEPTED=NO. Bu gerçek CPU-budget failure diye sunulmaz; canonical işlem başarılı, ölçüm kanıtı eksiktir. Representative1024x768JPEG/PNG, exact20MiB, gerçekoverlap ve12mixedPOSTsustained planı ÇALIŞTIRILMADI. Eski20MiB615ms veya native4ms yeniDO'ya taşınmadı. Peakheap/sharedKDFheadroom/mainQueue-privateleafRPCinheritance/fullpipelinekapasite OPEN.

## Cleanup ve üretim

Mandatorycleanup ONCE: yalnız ownedtemporaryWorker class-delete migration→namespaceabsence+permanentKDFnamespaceexactbaseline;404noopWorker→WorkerDELETE→GET404; dört exactD1ledgerobject fullbyte/hashreadback→tekDELETE→GET404; atomicemptyEUbucketDELETE→GET404; ownedEUDBDELETE→GET404. Bütün ownedWorker/bucket/DB/namespace absent; productionprotectedWorker/Queue/storage/domain/route/backupalert/subscriptionbaselineequal. Class-delete migration cleanup'tır, productionrelease değildir. Kaynakların aktif deney olduğu dönem bitmeden dokunulmadı; temizliği tekrar yapılmadı.

Production version7e97419b-241a-4cf1-92de-d4ee62d70002/deployment182b1c6d-0542-4568-8e20-6453a73d297b/traffic100 unchanged; DOCUMENTSfalse/JOBSCRONtrue, existingv2Queue+DLQ/oldQueue/Cron unchanged. WorkersPaid açılmadı; mevcutR2paidmetadata unchanged. Productiondeploy/D1domainmigration/gerçekmüşteriverisi/monitoring/recovery/frontendredesign0. Yeni DO adayı production'a deploy edilmedi; incompletecapacity proof deployment gerekçesi yapılmadı.

## Son yerel doğrulama ve acceptance sınırı

Eski iki test fixture'ı yeni privatebinding sözleşmesine göre düzeltildi: public-session Node/nativeD1 yolu explicit testedruntime seam kullanır, actualSQLiteDOworkerd testi ayrı kalır; gate-matrix missingbinding503/noHTTPfallback koşulunu korur. Parent correctedconsolidated11files45tests44PASS/1nativeAFTERcommittimeout90s retained; tam affectednativefile isolated2/2PASS ile kapandı. Böylece correctedaggregate'taki43unaffectedPASS+ikiisolatedaffectedPASS coverage uzlaştırılır; tek clean45aggregate veya fullreposuitePASS denmez. Typecheck/rootlint/fullformat/clientbuild/boundaries/diff/productiondryrunPASS. Kaynak runtime/config hash'leri provider deneyinden sonra değişmedi; yalnız iki eski fixture testi düzeltildi. Rawprototype acceptedreview/tests ve expensivehistoricalP4 rerun yok.

M4_HTTP_ADMISSION_ARCHITECTURE_ACCEPTED=NO; M4_HTTP_SUSTAINED_FREE_CAPACITY_ACCEPTED=NO; DOCUMENTS_ENABLED=false; FEATURE_ENABLED=NO; M4_COMPLETE=false. Farklıfresh POST SolHIGH20261015_125509_5db138 gerçekmodel/provider/HIGH/parentNULL/closedfinalJSON ve379freeze drift0 doğrulandı:0BLOCKER/0IMPORTANT/1OPTIONAL/PASS yalnız RECOVERED_LOCAL_DO_SOURCE_AND_HONEST_NO_GO_CHECKPOINT_ONLY. Bağımsız52GET+8drytelemetryPOST/0mutation,40RAMassertion; üçtinyCPUproofu,12pagePDFEDGEeksikliği, ownedcleanupabsence ve productionfalse/QueueCron/WorkersFree independentlyreadbackPASS. Capacity/mimari/deploy/publickabulü değildir. Yalnızsource/evidence normalcommitpushyetkisi kapanır; reviewsonrasıüçmetadatafileappend dışında source/config/test değişmedi. Parentson11GET2026-10-15T10:08:45Z prod7e97419b/deploy182b1c6/flagsfalse-true-true/threeQueuesequal/Cronunchanged/ownWorkerbucketDB404/nsabsent/permanentKDFonly/subscriptionssamePASS. Kaynak/kanıtimplementationcommit b7fd27bb950f96af1779eea967a7716f2c08d673 normalpush+fetch sonrası localHEAD/origin/main/remote eşit ve worktreeclean doğrulandı; ardından yalnız closeoutmetadata docs güncellenir. Originalcapacitymission tamamlanmış sayılmaz. Sonraki mühendislik kapısı retained12pagePDF aynı EDGE nativeCPU positivekanıtını salt-okunur kurtarabilmek; yoksa yeniupload/deploy tekrarlamadan supportedattribution stratejisini ayrı preflight etmek. Bu checkpoint publicflip veya ekcanary'yi otomatik başlatmaz. Güvenli kalıcı receipt: M4_HTTP_ADMISSION_RECOVERY_RECEIPTS.json.
