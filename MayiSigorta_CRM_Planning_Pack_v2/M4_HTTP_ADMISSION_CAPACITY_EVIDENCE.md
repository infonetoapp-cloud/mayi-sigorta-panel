# M4 HTTP admission — F-37 bounded kapasite denemesi

15 Ekim 2026. Başlangıç main/HEAD/origin/main/remote `707e10d56803d323c83f1709542eeda76ab1bb49`, worktree temiz. F-36 private SQLite DO adayı korunmuştur; production/server/test/config dosyası değiştirilmedi. Sonuç: attribution modeli çalıştı, fakat representative JPEG HTTP503 nedeniyle kapasite profili tamamlanamadı. Bu kayıt sürdürülebilir Free kapasite veya yeni CLOSED deployment kabulü değildir.

## Retained kanıt ve desteklenen attribution

Eski Worker'ın 12 sayfa PDF isteği önce tekrar salt-okunur sorgulandı. Aynı EDGE native CPU kaydı hâlâ yok; eski DO44ms veya komşu CSRF GET12ms onun yerine kullanılmadı. Eski POST, deploy, create ve cleanup tekrarlanmadı.

Yeni, ayrı owned run `70fe679b-8258-4e82-b1f4-04b05731f487` / Worker `mayi-http-298014245c`: tek EU D1/private EU bucket/SQLite DO Worker oluşturuldu. Mevcut21 canonical migration350schemaobject/176trigger/FK0 ve sentetik canonical64hex session native fixture ile doğrulandı. Provision/import/deploy birer kez; uploaded worker.js=frozen proposed bundle exact bytes PASS. Version `fd7769c7-fbce-4326-9fee-b7d916c50940`. JOBS/CRONfalse, Queue/Cron/zone route yok; gerçek production DOCUMENTSfalse.

CPU identity: owned Worker/service + deployed version + POST + exact origin/path + tekil public stage + EDGE/default veya named DO entrypoint. Her stage tek POST intent'tir. Optional requestId/invocationId/groupID ve console lifecycle CPU için zorunlu değildir. UUID run query privacy redaction ile REDACTED oldu; orijinal token tahmin/onarım yapılmadı. Public stage, owned service/version ve native çift üzerinden salt-okunur adapter kullanıldı. Ham native satırlar değiştirilmedi, native hash gerçek satırdan üretildi. Gerçek finite nonnegative CPU/wall, matching HTTP status, outcomeok ve truncatedfalse zorunlu kaldı. Resource outcome/exception/truncation veto'su gevşetilmedi.

## Gerçek provider ölçümleri

| Workload | Exact byte | HTTP | EDGE CPU / wall | DO CPU / wall | Sonuç |
| --- | ---: | ---: | --- | --- | --- |
| 12 sayfa sentetik PDF | 1659 | 202 | 4ms / 1444ms | 76ms / 860ms | Canonical parser/serverSHA/strictDTO/D1 receipt-audit-job/fullbinary R2 integrity PASS; native çift ayrı |
| 1024×768 sentetik JPEG | 22115 | 503 | 9ms / 1297ms | 330ms / 1072ms | Functional FAIL; native outcomeok/untruncated, resource exception gözlenmedi; kapasite PASS değil |

Toplam2 uploadPOST, automatic retry0, successful POST replay0. JPEG için retained D1 readback: documents2/versions2/receipts2/jobs1; PDF BACKUP_PENDING, JPEG PENDING_UPLOAD/validationNULL, JPEG receipt IN_PROGRESS/response_statusNULL. Her iki nesne full byte/size/SHA readback eşleşti. Unvalidated content AVAILABLE yapılmadı; background pipeline çalıştırılmadı. 503 response body eski executor'da tutulmamıştı; sadece HTTP/status/byte163 var. Bu yüzden kesin provider hata kodu veya final batch exception nedeni geri kazanılamadı. State finalization'ın tamamlanmadığını kanıtlar; R2 write acknowledgment/final batch kök nedenini kesinleştirmez. CPU-budget exception veya kanıtlanmış Workers Free mimari sınırı diye sunulmaz.

Aynı canonical source/migrations/synthetic seed/aynı PDF+JPEG bytes ile ayrı yerel Miniflare SQLiteDO→canonical testinde202/202 ve iki BACKUP_PENDING sonucu alındı. Yerel D1 batch hata instrumentation'ı tetiklenmedi. Bu yerel teşhis provider503'ü düzeltmiş veya provider kapasitesini kanıtlamış sayılmaz; kör source düzeltmesi yapılmadı.

Representative PNG, exact20971520byte, controlled overlap ve12mixed sustained aşamaları ÇALIŞTIRILMADI. Attribution geçse de sonraki representative functional gate503 ile başarısız oldu; ileri yük, eksik finalization üzerine başarısız POST replay'i veya yeni deployment başlatılmadı. 9ms EDGE yalnız bu başarısız isteğin ölçümüdür; 1ms nominal CPU marjı sürdürülebilir headroom kabulü değildir. Peak heap NOT_OBSERVABLE; tüm format/size/overlap, shared KDF headroom ve main Queue/private leaf kapasitesi kapanmadı.

## Review ve korunan FAIL/STOP

Fresh bağımsız Sol HIGH `20261015_174913_d61129` executor preflight ilk0BLOCKER/5IMPORTANT/FAIL: mutable journal freeze, owned bucket DELETE allowlist, inventorywide failure veto, hatalı3client overlap iddiası ve catch-up pacing. Dar correction0/0/1OPTIONAL/PASS;403frozeninputs0drift/40RAM PASS. Profil two actual client/18maximumPOST/17expected202+1busy olarak küçültüldü; actual execution yalnız2POST'ta durdu. Eski404manifest/FAIL/STOP/stage/bundle kaynakları korundu. CRLF arşiv nüshası yanında exact LF original SHA2e83778a... ayrıca korundu; OPTIONAL custody kaydı sonraki review'de kapandı.

