# Mayı Sigorta CRM

**Tek güncel plan:** [NIHAI_MIMARI_VE_UYGULAMA_PLANI.md](NIHAI_MIMARI_VE_UYGULAMA_PLANI.md).

Plan; kişi bazlı personel izinlerini, Cloudflare mimarisini, veri modelini, yenileme ve görev kurallarını, belge güvenliğini, rapor formüllerini, yedeklemeyi ve yedi uygulama fazının kabul ölçütlerini içerir. Mimari seçenekler karara bağlanmıştır. Gerçek hesap ve hukuki onay bilgileri kurulum girdisi olarak ayrıca belirtilmiştir.

- **Yeni ajan:** [AGENTS.md](AGENTS.md) → nihai plan → [UYGULAMA_DURUMU.md](UYGULAMA_DURUMU.md).
- **Mevcut durum:** M1–M3 tamamlandı. M4 eski local/deterministic ve yönetici MFA checkpoint'leri korunur; güncel çalışan-only belge güvenliği F-26 ile ileri yönlü superseded'dır. `M4 COMPLETE=false`, `DOCUMENTS_ENABLED=false`; M5 başlamadı. Güncel test/review/provisioning kanıtı durum dosyasındadır.
- **Sonraki görev:** F-26 Phase 1 PASS/published; boş EU D1 ve paused generic Queue read-proven. R2 Dashboard checkout/usage-billing için insan aksiyonu bekliyor; private EU bucket ve dış M4 kapıları henüz tamamlanmadı. [Foundation kanıtı](M4_FREE_FOUNDATION_EVIDENCE.md), [karar/supersession kaydı](M4_INTERNAL_DOCUMENT_SECURITY_DECISION.md). ClamAV/Containers ve scanner-specific 14-gün Queue hold production gereksinimi değildir.

Önceki 22 dosya içerikleri korunarak proje dışındaki arşiv klasörüne taşındı. [Arşiv bilgisi](../_archive/MayiSigorta_Planning_2026-09-16/ARSIV_BILGISI.md) yalnız tarihsel ihtiyaç içindir; normal başlangıç okumasına dahil değildir.
