/** No domain DTO or user-controlled URL/value is interpolated into this public script/page. */
export const REAUTH_PAGE = `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><title>Güvenli işlem doğrulaması</title><style>body{font-family:system-ui;background:#f1f5f9;color:#0f172a;padding:2rem}main{max-width:30rem;margin:auto;background:white;padding:2rem;border-radius:1rem}label{display:grid;gap:.5rem}input,button{padding:.75rem;margin:.75rem 0}button{background:#2563eb;color:white;border:0;border-radius:.5rem}</style></head><body><main><h1>Devam etmek için şifrenizi tekrar girin</h1><p>Kendi kalıcı şifrenizle doğrulayın. Normal çalışma alanı ek doğrulama istemez.</p><form id="reauth-form"><label>Şifre<input id="reauth-password" type="password" autocomplete="current-password" required autofocus></label><button type="submit">Doğrula</button></form><p id="reauth-result" role="alert"></p><a href="/">Panele dön</a></main><script src="/api/auth/reauth.js" defer></script></body></html>`;
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
