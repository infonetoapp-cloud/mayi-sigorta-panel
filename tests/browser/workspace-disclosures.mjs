// The historical protocol walkthroughs explicitly reveal their action groups.
export async function openWorkspaceSections(page) {
  for (const title of ['Görev işlemleri', 'Teklifler', 'Yenileme sonucu']) {
    const control = page.getByRole('button', { name: title, exact: true });
    if ((await control.count()) && (await control.getAttribute('aria-expanded')) === 'false')
      await control.click();
  }
  const summary = page.locator('details.today-advanced > summary');
  if ((await summary.count()) && !(await summary.evaluate((el) => el.parentElement.open)))
    await summary.click();
}
