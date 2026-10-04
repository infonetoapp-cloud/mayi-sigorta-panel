# M4 — gerçek yerel ClamAV / EICAR kanıtı

Durum: **REAL ClamAV / EICAR = VERIFIED**. Yalnız yerel gerçek motor kapısıdır; uygulamaya gerçek scanner bağlanmadı. **M4 COMPLETE=false; DOCUMENTS_ENABLED=false; M5 başlamadı.**

Başlangıç: 4 Ekim 2026; başarılı motor doğrulaması: **5 Ekim 2026 00:09 Türkiye / 4 Ekim 2026 21:09 UTC**. Kabul edilmiş değişmeyen uygulama tabanı: `4aa06b7f64b51a9b96e0c85fcf67d0e44fa9b3a4`, `main`.

## Ortam ve resmî dağıtım

- Windows 11 Pro x64, `10.0.26300`, build `26300`; firmware virtualization ve SLAT açık. İlk kontrolde C: boş alan `68045127680` bayt.
- `wsl --version`, `--status`, `-l -v`: WSL kurulu değil; dağıtım listesi alınamadı. Docker CLI/daemon/Desktop ve PATH üzerindeki clamscan/clamdscan bulunmadı; standart Docker/ClamAV kurulum yolları da yoktu. Önceki kayda güvenilmeden yeniden kontrol edildi.
- Resmî ClamAV belgeleri Windows için portable ZIP'i destekler. Yalnız bu dağıtım kuruldu; WSL/Docker kurulmadı, UAC/reboot gerekmedi. Kalıcı Windows servisi veya tarama portu açılmadı; motor istek üzerine başlatılır ve tarama sonunda kapanır.
- Kaynak: Cisco-Talos resmî release `clamav-1.5.4`, `clamav-1.5.4.win.x64.zip`, `225774978` bayt. GitHub release varlığı ve SHA-256 API üzerinden doğrulandı.
- ZIP SHA-256: `0d9e0228b2674137ea1a2853566c98a0278ad52ab2582c3d6dbd75373848c395`.
- Resmî `.sig` ve Cisco Talos public key ile izole GPG keyring'de **Good signature**, exit `0`. Fingerprint: `5BADCA2665EF59DCF8A23D8B707F0DB480836771`. GPG'nin yerel web-of-trust sertifikasyonu yok uyarısı korunur; key provenance resmî dokümantasyon deposudur.
- Kurulum repo dışında `%LOCALAPPDATA%\MayiSigorta\ClamAV\1.5.4\clamav-1.5.4.win.x64`; PATH/global güvenlik ayarı değiştirilmedi. Image tag/digest **uygulanamaz**; Docker/Container kullanılmadı.
- Gerçek scanner'lar: `clamscan.exe` ve aynı dağıtımdaki **`libclamav.dll`**, sürüm **1.5.4**. DLL SHA-256: `5d7e525494e8a5c27282ce015b3444dfe230b982feecf7e477142a45be85b41a`; clamscan SHA-256: `f368912f61ddea8b302acf9114891ec57f8a45b0de77f076b1d19c960bc6f7cf`.

## Gerçek imza veritabanı ve motor başlangıcı

`freshclam.exe` resmî `database.clamav.net` kaynağından indirdi, database load-test geçti; updater exit `0`. Custom/synthetic signature veya allowlist eklenmedi.

| Database | Version | Signature count | Build UTC |
| --- | --- | --- | --- |
| daily.cvd | 28143 | 355713 | 2026-10-04T06:25:22Z |
| main.cvd | 63 | 3287027 | 2025-12-16T23:18:22Z |
| bytecode.cvd | 339 | 80 | 2025-09-11T12:29:19Z |

Üç database için `sigtool --info`: **Verification OK**. Ayrı `sigtool --verify` + dağıtımın `certs` dizini: üçünde de exit `0`, signer `ClamAV_datafiles_release`. main/bytecode tarihleri eski baseline yayın tarihleridir; günlük güncellik daily ile ölçülür. Başarılı doğrulamada daily yaşı `53049.522899` saniye, 48 saat sınırının altında.

