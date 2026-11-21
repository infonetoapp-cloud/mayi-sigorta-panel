const loadCompatibilityPage = () => import('./pages/CompatibilityPage');

export const workspacePageImports = {
  '/': () => import('./pages/OverviewPage'),
  '/today-work': () => import('./pages/today-work/TodayWorkPage'),
  '/customers': () => import('./pages/customers/CustomerListPage'),
  '/renewals': () => import('./pages/renewals/RenewalListPage'),
  '/policies': () => import('./pages/policies/PolicyListPage'),
  '/catalogs': loadCompatibilityPage,
  '/finance': () => import('./pages/finance/FinancePage'),
  '/claims': () => import('./pages/claims/ClaimsPage'),
  '/agency-settings': loadCompatibilityPage,
  '/personnel': () =>
    import('./components/PersonnelPanel').then((module) => ({ default: module.PersonnelPanel })),
};

const warmedPages = new Set<keyof typeof workspacePageImports>();

export function warmWorkspacePage(path: keyof typeof workspacePageImports) {
  if (warmedPages.has(path)) return;
  warmedPages.add(path);
  void workspacePageImports[path]().catch(() => warmedPages.delete(path));
}
