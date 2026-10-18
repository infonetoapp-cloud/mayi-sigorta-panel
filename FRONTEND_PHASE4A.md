# FRONTEND PHASE4A — modern Bugünkü İşler kuyruğu

Başlangıç `5c60a219a68350e71b0f3d9073747c69514cee31`. Bu uygulama/kanıt kaydıdır; mimari otorite nihai plan12/18 bölümleridir. Kirli `UYGULAMA_DURUMU.md` aynen korunur/stage edilmez. Production/Cloudflare/migration/Paid/gerçek veri/belge/R2 yetkisi yoktur.

Durum: **PHASE4A LOCAL VERIFIED**. Bu production release veya4B kabulü değildir.

## Dar uygulama sınırı

- `/today-work` modern read-only kuyruk + seçili takip özetidir. Desktop ana içerikte kompakt scrollable liste solda/özet sağda; tablet/mobile tek kolon, açık seçime geçiş ve Görev listesine dön kontrolü vardır. ArrowUp/Down/Home/End satır odağını taşır; native Enter/Space seçer, özet odağı erişilebilirdir. Uzun açılmış mutasyon kartları/modal yoktur.
- Yalnız authorized `TodayTaskDto` alanları gösterilir: ad, başlık, vade, mevcutsa poliçe numarası/bitiş, gerçek yenileme state etiketi ve verilmiş iletişim alanları. Eksik policy metadata uydurulmaz; extra customer/policy/task-detail GET yapılmaz. Seçim yalnız o anda yüklenmiş kuyrukta bulunabilen ID'den türetilir; görev ID/payload URL'ye veya browser storage'a yazılmaz.
- `GET /api/tasks/today?limit=20`: server bucket'ları aynen kullanılır; client takvim-gününden bucket icat etmez. Vade gösterimi API timezone'uyla `tr-TR`, iş günü/now server kaynaklıdır. WORK ve UNASSIGNED cursor/hasMore/cache/failure URL'leri birbirinden ayrıdır; append diğer kuyruğun ilerlemesini sıfırlamaz. Hata retry orijinal URL'yi kullanır; failed base refresh eski next cursor'a dönüşmez. Otomatik bütün portföy indirme yoktur.
- OWNER sunucu `canSeeUnassigned/canSeeReassignment` izniyle Atanmamış/Yeniden atama gerekenler görünümünü açar. `needsReassignment=true` gerçek server sorgusudur; pasif/askıdaki tarihsel ilişki değiştirilmez. MEMBER geniş müşteri/poliçe/task grant'leriyle başka çalışanın özel işini kazanmaz. Client server auth motorunu kopyalamaz veya izin kapsamı üretmez.
- Queue/mode değişimi seçimi temizler; scope değişimi cached sayfaları sıfırlar. Refresh, capability kaybı,401/403/404 ve invalid cursor400/409 eski liste/özet/istatistik alanını kaldırır. Abort+generation geç yanıt/401'i ayırır. Route email+role key'i farklı çalışan/oturum arasında state taşımaz; logout mevcut AuthShell cleanup'ını kullanır.
- Mevcut `TaskStatisticsPanel` ve endpoint yeniden kullanılır; self/team/counts/pagination sözleşmesi değişmez. Canlı401 ve geç401 izolasyonu için mevcut ortak authorized read/abort helper'ına dar network geçişi yapıldı. Sayıların kaynağı server summary'dir, görünen ilk20 satır değildir. Anlık-gecikme ile İstanbul takvim-günü istatistiği ayrımı açıkça anlatılır.
- `/today-work/legacy` mevcut tam `TodayWorkPanel`/`RenewalWorkspacePanel` motorunu erişilebilir tutar. Tamamlama+replacement, task assignment/reassignment, görüşme/geçmiş/phone-email-WhatsApp log, teklif/version/status, WON/LOST/VOIDED ve preview/manual-send/CSRF/CAS/exact retry/idempotency source'u değiştirilmedi. Modern özetten bağlantı genel klasik listeye gider; o görevi otomatik açtığı iddia edilmez.4B/quote redesign başlamadı.
- CSS mevcut entry stylesheet modeliyle `index.html` link'inden, yalnız today sınıflarında yüklenir; verifier gevşetilmez. Sidebar klasik alt rota için de aktif kalır. Backend/shared DTO/schema/dependency/config veya domain iş kuralı değişmedi; ajan delegasyonu yapılmadı.

## Gerçek local D1/API

`tests/today-work-modern.api.test.ts`6/6 PASS: canonical session/CSRF/policy-create/renewal generation kullanır, database authority mock'u yoktur.

