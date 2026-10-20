# Phase1 — exact Today Work dönüşü ve not güvenliği entegrasyonu

20 Ekim2026 · accepted baseline `8ff3d2240893c2d109187fdfb81943e1ab5414c4` · yalnız kullanıcı yetkili dar yerel uygulama. Araştırma tekrarlanmadı; B tabanlı kontrollü hibrit kararı bu fazda yalnız navigation/draft integrity olarak uygulanır. Policy summary, görsel redesign, palette, feature enablement veya production yok.

## Kapsam ve iki bağımsız değişiklik

1. Not taslağı: `FRONTEND_PHASE1_NOTE_DRAFT_SAFETY.md`; bağımsız4-file source/test tree,26/26UI ve tsc doğrulaması. Yeni form motoru/autosave yok.
2. Task context: mevcut Bugünkü İşler'den associated customer/policy'ye çıkış ve exact Task'a dönüş. Dar server GET, current authority ve navigasyon metadata'sı; eski finansal controller'lar aynı.

## Önce / sonra

Önceki gerçek araştırmada OWNER/Ahmet/Ayşe1440: Task→customer/policy→Back seçimi kaybettirdi, belge scroll450→0; direct `taskId` query ve refresh seçim sağlamadı. Profil not section değişimi textarea'yı yeniden oluşturdu ve taslağı sildi. Bunlar tarihsel araştırma kanıtıdır, bu fazın yeni testleriyle sayıları toplanmaz.

Yeni Task davranışı: açık Task A seçilince URL yalnız gerekli `task` kimliği ve allowlisted `queue` taşır. İlişkili müşteri/poliçe linkinde authenticated-lifetime memory bookmark alınır. Browser Back veya “Seçili takibe dön” ile fresh yetkili queue + **exact A** GET'i tamamlanır. A yok/kapalı/atanmış başka kişide/yetkisizse generic Türkçe unavailable; Task B otomatik seçilmez. Read503 kalıcı unavailable gibi sunulmaz; exact ID'yi tutan retry vardır. Same-session dönüşünde section açık/kapalı durumu, queue cursor provenance ve scroll bellekte korunur. URL'deki `work` yalnız nonsensitive section hint'i; refresh/direct link bunu kullanabilir.

## Exact read contract

Yeni tek rota:

`GET /api/tasks/:taskId/context?queue=WORK|UNASSIGNED|REASSIGNMENT`

- Mevcut `listTodayTasks`/`loadTaskPage` yetkili query'si exact `t.id=?` predicate'iyle reuse edilir; yeni permission, genel repository veya yazım workflow'u yok.
- Mevcut open primary/renewal/policy/customer lifecycle ve assignment consistency, tenant/custom scope/HEALTH, MEMBER-self ve OWNER queue sınırları aynı.
- Strict query/ID validation, duplicate ve bilinmeyen parametre retleri. Private/no-store. Exact yetkili kaydın mevcut TodayTasks DTO şekli; tüm portföy taraması veya başka Task lookup'u yok.
- Exact SELECT request-bound DB batch'inden geçer; son batch session revocation testinde veri verilmez. Normal today listesi semantiği değiştirilmez.
- Rota yalnız açık context sağlar. Kapalı A'nın yokluğu **işlem başarısı kanıtı değildir**. Restored A için accepted Task completion sonrası context404 olursa fresh authorized queue GET'i display/readback amacıyla kullanılır. Başarıyı mevcut controller'ın exact validated receipt'i kanıtlar; bu helper ne POST üretir ne success uydurur. Karşılaştırma aşamasında A bulunamazsa mutation açılamaz.

## Frontend yaşam döngüsü