Run-query redaction adapter aynı reviewer dar HIGH0/0/0PASS;410pins0drift/43retained+RAM cases PASS. Yeni PDF native4/76 bağımsız yeniden hesaplandı; POST tekrar edilmedi. Bunlar executor/attribution review'larıdır; kapasite/mimari/deployment/public kabulü değildir.

Bir ek evidence-harness sınırı: native HTTP503 invocation satırında Cloudflare source.level=error yazıyor; outcomeok ve exception yokluğu bu etiketi resource exception yapmaz. Gelecekte expected busy503 ölçülecekse status-aware native HTTP/exception ayrımı ayrıca doğrulanmalı; mevcut global error veto bu aşamada fail-closed kalmıştır. Çalıştırılmamış overlap için PASS iddiası yok.

Fresh farklı consequential Sol HIGH20261015_183716_a34866:0BLOCKER/0IMPORTANT/0OPTIONAL/PASS yalnız SUPPORTED_ATTRIBUTION_AND_HONEST_FUNCTIONAL_NO_GO_CHECKPOINT_ONLY. Actual model/provider/HIGH/parentNULL/ended_at/cli_close/finalJSON eşitliği ebeveyn tarafından doğrulandı;469finalpin/403executor/410adapter/84receiptreference drift0. Bağımsız48corecheck, toplam23GET+3drytelemetryPOST/appPOST0/mutation0: eski12pageEDGE eksikliği ve yeniPDF4/76/JPEG9/330 native/status ayrımı live sorguyla yeniden doğrulandı; production settings/version/Queue/Cron/Free ve eski+yeniownedabsence bağımsız readback PASS. Reviewer'ın ilk8GET sonrası yanlış namespace class varsayımı STOP'u korunur; pinned gerçek PasswordKdfDurableObject düzeltmesi provider failure değildir. Silinmiş binary'ler tekrar indirilmedi; retained binary/ledger kanıtı bağımsız yeni download diye sunulmadı. Kapasite/mimari/yeniDO runtime kabulü yok, CLOSED deploy izni false. Review sonrası yalnız üç kapanış metadata belgesi güncellendi; source/config/test değişmedi.

Önceden accepted pahalı testler tekrarlanmadı. Bu görevde yeni native seed hazırlığı, focused RAM ve aynı-input yerel native diagnostic çalıştı; source/config/test bytes önceki accepted adayla aynı kaldı. Production dry-run yalnız yerel conditional CLOSED release hazırlığıdır; deployment yapılmadı. İlk local preparation STOP, gereksiz deployment author-email metadata'sını secret-safe save'in reddetmesiydi; ID/version projection düzeltmesi sonrası preparation PASS, provider mutation0. Bu da preserved STOP'tur.

## Cleanup ve production

Deney functional FAIL ile kapatılınca owned kaynaklar güvenli cleanup adayı oldu. Class-delete migration ONCE→namespaceabsent/permanent KDF eşitliği; temp WorkerDELETE→404; iki exact ledger object fullhash→DELETE→404; atomic empty EU bucketDELETE→404; owned EU D1DELETE→404. Cleanup PASS. Fresh parent15:31:59Z11GET production version `7e97419b-241a-4cf1-92de-d4ee62d70002` / deployment `182b1c6d-0542-4568-8e20-6453a73d297b` traffic100, DOCUMENTSfalse/JOBStrue/CRONtrue, üç Queue eşit, Cron unchanged, WorkersFree unchanged, tüm owned kaynaklar absent ve tek permanent KDF namespace kaldı.

Yeni production CLOSED deployment gerekçesi oluşmadı; yalnız yerel dry-run hazırlanmıştı. Production source/bindings/Queue/Cron/D1/domain/billing unchanged. Paid/realcustomerdata/frontend/Excel/monitor-account/remote-recovery işi yok. FEATURE_ENABLED=NO, M4_COMPLETE=false.

## Kalan tek odaklı mühendislik işi

Mimariyi değiştirmek veya Paid'e çıkmak değil: canonical R2 write/finalization sınırında credential/body içermeyen bounded safe error-phase/code custody sağlamak; ancak ayrı exact preflight sonrasında kontrollü aynı-key başarısız-operation resume ile root cause/tek finalization kanıtını kapatmak. Temizlenen eski Worker/DB/operation canlandırılmaz; bu recovery doğrulaması yeni ayrı sentetik failure fixture ve custody/provisioning sınırı gerektirir. Başarılı PDF'yi tekrar POST etmek gerekmez. Sonra henüz ölçülmemiş PNG/exact20MiB/gerçek overlap/sustained kalan profili yürütmek. Şu an public activation öncesinde anlamlı backend blocker vardır: representative provider503/finalization nedeni ve eksik kapasite profili. Historical main Queue/private leaf ve operational gates ayrıca korunur; bu görevde çözülmüş sayılmaz.

Güvenli receipt: M4_HTTP_ADMISSION_CAPACITY_RECEIPTS.json. M4_HTTP_ADMISSION_ARCHITECTURE_ACCEPTED=NO; M4_HTTP_SUSTAINED_FREE_CAPACITY_ACCEPTED=NO. Önceki canonical20MiB/CLOSED kaynak/UI/security dar kabulleri kendi historical kapsamlarında korunur; yeni DO capacity/runtime kabulü yerine geçmez.