- Aynı shared customer'a bağlı Ahmet/Ayşe listeleri üçer kendi işini verir; broad legacy AGENCY grants özel listeyi genişletmez.
- 00:30 İstanbul'da 00:10 vadeli görev listede OVERDUE iken gün istatistiğinde dueToday'dır; takvim summary0/2/1 ve anlık OVERDUE/TODAY/UPCOMING ayrı doğrulanır.
- Owner WORK/UNASSIGNED limit1 bağımsız cursor'ları; yanlış queue/member cursor reddi; suspended ve sonrasında INACTIVE assignee `needsReassignment=true` owner history ve MEMBER403. Geçiş sonrasında aynı taskId/assignee/taskVersion korunur, otomatik atama yoktur.
- Foreign agency boş kendi sonucu, HEALTH non-disclosure, MEMBER team-statistics403 ve statistics cevabında customer/policy/private payload yokluğu. Revoked tasks/statistics401, data yok.
- Mevcut `task-statistics.api`21/21 ayrıca gerçek OWNER completion/completed_by ve replacement/assignment iş yükü ayrımını doğrular.

## Kabul kayıtları

- Konsolide odaklı komut11 dosya117 senaryo: today-work-modern API/UI, task-statistics API/UI, today-work.m3-t02 UI, task-reassignment UI, renewal-workspace.m3 UI, renewal-quotes UI, renewal-interaction-history UI, renewal-completion UI, app-shell UI; `--maxWorkers=1`.
- İlk konsolide koşu **116 PASS / 1 FAIL**: eski task-statistics gerçek completion fixture'ında zaman sırası500. Değişmeyen diğer10 dosya geçti; yalnız etkilenen statistics API dosyası düzeltmeden sonra **21/21 PASS** yeniden çalıştırıldı. Bu sonuçlar tek bir yeniden çalıştırılmış117/117 log'u gibi sunulmaz; ilk failure korunur.
- INACTIVE history assertion'ı tamamlandıktan sonra son etkilenen gate: today-work-modern API/UI + task-statistics UI + app-shell UI, **4 dosya37/37 PASS**; typecheck/lint tekrar PASS. Önceki geçerli değişmeyen legacy/istatistik API kapıları gereksiz tekrarlanmadı.
- Modern UI: selection/DTO-only reads; iki cursor+exact failure retry;400/401/403/404/409 cleanup; queue/reassignment switch; late page401; failed base refresh; keyboard/focus; gerçek AuthenticatedApp employee transition ve legacy sidebar; server statistical totals/self-only; live/late statistics401.
- Typecheck/lint/client+Worker dry-run/security boundaries PASS. Wrangler'ın mevcut environment seçimi uyarısı sürer; deploy/config değişikliği ve document activation yoktur.
- Gerçek Edge `node tests/browser/today-work.smoke.mjs`, tracked süreç `proc_52d4d5e98551`: **exit0/PASS**. Canonical disposable D1/HTTPS/login ile OWNER/Ahmet/Ayşe;1440/768/360; split/single-column/keyboard; bounded WORK ve UNASSIGNED pages ve exact failed-page retry; selected DTO/timezone; server self/team summary karşılaştırması; genel legacy rota ve completion/replacement/assignment/quote-version kontrolleri; refresh/back-forward; revoked session sonrası liste/özet kaldırılması; runtime/CSP hatası yok. Hiçbir WhatsApp/email gönderilmedi, production ortamına gidilmedi.

## Korunan RED ve dar düzeltmeler

- Önce yeni UI import RED üretildi. Mevcut statistics panelinin current401'i session-ended üretmediği testte RED oldu; ortak read/abort helper ile GREEN, late statistics401 etkisizdir. Invalid cursor400/409'da seçili eski data kaldığını gösteren RED cleanup ile GREEN yapıldı.
- Yeni API fixture'ında seed'in temporary/agency argüman sırası, insurers table adı ve payment-method default'u gerçek kontrata uyarlandı; constraints veya middleware gevşetilmedi. Raw due_at canonical `.000Z` olmalıdır; geçersiz fixture fail-closed503 verdi ve düzeltildi. Unassigned task+renewal assignee eşliği korunur; poliçe sorumlusu null yapılmaz.
- Eski statistics fixture'ında JS Date17 Ekim'e sabitken SQLite CURRENT_TIMESTAMP gerçek zamandadır. Completion updated_at fake now ile created_at'ın gerisine düşüp tasks/renewal timestamps_ordered CHECK'ini tetikliyordu. Raw fixture created_at/updated_at açıkça aynı sabit saate bağlandı; backend/trigger değiştirilmedi.21/21 yeniden doğrulandı.
- İlk component CSS import'u kaynak boundary verifier tarafından reddedildi; mevcut HTML stylesheet entry modeline taşındı, verifier değişmeden PASS oldu.
- İlk Edge legacy kontrolü boş yeni teklif formu arıyordu; demo mevcut DRAFT içerdiğinden gerçek Yeni teklif sürümü oluştur kontrolüyle locator düzeltildi. Bu test varsayımı/locator hatasıdır; quote motoru değiştirilmedi.
- Edge retry testinde error banner'ın kaldırılması yeni sayfanın tamamen geldiği anlamına gelmiyordu; gerçekten eklenen satırlar beklenerek assertion düzeltildi. Ayrıca üreticinin hafta sonu ilk takibi sonraki iş gününe koyması korunur: bugünün counter'ını zorlamak yerine dört gerçek server sayacı birebir karşılaştırılır ve server açık iş toplamının ilk20 sayfayı aştığı doğrulanır. Üretici/istatistik davranışı değiştirilmedi; önceki başarısız turlar PASS sayılmadı.
