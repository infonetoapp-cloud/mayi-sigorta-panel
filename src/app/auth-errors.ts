const MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  LOGIN_FAILED: 'E-posta veya şifre hatalı.',
  RATE_LIMITED: 'Çok fazla deneme. Bir dakika sonra tekrar deneyin.',
  REAUTH_FAILED: 'Şifre doğrulaması başarısız.',
  CURRENT_PASSWORD_FAILED: 'Mevcut şifre hatalı.',
  PASSWORD_POLICY: 'Parola 15–128 karakter olmalı ve kolay tahmin edilmemelidir.',
  PASSWORD_CONFIRMATION: 'Yeni şifreler eşleşmiyor.',
  PASSWORD_UNCHANGED: 'Farklı bir yeni şifre seçin.',
  UNAUTHORIZED: 'Oturumunuz sona erdi. Yeniden giriş yapın.',
  OWNER_REQUIRED: 'Bu işlem yalnız acente sahibine açıktır.',
  INVALID_GRANTS:
    'Seçili izinler birbiriyle uyumlu değil. İzin kapsamlarını ve gerekli okuma izinlerini kontrol edin.',
  CONFLICT:
    'Personel bilgileri veya yetkileri değişti. Güncel kaydı inceleyip değişiklikleri tekrar onaylayın.',
  ONE_TIME_RESPONSE_UNAVAILABLE:
    'İşlem daha önce tamamlandı. Geçici şifre tekrar gösterilemez; yeni onayla sıfırlayın.',
});
/** Never reflect a proxy/server raw diagnostic into security-sensitive UI. */
export function authErrorMessage(code: unknown, status: number): string {
  if (typeof code === 'string' && Object.hasOwn(MESSAGES, code)) return MESSAGES[code]!;
  if (status === 429) return MESSAGES.RATE_LIMITED!;
  if (status === 401) return MESSAGES.UNAUTHORIZED!;
  if (status === 403) return 'Bu işlem için yetkiniz veya güncel doğrulamanız bulunmuyor.';
  if (status >= 500) return 'Hizmet geçici olarak kullanılamıyor. Tekrar deneyin.';
  return 'İşlem tamamlanamadı. Girdileri ve yetkinizi kontrol edin.';
}