Native API'de `cl_init`, `cl_load` ve `cl_engine_compile`: **CL_SUCCESS (0)**; yalnız resmî database yükleme (`CL_DB_STDOPT | CL_DB_OFFICIAL_ONLY = 0x300A`). Gerçek motorun yüklediği signature sayısı **3628118**; bu motor sayacıdır, database header toplamı diye sunulmaz. `cl_engine_free`: exit/return `0`.

## EICAR: gerçek tespit, güvenlik zayıflatılmadan

EICAR resmî spesifikasyon sayfasındaki canonical **68 ASCII bayt** alındı; executable çalıştırılmadı, gerçek malware kullanılmadı. Payload SHA-256: `275a021bbfb6489e54d471899f7db9d1663fc695ec2fe2a2c4538aabf651fd0f`.

İlk `clamscan ... -` stdin denemesi ClamAV geçici dosyasını Defender'ın yakalamasıyla **exit 2**, `Can't open file or directory ERROR`, zero infected verdi. Bu başarısızlık başarı sayılmadı. Defender kaydı: `Virus:DOS/EICAR_Test_File`, remediation başarılı, `DidThreatExecute=false`, `IsActive=false`; tarama-temp dizini son kontrolde boştu.

Dar alternatif: resmî `clamav.h` memory-buffer API'si. Repo dışındaki verification harness, Python ctypes üzerinden **resmî DLL'nin kendisini** çağırır: `cl_fmap_open_memory → cl_scanmap_ex`; 68 bayt disk dosyasına yazılmaz veya çalıştırılmaz. Bu synthetic scanner adapter değildir.

| Tarama | Gerçek API sonucu | Verdict | Detection | Taranan bayt |
| --- | --- | --- | --- | --- |
| EICAR memory buffer | `cl_scanmap_ex` return `1` | `2`, STRONG_INDICATOR | **Eicar-Test-Signature** | **68** |
| EICAR ikinci API kontrolü | `cl_scanmap_callback` return `1`, CL_VIRUS | legacy API | **Eicar-Test-Signature** | bu API'nin byte sayacı kanıt olarak kullanılmadı |

Bütün assertion'ları denetleyen harness process exit **0**. Bu exit, EICAR CLEAN demek değildir: motor return **1** ve detection ayrıca kayıtlıdır. 1.5.4 extended API header'ının return-code açıklaması ile gerçek return `1` farklıdır; gözlenen değer değişmeden kaydedildi. Legacy cross-check byte-count warning verdi; yalnız detection/CL_VIRUS kanıtı kabul edildi. Python SSL önce yüklenince native DLL yüklemesi `WinError 127` ile başarısız oldu; network/hash yardımcılarını ayrı kısa süreçte çalıştırmak DLL çakışmasını çözdü. Bu başarısız harness başlangıçları kabul koşusu değildir; resmî binary/header değiştirilmedi.

Defender servisi, antivirus ve real-time protection ilk ve son kontrolde **true**. Firewall profilleri son kontrolde enabled. Defender exclusion, firewall/BIOS/Secure Boot/boot/Windows security veya execution policy değişikliği yapılmadı.

## Temiz kontrol dosyaları

Gerçek müşteri dosyası yoktur. Mevcut `tests/fixtures/documents.ts` fonksiyonlarından `createSyntheticPdf()`, `createSyntheticJpeg(2,2)`, `createSyntheticPng(2,2)` ile repo dışında üretildi.

| Kontrol | Boyut | clamscan | Native memory API | SHA-256 |
| --- | --- | --- | --- | --- |
| safe.pdf | 369 bayt | OK | return 0, verdict 0, 369 bayt tarandı | `1be99ef99876348f478e431d67af2e35a5597d8f903eeec7807cfb08a761a7af` |
| safe.jpg | 613 bayt | OK | return 0, verdict 0, 613 bayt tarandı | `4909a1a1bf9b6edb0c5b9378b7952fff09fabef6506ddb8786ccab89cf0156ce` |
| safe.png | 73 bayt | OK | return 0, verdict 0, 73 bayt tarandı | `e9cb421111e9a6dc2d1704884646f44044cf3874c60f09a86c3208739af3b2a6` |

Tek gerçek clamscan kontrol koşusu: **Scanned files 3; Infected files 0; exit 0; Engine 1.5.4; Known viruses 3628118**. Aynı kontroller, EICAR'ı tespit eden aynı native engine instance'ında da CLEAN döndü. Bu sonuç tüm dosyalar/tehditler için evrensel güvenlik iddiası değildir.

## Uygulamanın outage / UNKNOWN fail-closed sözleşmesi

Ürün/test kodu değiştirilmedi, native scanner uygulamaya enjekte edilmedi. `src/server/index.ts:497` default Queue yolunda hâlâ `unavailableDocumentScanner` kullanır; gerçek Worker/Container wiring doğrulanmış değildir.

- `src/server/documents/scan.ts:148–153`: unavailable → UNKNOWN/SCANNER_UNAVAILABLE; CLEAN üretmez.
- `scan.ts:1115–1124`: scanner exception → durable retry. `1157–1164`: UNKNOWN → retry. `623`: UNKNOWN için CLEAN evidence yok. `841–918`: beşinci denemede fail-closed. `1169–1176`: eski/bozuk imza hata; 48 saat freshness gereklidir.
- `tests/documents.upload.test.ts:1438`, `1601`, `1930`: UNKNOWN, default Worker unavailable ve beş deneme sonunda DEAD/SCAN_FAILED; zero scan evidence/backup; AVAILABLE olmaz. Signature-age ve geç gelen CLEAN/deadline negatifleri de çalıştırıldı.
- Bu görevde iki mevcut odak seçki **4/4** ve **7/7 PASS**; aynı dosyadaki **11 farklı test**. Seçkilerde sırasıyla 36 ve 33 test atlandı; tam suite yeniden çalıştırılmış gibi sunulmaz. Bunlar yerel D1/synthetic adapter sözleşme kanıtıdır, gerçek Cloudflare veya real-engine-to-Worker entegrasyon testi değildir.

## Kullanılan komutlar ve yerel kanıt

Yollar kullanıcı adını içermeyen yerel değişkenlerle gösterilir. Git Bash'te `CLAM=$LOCALAPPDATA/MayiSigorta/ClamAV/1.5.4/clamav-1.5.4.win.x64`, `DB=$LOCALAPPDATA/MayiSigorta/ClamAV/database`, `ROOT=$LOCALAPPDATA/MayiSigorta/ClamAV` kullanıldı.

```text
wsl.exe --version; wsl.exe --status; wsl.exe -l -v
where.exe docker; docker --version; docker version; docker info
where.exe clamscan; where.exe clamdscan
winget show --id Cisco.ClamAV --exact --source winget --accept-source-agreements
clamscan.exe --version
freshclam.exe --config-file=<ROOT>/freshclam.conf --stdout --log=<ROOT>/freshclam-update.log
sigtool.exe --info=<DB>/daily.cvd  (main.cvd, bytecode.cvd de kontrol edildi)
sigtool.exe --verify <DB>/daily.cvd --cvdcertsdir <CLAM>/certs  (üç database)
gpg --homedir <ROOT>/gpg-verification --batch --verify <ZIP>.sig <ZIP>
clamscan.exe --database=<DB> --cvdcertsdir=<CLAM>/certs --official-db-only=yes --fail-if-cvd-older-than=2 --alert-exceeds-max=yes --alert-encrypted=yes --disable-cache <ROOT>/clean-controls/safe.pdf <ROOT>/clean-controls/safe.jpg <ROOT>/clean-controls/safe.png
python <ROOT>/native_memory_proof.py
python <ROOT>/native_memory_proof.py --read-only
npm run test -- tests/documents.upload.test.ts --maxWorkers=1 --testTimeout=180000 -t 'keeps UNKNOWN scans fail-closed|uses a fail-closed unavailable scanner|marks the latest scan attempt DEAD|stale|malformed scanner|throw|timeout' --reporter=verbose
npm run test -- tests/documents.upload.test.ts --maxWorkers=1 --testTimeout=180000 -t 'signature database is older than 48 hours|stalled R2 body read|stalled private R2 object lookup|final checksum digest|late CLEAN|records INFECTED' --reporter=verbose
```

Repo dışındaki yerel kayıtlar: `native-memory-result.json`, `clean-controls-result.json`, `eicar-result.json` (ilk başarısız stdin denemesi), `signature-verification-result.json`, `freshclam-update.log`. Harness SHA-256: `b96ac6df03b7b0ab2c0c88cbeb759c63b783a59a36e9ebb911a676ce009d6418`. Payload, database, binary, Docker data veya yerel harness repo'ya eklenmez; bu belge sonuçların taşınabilir kanıtıdır.

## Bağımsız kontrol ve kapsam sınırı

Fresh, ayrı, salt-okunur reviewer oturumu **`20261005_001543_6fa97f`**: **BLOCKER 0 / IMPORTANT 0 / OPTIONAL 0 — FINAL VERDICT PASS**, yalnız LOCAL REAL ClamAV/EICAR için. Parent'ın salt-okunur session metadata readback'i `gpt-6.1-sol`, `openai-codex`, reasoning effort `high`, `parent_session_id=NULL` ve normal kapanışı doğruladı.

Reviewer `native_memory_proof.py --read-only` ile gerçek motor/EICAR ve aynı engine'deki üç temiz kontrolü bağımsız yeniden üretti: exit 0; engine 1.5.4; EICAR return 1 / verdict 2 / Eicar-Test-Signature / 68 bayt; kontroller complete CLEAN. Üç database info ve detached signature verification yeniden geçti; ZIP/DLL/clamscan/harness hash'leri eşleşti. clamscan kontrol koşusunu ve repository testlerini yeniden çalıştırdığını iddia etmedi; ilk gerçek clamscan kayıtlarını ve kalıcı uygulama assertion'larını inceledi. GPG good-signature kaydı parent kanıtıdır, reviewer yeniden üretmedi.

İnceleme öncesi/sonrası parent tarafından **213 repo dosyası**, **330 substantive Hermes skill/reference/asset dosyası**, harness hash'i, HEAD ve index/status değişmeden doğrulandı. Reviewer iki yardımcı read-only regex/escape kontrolünü düzelterek yeniden çalıştırdı; native kanıt koşusunda başlangıç hatası yoktu. Güncel Defender/firewall durumu yeniden okundu; bu booleans tek başına geçmişteki bütün güvenlik ayarlarının değişmediğinin tarihsel kanıtı sayılmaz. Gerçek çalışma kayıtlarında güvenlik zayıflatan komut kullanılmadı. Review sonrası yalnız bu sonuç/status kaydı güncellendi.

Cloudflare yönetim API'sine erişilmedi; token/secrets aranmadı veya okunmadı. Remote Worker/D1/R2/Queue/Container/Access/DNS/prod restore işlemi yok. Hermes skill/tooling yazımı veya self-improvement yok.

Kalan dış kapılar: gerçek private Cloudflare Container/scanner binding, image digest/egress/temp cleanup/CPU/peak memory/concurrency/region; private R2 ve EU jurisdiction; Queue retention/alarm/uyarı/replay; ayrı backup hesabı/credential ve gerçek IAM no-delete/EU/35 günlük lock; gerçek normal/secure Access OTP+TOTP MFA/audience/policy/drift/login; gerçek tutarlı export/manifest provenance/recovery-key saklayıcısı/saatlik backup/RPO-RTO, kontrollü D1+R2 restore ve güncel offboarding/permission/deletion-tombstone publication kontrolü. Hiçbiri bu yerel motor doğrulamasıyla kapanmaz.

## Resmî kaynaklar

- [ClamAV Windows portable kurulum](https://docs.clamav.net/manual/Installing.html#windows); resmî dokümantasyon kaynak commit'i `88e34cf7c031213747c965f3c56ee854629dd7b7`.
- [Cisco-Talos ClamAV 1.5.4 release](https://github.com/Cisco-Talos/clamav/releases/tag/clamav-1.5.4).
- [ClamAV signature management](https://docs.clamav.net/manual/Usage/SignatureManagement.html), [scanning](https://docs.clamav.net/manual/Usage/Scanning.html), [libclamav](https://docs.clamav.net/manual/Development/libclamav.html).
- [Resmî 1.5.4 memory API header](https://github.com/Cisco-Talos/clamav/blob/clamav-1.5.4/libclamav/clamav.h), [scanner implementation](https://github.com/Cisco-Talos/clamav/blob/clamav-1.5.4/libclamav/scanners.c).
- [EICAR resmî harmless test-file spesifikasyonu](https://www.eicar.org/download-anti-malware-testfile/).
