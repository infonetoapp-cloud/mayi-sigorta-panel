// Explicitly launched synthetic localhost harness only; never imported by application runtime.
import assert from 'node:assert/strict';
import process from 'node:process';
import { setInterval, clearInterval } from 'node:timers';
import { URL } from 'node:url';
import { chromium } from 'playwright';
import { openOperationalPreview } from './operational-preview.mjs';

export async function openAutomaticDemo() {
  let preview, browser, timer, closing;
  const pages = [];
  let finish;
  const closed = new Promise((resolve) => {
    finish = resolve;
  });
  async function close() {
    if (closing) return closing;
    closing = (async () => {
      clearInterval(timer);
      try {
        await browser?.close();
      } finally {
        try {
          await preview?.close();
        } finally {
          preview?.passwords.fill('');
          finish();
        }
      }
    })();
    return closing;
  }
  try {
    preview = await openOperationalPreview();
    const origin = new URL(preview.origin);
    assert.equal(origin.protocol, 'https:');
    assert.equal(origin.hostname, 'localhost');
    browser = await chromium.launch({
      headless: false,
      ...(process.platform === 'win32' ? { channel: 'msedge' } : {}),
    });
    for (const [i, user] of preview.users.entries()) {
      const context = await browser.newContext({
        ignoreHTTPSErrors: true,
        viewport: { width: 1280, height: 900 },
      });
      // No trace/video/storageState or persistent browser profile. TLS exception is context-local.
      const page = await context.newPage();
      pages.push(page);
      await page.goto(preview.origin + '/');
      await page.getByLabel('E-posta', { exact: true }).fill(user.email);
      await page.getByLabel('Şifre', { exact: true }).fill(preview.passwords[i]);
      await page.getByRole('button', { name: 'Giriş Yap', exact: true }).click();
      await page.getByRole('heading', { name: 'Genel Bakış', exact: true }).waitFor();
    }
    let filling = false;
    timer = setInterval(async () => {
      if (filling || closing) return;
      filling = true;
      try {
        for (const [i, page] of pages.entries()) {
          if (page.isClosed() || new URL(page.url()).origin !== preview.origin) continue;
          // Fill only the genuine own-password dialog, never confirmation/submit controls.
          const input = page
            .getByRole('dialog', { name: 'Devam etmek için şifrenizi tekrar girin', exact: true })
            .getByLabel('Şifre', { exact: true });
          if ((await input.isVisible()) && (await input.inputValue()) === '')
            await input.fill(preview.passwords[i], { timeout: 1000 });
        }
      } catch {
        /* A closed/navigating page is not a reason to submit or disclose credentials. */
      } finally {
        filling = false;
      }
    }, 250);
    for (const page of pages)
      page.on('close', () => {
        if (pages.every((p) => p.isClosed())) void close();
      });
    browser.on('disconnected', () => {
      void close();
    });
    await pages[0].bringToFront();
    return { origin: preview.origin, pages, db: preview.demo.db, close, closed };
  } catch (error) {
    await close();
    throw error;
  }
}
