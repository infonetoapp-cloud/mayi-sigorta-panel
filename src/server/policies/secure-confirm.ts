import type { PolicyDetailDto } from '../../shared/types';

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
  <title>Güvenli poliçe onayı</title>
  <style>
    body{font-family:system-ui,sans-serif;background:#f1f5f9;color:#0f172a;margin:0;padding:2rem}
    main{max-width:42rem;margin:auto;background:#fff;border:1px solid #cbd5e1;border-radius:.75rem;padding:1.5rem}
    label{display:grid;gap:.4rem;margin:1rem 0} textarea{min-height:7rem;padding:.65rem}
    button{border:0;border-radius:.4rem;background:#2563eb;color:#fff;padding:.65rem 1rem;font-weight:700}
    [role=alert]{color:#b91c1c;margin-top:1rem}.success{color:#047857}
  </style>
</head>
<body>
  <main>
    <h1>Güvenli kimlik varyantı onayı</h1>
    <p><strong>${escapeHtml(policy.policyNumber)}</strong> · ${escapeHtml(policy.startDate)} – ${escapeHtml(policy.endDate)}</p>
    <p>Bu işlem yeni dönem veya yenileme oluşturmaz. Yalnız aynı aday kimliğe sahip gerçekten farklı bir sözleşmeyi kaydetmek için kullanın.</p>
    <form id="secure-confirm-form" data-policy-id="${policyId}" data-expected-version="${policy.version}">
      <label>Gerekçe<textarea id="reason" minlength="3" maxlength="500" required autocomplete="off"></textarea></label>
      <button type="submit">Onayla ve kimlik varyantını oluştur</button>
    </form>
    <div id="result" role="alert" aria-live="polite"></div>
    <p><a href="/">Panele dön</a></p>
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
      result.textContent = 'Kimlik varyantı güvenli onayla oluşturuldu.';
    } catch {
      result.textContent = 'Ağ bağlantısı kesildi. Sonucu panele dönerek kontrol edin; işlemi körlemesine yinelemeyin.';
    } finally {
      button.disabled = grantIssued;
    }
  });
})();`;
