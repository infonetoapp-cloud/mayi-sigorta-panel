import type { PolicyDetailDto } from '../../shared/types';
import { EMPLOYEE_BRAND, EMPLOYEE_PAGE_STYLES } from '../ui/employee-page';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function renderPolicyIdentityVariantConfirmation(policy: PolicyDetailDto): string {
  const policyId = escapeHtml(policy.id);
  return `<!doctype html>
<html lang="tr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Farklı sözleşme kaydı · Mayı Sigorta</title>
  <style>
    ${EMPLOYEE_PAGE_STYLES}
  </style>
</head>
<body>
  <main class="employee-secure">
    ${EMPLOYEE_BRAND}
    <section class="employee-card">
    <p class="employee-eyebrow">POLİÇE KAYDI · GÜVENLİ ONAY</p>
    <h1>Aynı numarayla farklı sözleşme</h1>
    <div class="employee-summary"><strong>${escapeHtml(policy.policyNumber)}</strong><p>${escapeHtml(policy.startDate)} – ${escapeHtml(policy.endDate)}</p></div>
    <p>Yalnız aynı numara ve dönem bilgileriyle gerçekten farklı bir sözleşme kaydetmeniz gerekiyorsa kullanın. Yeni dönem veya poliçe yenileme işlemi değildir.</p>
    <form id="secure-confirm-form" data-policy-id="${policyId}" data-expected-version="${policy.version}">
      <label>Gerekçe<textarea id="reason" minlength="3" maxlength="500" required autocomplete="off"></textarea></label>
      <button type="submit">Onayla ve farklı sözleşmeyi kaydet</button>
    </form>
    <div id="result" role="alert" aria-live="polite"></div>
    <p class="employee-return"><a href="/policies/${policyId}">Poliçeye dön</a></p>
    </section>
  </main>
  <script src="/secure/confirm.js" defer></script>
</body>
</html>`;
}

export const SECURE_CONFIRM_SCRIPT = `(() => {
  'use strict';
  const form = document.getElementById('secure-confirm-form');
  const reasonInput = document.getElementById('reason');
  const result = document.getElementById('result');
  const button = form && form.querySelector('button[type="submit"]');
  if (!form || !reasonInput || !result || !button) return;
  let pendingGrant = null;

  const safeMessage = (status, code) => {
    if (code === 'CONFLICT') return 'Poliçe başka bir işlemle güncellendi. Panele dönüp kaydı yeniden açın.';
    if (status === 403) return 'Bu güvenli işlem için yetkiniz veya güncel doğrulamanız bulunmuyor.';
    if (status === 409) return 'İşlem mevcut kayıtla çakıştı. Poliçeyi yeniden kontrol edin.';
    if (status >= 500) return 'Hizmet geçici olarak kullanılamıyor. Daha sonra yeniden deneyin.';
    return 'İşlem tamamlanamadı. Girdileri ve yetkinizi kontrol edin.';
  };

  const readJson = async (response) => {
    try { return await response.json(); } catch { return null; }
  };

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const reason = reasonInput.value.trim();
    if (reason.length < 3) {
      result.textContent = 'Gerekçe en az üç karakter olmalıdır.';
      return;
    }
    button.disabled = true;
    result.className = '';
    result.textContent = 'Güvenli onay hazırlanıyor...';
    let grantIssued = false;
    try {
      const csrfResponse = await fetch('/secure/api/csrf-token', {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      });
      const csrfJson = await readJson(csrfResponse);
      if (!csrfResponse.ok || !csrfJson || !csrfJson.success) {
        result.textContent = safeMessage(csrfResponse.status, csrfJson && csrfJson.error && csrfJson.error.code);
        return;
      }
      const policyId = form.dataset.policyId;
      const expectedVersion = Number(form.dataset.expectedVersion);
      const payload = { expectedVersion, reason };
      const grantBody = JSON.stringify(payload);
      if (!pendingGrant || pendingGrant.body !== grantBody) {
        pendingGrant = { body: grantBody, key: crypto.randomUUID() };
      }
      const grantResponse = await fetch('/secure/api/policies/' + encodeURIComponent(policyId) + '/identity-variant-grants', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': pendingGrant.key,
          'X-CSRF-Token': csrfJson.data.token,
        },
        body: grantBody,
      });
      const grantJson = await readJson(grantResponse);
      if (!grantResponse.ok || !grantJson || !grantJson.success) {
        result.textContent = safeMessage(grantResponse.status, grantJson && grantJson.error && grantJson.error.code);
        return;
      }
      grantIssued = true;
      const commandKey = crypto.randomUUID();
      const commandBody = JSON.stringify({ ...payload, grantEvidenceToken: grantJson.data.grantEvidenceToken });
      const executeCommand = () => fetch('/secure/api/policies/' + encodeURIComponent(policyId) + '/identity-variants', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': commandKey,
          'X-CSRF-Token': csrfJson.data.token,
        },
        body: commandBody,
      });
      let commandResponse;
      try {
        commandResponse = await executeCommand();
      } catch {
        commandResponse = await executeCommand();
      }
      const commandJson = await readJson(commandResponse);
      if (!commandResponse.ok || !commandJson || !commandJson.success) {
        result.textContent = safeMessage(commandResponse.status, commandJson && commandJson.error && commandJson.error.code);
        return;
      }
      reasonInput.value = '';
      form.hidden = true;
      result.className = 'success';
      result.textContent = 'Farklı sözleşme kaydı güvenli onayla oluşturuldu.';
    } catch {
      result.textContent = 'Ağ bağlantısı kesildi. Sonucu panele dönerek kontrol edin; işlemi körlemesine yinelemeyin.';
    } finally {
      button.disabled = grantIssued;
    }
  });
})();`;
