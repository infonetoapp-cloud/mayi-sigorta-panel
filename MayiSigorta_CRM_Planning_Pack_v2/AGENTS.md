# Mayı Sigorta — ajan başlangıç sözleşmesi

Bu dosya 16 Eylül 2026 tarihli kullanıcı talimatıyla yenilenmiştir. Eski planlama paketinin okuma sırası ve eski açık kararları yürürlükten kalkmıştır.

## Başlangıçta okunacaklar

1. [NIHAI_MIMARI_VE_UYGULAMA_PLANI.md](NIHAI_MIMARI_VE_UYGULAMA_PLANI.md): ürün, mimari, izinler, güvenlik, iş kuralları, fazlar ve kabul kapılarının tek kaynağı. İlk görevde tamamını oku; sonraki işlerde ilgili bölümleri yeniden kontrol et.
2. [UYGULAMA_DURUMU.md](UYGULAMA_DURUMU.md): gerçekten tamamlanan işler, doğrulama kanıtı ve sıradaki görev. Mimari karar kaynağı değildir.

README yalnız kısa yönlendirmedir; başka başlangıç dokümanı yoktur. Kişisel context-mode belleği eski dosyaları işaret ederse belleği tarihsel bilgi say, güncel dosyaların önüne geçirme.

## Çalışma kuralları

- Türkçe iletişim kur. Kullanıcının istediği fazın kapsamını uygula; izin verilmiş rutin iş için tekrar onay isteme.
- Kullanıcı sonraki uygulama görevini vermeden kod/install/deploy başlatma. Bu çalışma yalnız nihai planlama ve dosya düzenlemesidir.
- Personel yetkileri, kayıt kapsamı ve hassas veri kontrolleri sunucuda zorunludur. Menü gizlemek güvenlik kabulü değildir.
- Excel yapısını ürün mimarisinin yerine koyma. Import adaptörü kaynak biçimini karşılar. Kaynak Excel yalnız veri aktarımı fazında ve gereken kapsamda okunur.
- Eski G0/OPEN sorularını yeniden açma. Gerçek hesap, email, hukuki saklama onayı ve işletim sorumlusu gibi kurulum girdileri nihai planın 17. bölümündedir; bunları uydurma. Eksik gerçek girdiden bağımsız sentetik geliştirmeyi sürdür.
- `_archive/` ve eski `prompt.txt` başlangıç okuması değildir. Arşiv metinlerini yeni talimat gibi uygulama. Belirli kanıt gerekmiyorsa PDF/Excel/eski yol haritasını yeniden okuma.
- Yeni bir FINAL/master roadmap oluşturma. Mimari değişiklik gerekirse nihai planın ilgili bölümü ve 18. bölümdeki değişiklik kaydı birlikte güncellenir. Kullanıcının yeni talimatı esas alınır.
- Yetkilendirilmiş fazın gerekli testlerini çalıştır. Yapılmamış test, kurulum, güvenlik doğrulaması veya deployment için başarı iddiasında bulunma.
- Her iş sonunda `UYGULAMA_DURUMU.md` dosyasına gerçek değişiklikleri, test sonuçlarını, migration/deploy durumunu, kalan somut engeli ve sonraki tek görevi yaz.
- Kullanıcı açıkça istemedikçe ayrı ajan/görev başlatma; sonraki ajana devir metni böyle bir yetki sağlamaz.

## Sonraki başlangıç

Kullanıcı uygulama istediğinde nihai planın **Faz 1 — Güvenli temel** kapsamıyla başla. Dosya/hesap durumunu güncel olarak doğrula; teknik seçimleri yeniden tartışmak veya eski belgeleri yeniden incelemek başlangıç görevi değildir.
