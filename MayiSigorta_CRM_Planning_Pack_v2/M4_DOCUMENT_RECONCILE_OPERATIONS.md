# M4 — hedefli DOCUMENT_RECONCILE yerel işletim sözleşmesi

Bu belge nihai mimari planın 10.3 ve 14.1 bölümlerinin yerel/sentetik uzlaştırma uygulamasını açıklar. Restore veya retention/silme prosedürü değildir. `DOCUMENTS_ENABLED=false` korunur; gerçek hesap/IAM/lock/ClamAV ve restore kabul kapılarının yerine geçmez.

## Kalıcı hedef ve teslim

- İç işletim kodu `enqueueDocumentReconcile(db, agencyId, target, operationId)` ile tek hedef oluşturur. Client route veya genel bucket yönetim API'si yoktur.
- Hedef ya `{ versionId }` ya da `{ kind: 'PRIMARY' | 'BACKUP', objectKey }` olur. Object key yalnız private `quarantine/UUID` veya `backup/UUID` biçimindedir; müşteri metni içermez.
- `operationId` işletimin belirlediği kontrol döngüsüdür; Queue tekrarlarında değiştirilmez. Aynı agency/hedef/döngü kanonik job ID'ye yakınsar. Sonraki fiziksel depolama kontrolü yeni döngüyle istenir; terminal job yeniden açılmaz.
- Mevcut BackgroundJob şeması RECONCILE için null `document_version_id/input_sha256` gerektirir. Hedef, job ile aynı D1 batch'inde yazılan değişmez `document.reconcile.requested` SYSTEM audit olayının allowlisted JSON alanlarında bağlanır. Queue yalnız job ID/tür/generation ve null input alanlarını taşır; payload hedef veya kanıt oluşturmaz.
- Mevcut beş dakikalık dispatcher, bounded 100-job batch, lease/CAS, en fazla beş gerçek deneme, retry ve expired-lease reclaim kullanılır. Runtime verifier capability açıkça enjekte edilir; varsayılan Worker'da gerçek backup erişimi yapılandırılmaz.
- Bucket taraması veya list-all yoktur. Nesne hedeflerini işletim/envanter kaynağı sağlayabilir; bir job yalnız bir sürüm veya bir anahtar inceler.

## Sonuçların anlamı

- `SAFE_NOOP`: hedef tutarlı veya job'ın sürümü artık güncel değildir. Run reason code, gerçekten doğrulanmış tutarlılığı `RECONCILE_TARGET_SUPERSEDED` gibi mutation yapılmayan stale hedeften ayırır.
- `SAFE_REPAIR`: mevcut immutable kanıt ve gerçek byte proof ile ispatlanmış onarım. Kesilmiş backup finalizasyonu mevcut DOCUMENT_BACKUP executor'ı ve kendi lease/generation/CAS kapıları üzerinden yapılır. Reconciler backup yazmaz; yalnız zaten mevcut exact nesneyi doğrulayan adapter kullanır. D1 completion sonrası son durum ve nesneler yeniden doğrulanır.
- `INVESTIGATE`: kalıcı çelişki; run `PERMANENT_ERROR`, reconciliation job `COMPLETED`, `last_error_code` bounded discrepancy code ve immutable `document.reconcile.discrepancy` audit kaydı. COMPLETED burada incelemenin bittiğini gösterir, belgenin kullanılabilirliğini değil. Transient retry tükenirse job `DEAD` ve beş gerçek run kanıtı tutulur.
- `RETRY_SCHEDULED/RETRY_DELIVERY`: bağımlılık, timeout veya eşzamanlı durum değişimi; erişim/kanıt oluşturulmaz. Deadline sonrası geç gelen callback reconciliation completion yapamaz. Yarım kalmış lease dispatcher tarafından reclaim edilir.

Güncel yayımlanmış sürümde doğrulanmış eksik/bozuk primary, backup veya çelişkili kanıt varsa, tek atomik D1 batch'inde discrepancy audit ve job/run sonucu ile `documents.current_version_id` kaldırılır. Immutable DocumentVersion, scan ve backup evidence değiştirilmez/silinmez. Stream'in mevcut exact current-version kapısı erişimi kapatır; `AVAILABLE` etiketi tek başına indirme yetkisi değildir. Nesneler ve güncel CLEAN/inspection/backup kanıtı sonraki döngüde yeniden doğrulanırsa publication pointer güvenle onarılabilir.