- `work-navigation.tsx`: auth lifetime provider; en fazla10 memory entry. DTO, draft, body, key, token veya müşteri adı saklamaz. Logout/unmount/role-key değişiminde context store ayrılır. Persistent browser storage kullanılmaz.
- `TodayWorkPage.tsx`: Task hint, clean departure bookmark, restore selection, scroll ve section hints. Mevcut dirty/pending/uncertain/native POP guard'ı atlanmaz; source selection aynı read authority ile bağlanır.
- `use-task-queue.ts`: en fazla10 önceden yüklenmiş sayfayı fresh GET ile yeniden okur; exact resolver ID'yi doğrular. Search filtresi uydurulmadı: mevcut Today Work'te serbest müşteri araması yok, üç queue görünümü var. Özel cursor provenance memory'de; URL veya storage'a taşınmaz.
- `WorkspaceSection.tsx`: yalnız optional open-change notification. Çocuklar daima mounted ve pinned kapanış kuralı aynı; koşullu sekme unmount'u yok. `work` URL değişikliği React key değildir.
- CustomerProfile/PolicyDetail: gerçek associated record açılır, explicit return linki memory entry'si varsa görünür. Ana section linkleri ve policy→customer linki return metadata'sını korur. Arbitrary return URL/open redirect yok; hedef yerel fixed `/today-work` üreticisidir.
- AuthenticatedApp provider anahtarı mevcut authenticated session lifecycle'ına bağlıdır; server auth otoritesi değişmez.

## Kabul scope'u ve UX-002 izolasyonu

Başlangıç inventory:212 dirty/untracked dosya. Mevcut UX-002 uygulama değişiklikleri:

- RenewalQuotesSection.tsx
- TodayWorkPage.tsx yalnız `today-summary` üzerindeki `tabIndex={-1}` hunk'ı
- today-work.css
- renewal-quotes-modern.ui.test.tsx

Bu faz bu adayın onayı değildir. Quotes/CSS/test dosyaları aynen bırakılır. TodayWorkPage'de yeni navigation hunk'ları eklenir, eski tabIndex hunk'ı çalışma ağacında kalır ancak faz commit'inden **özellikle çıkarılır**.

Doğrulama için ayrı `GIT_INDEX_FILE` ile accepted baseline+exact allowlist'ten generated acceptance tree oluşturuldu; gerçek index boş bırakıldı. Tree export `_archive` içermez. Build, D1/API, UI ve Edge bu **UX-002 dışlanmış** tree üzerinde çalıştırıldı. Not değişikliği ayrıca yalnız4source/test path içeren başka tree'de sınandı. Root dirty kaynaklar üzerinde geçen checkpoint'ler final bağımsız tree kabulünün yerine sayılmadı.

## Gerçek test sonuçları

Makine envanteri `phase1-navigation-evidence/tests-summary.json`:

- İlk birleşik12dosya139PASS: gerçek D1/API Task-context8, customer-notes14, eski renewal-task26; ilgili UI/quote/airiness/new-customer guard testleri. Bir yanlış dosya adı pattern'i hiçbir suite üretmedi;13dosya çalıştı denmez.
- Not-only bağımsız tree:4dosya26PASS. Bu koşu aynı vakaları yeniden içerir,139'a ek başarı diye toplanmaz.
- Son birleşik UI:9dosya204PASS. İletişim23, SENT60, Task ops19, WON30, terminal37, Today18, mounted/pinned5, yeni notes5, yeni navigation7.
- Dosya bazında en yeni sonucu seçip tekrarları ayıklayınca **17dosya310 farklı test PASS;0FAIL/0skip**. Bu bütün repository suite'i değildir. Sonradan değişmeyen API dosyalarının139koşusundaki gerçek sonuçları reuse edilir; her UI düzeltmesinde pahalı backend yeniden koşulmadı.

RED/FAIL tarihçesi:

