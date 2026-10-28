import { EMPLOYEE_BRAND, EMPLOYEE_PAGE_STYLES } from '../ui/employee-page';
/** No domain DTO or user-controlled URL/value is interpolated into this page. */
export const REAUTH_PAGE = `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><title>Güvenli işlem doğrulaması · Mayı Sigorta</title><style>${EMPLOYEE_PAGE_STYLES}</style></head><body><main class="employee-secure employee-secure-auth">${EMPLOYEE_BRAND}<section class="employee-card"><p class="employee-eyebrow">HESAP DOĞRULAMA</p><h1>Devam etmek için şifrenizi tekrar girin</h1><p>Bu işlemi kendi kalıcı şifrenizle doğrulayın. İşlem yetkileriniz ayrıca kontrol edilir.</p><form id="reauth-form"><label>Şifre<input id="reauth-password" type="password" autocomplete="current-password" required autofocus></label><button type="submit">Doğrula</button></form><p id="reauth-result" role="alert" aria-live="polite"></p><p class="employee-return"><a href="/">Çalışma alanına dön</a></p></section></main><script src="/api/auth/reauth.js" defer></script></body></html>`;
export const REAUTH_SCRIPT = `(() => {
'use strict';
const form = document.getElementById('reauth-form');
const password = document.getElementById('reauth-password');
const result = document.getElementById('reauth-result');
if (!form || !password || !result) return;
form.addEventListener('submit', async event => {
  event.preventDefault();
  const button = form.querySelector('button');
  button.disabled = true;
  result.textContent = '';
  try {
    const value = password.value;
    if (value.length > 256 || /[\\uD800-\\uDFFF]/u.test(value)) {
      result.textContent = 'Parola 15–128 Unicode karakteri olmalıdır. Girdi kısaltılmaz.'; return;
    }
    const length = Array.from(value.normalize('NFC')).length;
    if (length < 15 || length > 128) {
      result.textContent = 'Parola 15–128 Unicode karakteri olmalıdır. Girdi kısaltılmaz.'; return;
    }
    const csrfResponse = await fetch('/api/auth/csrf-token', { cache: 'no-store' });
    if (!csrfResponse.ok) { result.textContent = 'Oturum sona erdi. Panele dönüp yeniden giriş yapın.'; return; }
    const csrf = await csrfResponse.json();
    const response = await fetch('/api/auth/reauth', { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf.data.token }, body: JSON.stringify({ password: password.value }) });
    password.value = '';
    if (response.ok) { location.reload(); return; }
    result.textContent = response.status === 429 ? 'Çok fazla deneme. Bir dakika sonra tekrar deneyin.' : 'Şifre doğrulaması başarısız.';
  } catch { result.textContent = 'Doğrulama tamamlanamadı. Tekrar deneyin.'; }
  finally { password.value = ''; button.disabled = false; }
});
})();`;