Tarihsel backup anahtarı tam kendi immutable copy/generation bağıyla doğrulanır; yeni kopya eski anahtarın yerine kanıt sayılmaz. Explicit primary/backup anahtar hedefi, daha yeni DocumentVersion mevcutken de o tarihsel nesnenin gerçek baytlarını inceler; obsolete version job'ı ise mutation yapmadan kapanır. Eski kopya hatası güncel, ayrı doğrulanmış generation'ın publication pointer'ını kaldırmaz. Superseded scan/backup job yeniden başlatılmaz; eski CLEAN yeni scan generation'ı için kullanılamaz.

## İnceleme ve güvenlik sınırı

- Kalıcı operasyon görünümü için `background_jobs` içinde `job_type='DOCUMENT_RECONCILE'` ve non-null `last_error_code`, ilgili `background_job_runs.reason_code`, `system_audit_events.action='document.reconcile.discrepancy'` ve `document.reconcile.queue_exhausted` birlikte incelenir. Personel/client'a nesne anahtarı veya operasyon logu açılmaz.
- Aynı immutable identity/generation/discrepancy tekrarları audit unique key ile birleştirilir; tekrar teslim job/run/audit/evidence çoğaltmaz. İlk discrepancy kaydı silinmez; onarım SYSTEM audit/run ile ayrıca kanıtlanır.
- Primary upload finalizasyonu bir kullanıcı authorization/receipt işlemidir. Nesne baytı tek başına güncel kullanıcı yetkisini kanıtlamaz; `PENDING_UPLOAD` nesnesi `RECONCILE_UPLOAD_INTERRUPTED` olarak kaydedilir, reconciler upload receipt veya scan sonucu üretmez. Yetkili kullanıcı exact upload retry yolunu kullanır.
- UNKNOWN/missing/stale scanner veya inspection hiçbir zaman CLEAN olmaz. Backup kanıtı mevcut nesnenin agency/version/generation, tam uzunluk/EOF ve incremental SHA-256 doğrulaması olmadan oluşturulmaz. Nesne başına 20 MiB ve job başına en fazla 120 saniye sınırı vardır.
- Orphan/unknown-owner nesneler yalnız tespit edilir; benimsenmez, servis edilmez, silinmez. Mimari 24 saat karantina ve retention işlemleri bu dilimde uygulanmaz.
- Backup capability hiçbir zaman delete/list/raw bucket/download/overwrite içermez; primary deletion da reconciliation'a eklenmez. Backup'tan primary'ye restore/fallback yoktur.
- Audit alanları güvenli server ID/key, expected checksum, generation, job/run ve bounded code ile sınırlıdır. Byte, filename, serbest müşteri metni, credential/token veya raw confidential metadata yazılmaz. Arbitrary adapter hata metni bounded allowlist dışındaysa sabit integrity code'a indirgenir. Nested backup executor'a geçen verifier integrity hatası yalnız accepted `BACKUP_PROOF_MISMATCH`, primary get/body-read integrity hatası ise `BACKUP_SOURCE_IDENTITY_INVALID` koduna çevrilir. Verifier proof alanları catch içinde bir kez okunup exact identity ile eşleştirilir; executor'a dış alias/getter değil server-owned düz, sabit proof döner. Primary facade size/checksum/body alanlarını sabitler; chunk uzunluğu native internal slot üzerinden alınır, bounded native byte kopyası dış alt sınıf/getter'ı taşımadan iletilir. Zero-prefetch stream ile cancellation/backpressure korunur. Beşinci gerçek denemede dahi raw adapter metni job/run alanlarına geçmez.
- D1 ve object storage ortak ACID transaction değildir. Byte verification zamana bağlı gözlemdir; final D1 CAS, incelenen durable state'i tekrar kontrol ederek daha yeni worker başarısının üzerine yazmayı engeller. Fiziksel storage'ın gerçek immutable/IAM sınırları dış kabul kapısında ayrıca kanıtlanmalıdır.