- Notes DOM identity/draft testi önce1FAIL; ayrı leave guard testi eksik Stay nedeniyle RED; frozen-change testi önce RED, sonra handler lock ile GREEN.
- Exact Task endpoint testi önce404→beklenen200 RED; frontend return testi önce seçili A bulunamadığı için RED. Section hint ve restored accepted-readback ile503exact-retry negatifleri ayrıca RED→GREEN.
- Genişletilen API fixture'ında eksik `completed_by_membership_id` ve geçersiz NONE scope DB CHECK retleri kurulum hatasıydı; gerçek schema kuralları gevşetilmeden fixture düzeltildi. İlk ek testte bir syntax kapanışı da düzeltildi.
- Eski TodayWork remount testi fresh URL task hint'inin başka kullanıcıda generic unavailable mesajını artık doğru biçimde ürettiğini beklemiyordu. Eski veri/late response'ın gizlenmesi assertion'ı korunarak yeni davranışa uyarlandı; permission bypass yapılmadı.
- Typecheck'in bookmark nullability ve RTL option tipi bulguları giderildi. İlk boundary çalışması `window` runtime erişimini reddetti; mevcut global `scrollY/scrollTo` biçimine uyarlandı, sınır kuralı kaldırılmadı.
- İlk background komutları Windows `node` shim'inde `stdin is not a tty` verdi; suite/browser çalışmış sayılmadı. `node.exe` ile gerçek koşular yapıldı.
- İlk Edge scroll beklentisi, Playwright'ın click öncesi kendi otomatik scroll'unu yok sayıyordu. Diagnostic400→0 sayfa/50→50queue kaydı korundu. Scroll kontrolünde gerçek link DOM click ile otomatik pre-scroll olmadan etkinleştirildi; fiziksel insan tıklaması/scroll metriği iddia edilmez. Gerçek pointer click'ler diğer linklerde de sınandı.
- Ek restored Task completion kontrolünün ilk datetime fill'i Edge tarafından Malformed value diye reddedildi. Bu kurulum başarısızlığı önceki dört hücre başarısını genişletmez; kayıt operasyonu gerçekleşmiş sayılmaz.
- Commit öncesi diff-check, ham test/Worker stdout'undaki anlamlı son boşlukları ve boş son satırları reddetti. Loglar kırpılmadı: yeni faz logları özgün byte SHA256'sı ve birebir geri çevrilebilir `utf8` alanıyla `.log.json` zarfına alındı; eski audit veya kaynak loglar değiştirilmedi. Son diff-check bu kayıpsız kanıt biçiminde yeniden geçti.

## Build ve güvenlik kapıları

Typecheck (root ve bağımsız tree), odaklı ESLint/Prettier, client build, Worker **yalnız dry-run**, source/executor sınırları ve yeni client bundle secret taraması, git diff-check çalıştırıldı. `window` ilk boundary FAIL'i ve sonraki PASS ayrıdır. Generated Windows checkout CRLF'leri nedeniyle geçici note-tree format kontrolünde ilk uyarılar oluştu; blob LF/standalone profile formatter kontrolü ayrıca yapıldı. Root dosyalarının final format check'i PASS. Production deployment komutu çalıştırılmadı; Wrangler yalnız `--dry-run`.

## Kalan sınırlar

- Refresh'te Task/queue/son section URL hint'inden fresh authorized read ile dönebilir; memory cursor zinciri, pixel scroll ve private drafts process reload sonrası geri gelmez. Bu bilgileri browser storage'a koymak yerine sınır açık tutulur.
- Same-session restore en fazla10sayfayı yeniden okur. Eski/geçersiz cursor açık liste yenileme ister; tüm portföy taranmaz. Kayıt geometri değişince browser scroll sınırları uygulanır; kayıp kaydın yerine başka ID seçilmez.
- Customer/policy kayıt sayfasının refresh'i memory explicit-return entry'sini kaybedebilir; browser Back'teki Task URL'si exact resolver ile çalışır. Explicit-return bağlantısı memory yoksa uydurulmaz.
- Programatik keyfi route change veya legacy tüm alt form controller'larını tek bir yeni global framework'e taşımak kapsam dışı. Tam profil iletişim/advanced draft migrasyonu yapılmadı. Yeni not guard'ı mevcut click/native POP/beforeunload kalıbını kullanır.
- Full repository suites, fiziksel cihaz/ekran klavyesi, doğal session expiry ve NVDA/complete WCAG matrisi koşulmadı. Gerçek revocation ve tenant/HEALTH retleri yeni yerel API testindedir.
- Documents/R2 kapalı; schema/migration/auth semantics, sidebar/layout/palette, quote association, WON/LOST/VOIDED/CAS/idempotency kuralları değişmez. OPS-001 production kapısı açıktır.

## Exact source/test allowlist

Not değişikliği:

1. src/app/components/CustomerNotesSection.tsx
2. src/app/pages/customers/CustomerNoteWorkspace.tsx
3. src/app/pages/customers/CustomerProfilePage.tsx — yalnız mounted note hunk'ları
4. tests/customer-note-navigation.ui.test.tsx
5. FRONTEND_PHASE1_NOTE_DRAFT_SAFETY.md

Navigation değişikliği:

1. src/app/AuthenticatedApp.tsx
2. src/app/pages/customers/CustomerProfilePage.tsx — yalnız return/state hunk'ları
3. src/app/pages/policies/PolicyDetailPage.tsx
4. src/app/pages/today-work/TodayWorkPage.tsx — UX-002 tabIndex hunk'ı hariç
5. src/app/pages/today-work/WorkspaceSection.tsx
6. src/app/pages/today-work/use-task-queue.ts
7. src/app/pages/today-work/work-navigation.tsx
8. src/server/tasks/routes.ts
9. src/server/tasks/service.ts
10. tests/task-context.api.test.ts
11. tests/task-navigation.ui.test.tsx
12. tests/today-work-modern.ui.test.tsx
13. tests/browser/navigation-integrity.smoke.mjs
14. MayiSigorta_CRM_Planning_Pack_v2/NIHAI_MIMARI_VE_UYGULAMA_PLANI.md — yalnız bu yetkili kaynak sözleşmesi
15. Bu rapor ve yalnız yeni phase1-navigation-evidence dosyaları.

Protected durum/audit/araştırma/UX-002 rapor veya kanıtları allowlist'te değildir.

## Nihai Edge ve yerel karar — LOCAL GO

Görünür Microsoft Edge **155.0.4283.62**, son genişletilmiş sürücü exit0; **OWNER/Ahmet×1440/360 dört hücrenin tamamı PASS**. Ayşe veya768 için bu fazda yeni kabul hücresi iddia edilmez. `edge-results.json` nihai; `edge-results-intermediate.json` daha dar ara koşu, ayrı başarı diye toplamaya katılmaz.3hücreden sonra datetime setup'ta durmuş önceki koşu tamamlanmış4hücre değildir; failure dosyası korunur.

Her nihai hücrede customer Back→exactA/section/scroll, Forward ve explicit return, policy bölümünden explicit return, reload/direct context, note section Back/Forward/Stay/Cancel, native POP ile Task'a çıkışta Stay, pending write ayrılma engeli, POST yanıt kaybı sonrası aynı note body/key ile1DBrow, kapalı A yerine B seçmeme ve boş browser storage doğrulandı. MEMBER'ın iki hücresinde gerçek D1 reassignment sonrası eski kullanıcı A'yı açamadı. Runtime error0.

Masaüstünde ölçülen sayfa/queue scroll **400/50→400/50**;360'ta sayfa400→400, doğal tek-akış queue scroll0→0. Playwright otomatik pre-click scroll'u ölçümü değiştirmesin diye bu özel ölçümde gerçek DOM link click'i kullanıldı; gerçek kullanıcı scroll/hız ölçümü değildir. Diğer navigation kontrolleri normal link/button ve browser history ile sürüldü.

Ahmet360 ek kanıtı: **geri yüklenmiş A** mevcut gerçek Task complete UI'ıyla tamamlandı; kabul edilmiş POST sonrası context GET'e503 enjekte edildi. “Yalnız tamamlama kuyruğunu yeniden oku” GET-only recovery ile current queue döndü, POST sayısı1, yeni açık replacement Task sayısı1 ve ID'siA'dan farklı; B otomatik seçilmedi. Bu dar yeni kanıt tüm finansal rollback matrisinin yerine geçmez.

Yeni hash inventory'de212mevcut dirty/untracked dosyadan211byte-aynı; tek örtüşen TodayWorkPage'de bu fazın eklemeleri var ve özgün UX-002 tabIndex hunk'ı yerinde. Protected SHA256 `f272a14efce57f2ef47d960c2ac387e11cdaeda96aa6fda71db8585844e28930`. Gerçek index staging öncesi boş. Bağımsız acceptance source blob listesi ve yeni evidence manifesti kanıt dizinindedir.

Karar: **not düzeltmesi LOCAL GO; exact Task dönüşü LOCAL GO**. Commit yalnız explicit path/blob allowlist'iyle ve UX-002 focus hunk'ı dışlanarak yapılabilir. Git commit/push'un gerçekten oluştuğu final yanıt ve remote readback ile ayrıca bildirilir; bu metin henüz kendi başına yayın kanıtı değildir. Sonraki ürün fazı, tasarım, policy summaries ve production recovery başlatılmaz.

Bağımsız not commit'i gerçekten oluşturuldu: `642273e7b5ecf285df78f333cd5e00a1b441cab1` — yalnız5allowlisted path; CustomerProfilePage'nin Task-return hunk'ları bu commit'te yoktur. Navigation commit'i bunun üzerine ayrı uygulanır. Push/remote sonuçları final readback ile bildirilir.
