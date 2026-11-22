import { Component, lazy, Suspense, type ReactNode } from 'react';
import { Link, Navigate, Route, Routes, useNavigate } from 'react-router';
import type { AuthSessionDto } from './AuthShell';
import type { TabType } from './App';
import { AppShell } from './components/layout/AppShell';
import { PageHeader } from './components/layout/PageContainer';
import { navigation } from './components/layout/navigation';
import { Button } from './components/ui/button';
import { WorkNavigationProvider } from './pages/today-work/work-navigation';
import { CustomerListContextProvider } from './pages/customers/customer-list-context';
import { workspacePageImports } from './workspace-page-imports';

const CompatibilityPage = lazy(workspacePageImports['/catalogs']);
const OverviewPage = lazy(workspacePageImports['/']);
const CustomerListPage = lazy(workspacePageImports['/customers']);
const CustomerProfilePage = lazy(() => import('./pages/customers/CustomerProfilePage'));
const CustomerCreatePage = lazy(() => import('./pages/customers/CustomerCreatePage'));
const PolicyListPage = lazy(workspacePageImports['/policies']);
const PolicyDetailPage = lazy(() => import('./pages/policies/PolicyDetailPage'));
const PolicyLegacyPage = lazy(() => import('./pages/policies/PolicyLegacyPage'));
const PolicyFormPage = lazy(() => import('./pages/policies/PolicyFormPage'));
const TodayWorkPage = lazy(workspacePageImports['/today-work']);
const RenewalListPage = lazy(workspacePageImports['/renewals']);
const RenewalDetailPage = lazy(() => import('./pages/renewals/RenewalDetailPage'));
const ClaimsPage = lazy(workspacePageImports['/claims']);
const SalesCasePage = lazy(() => import('./pages/sales/SalesCases'));
const GeneralTaskPage = lazy(() => import('./pages/today-work/GeneralTaskPage'));
const FinancePage = lazy(workspacePageImports['/finance']);
const PersonnelPage = lazy(workspacePageImports['/personnel']);
const OperationsReadinessPage = lazy(() => import('./pages/OperationsReadinessPage'));

class PageBoundary extends Component<
  { children: ReactNode; resetKey: string },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidUpdate(previous: Readonly<{ children: ReactNode; resetKey: string }>) {
    if (previous.resetKey !== this.props.resetKey && this.state.failed)
      this.setState({ failed: false });
  }
  render() {
    return this.state.failed ? (
      <section role="alert">
        <h1>Sayfa yüklenemedi</h1>
        <p>Bağlantınızı kontrol edip sayfayı yeniden yükleyin.</p>
        <Button asChild>
          <a href="">Yeniden yükle</a>
        </Button>
      </section>
    ) : (
      this.props.children
    );
  }
}
function DeniedPage() {
  return (
    <>
      <PageHeader
        title="Bu sayfaya erişiminiz yok"
        description="Bu bölüm yalnız acente sahibi tarafından kullanılabilir."
      />
      <Button asChild variant="outline">
        <Link to="/">Genel Bakış'a dön</Link>
      </Button>
    </>
  );
}
function PasswordPage({ renderPassword }: { renderPassword: (done: () => void) => ReactNode }) {
  const navigate = useNavigate();
  return (
    <>
      {renderPassword(() => {
        void navigate('/');
      })}
    </>
  );
}
export function AuthenticatedApp({
  session,
  busy,
  onLogout,
  onReauth,
  renderPassword,
  error,
  reauth,
}: {
  session: AuthSessionDto;
  busy: boolean;
  onLogout: () => void;
  onReauth: () => void;
  renderPassword: (done: () => void) => ReactNode;
  error: string;
  reauth: ReactNode;
}) {
  return (
    <WorkNavigationProvider key={`${session.email}:${session.isOwner}`}>
      <CustomerListContextProvider>
        <AppShell session={session} busy={busy} onLogout={onLogout} onReauth={onReauth}>
          {error && <p role="alert">{error}</p>}
          {reauth}
          <Routes>
            <Route
              path="/tasks/:taskId"
              element={
                <PageBoundary resetKey="general-task">
                  <Suspense fallback={<p role="status">Takip yükleniyor…</p>}>
                    <GeneralTaskPage />
                  </Suspense>
                </PageBoundary>
              }
            />
            <Route
              path="/sales-cases/:caseId"
              element={
                <PageBoundary resetKey="sales-case">
                  <Suspense fallback={<p role="status">Çalışma yükleniyor…</p>}>
                    <SalesCasePage />
                  </Suspense>
                </PageBoundary>
              }
            />
            <Route
              path="/claims"
              element={
                <PageBoundary resetKey="claims">
                  <Suspense fallback={<p role="status">Hasar dosyaları yükleniyor…</p>}>
                    <ClaimsPage />
                  </Suspense>
                </PageBoundary>
              }
            />
            <Route
              path="/finance"
              element={
                <PageBoundary resetKey="finance">
                  <Suspense fallback={<p role="status">Muhasebe yükleniyor…</p>}>
                    <FinancePage />
                  </Suspense>
                </PageBoundary>
              }
            />
            <Route
              path="/"
              element={
                <>
                  <PageHeader title="Genel Bakış" />
                  <PageBoundary resetKey="overview">
                    <Suspense fallback={<p role="status">Genel bakış yükleniyor…</p>}>
                      <OverviewPage owner={session.isOwner} />
                    </Suspense>
                  </PageBoundary>
                </>
              }
            />
            <Route
              path="/today-work"
              element={
                <PageBoundary resetKey="today-work">
                  <Suspense fallback={<p role="status">Sayfa yükleniyor…</p>}>
                    <TodayWorkPage
                      key={`${session.email}:${session.isOwner}`}
                      owner={session.isOwner}
                    />
                  </Suspense>
                </PageBoundary>
              }
            />
            <Route path="/today-work/legacy" element={<Navigate to="/today-work" replace />} />
            <Route
              path="/renewals"
              element={
                <PageBoundary resetKey="renewals">
                  <Suspense fallback={<p role="status">Sayfa yükleniyor…</p>}>
                    <RenewalListPage />
                  </Suspense>
                </PageBoundary>
              }
            />
            <Route
              path="/renewals/:renewalId"
              element={
                <PageBoundary resetKey="renewal-detail">
                  <Suspense fallback={<p role="status">Sayfa yükleniyor…</p>}>
                    <RenewalDetailPage />
                  </Suspense>
                </PageBoundary>
              }
            />
            <Route
              path="/customers"
              element={
                <PageBoundary resetKey="customers">
                  <Suspense fallback={<p role="status">Sayfa yükleniyor…</p>}>
                    <CustomerListPage />
                  </Suspense>
                </PageBoundary>
              }
            />
            <Route
              path="/customers/:customerId"
              element={
                <PageBoundary resetKey="customer-profile">
                  <Suspense fallback={<p role="status">Sayfa yükleniyor…</p>}>
                    <CustomerProfilePage />
                  </Suspense>
                </PageBoundary>
              }
            />
            <Route
              path="/customers/new"
              element={
                <PageBoundary resetKey="customer-create">
                  <Suspense fallback={<p role="status">Sayfa yükleniyor…</p>}>
                    <CustomerCreatePage />
                  </Suspense>
                </PageBoundary>
              }
            />
            {(['legacy', 'advanced'] as const).map((mode) => (
              <Route
                key={mode}
                path={
                  mode === 'advanced' ? '/customers/:customerId/advanced' : `/customers/${mode}`
                }
                element={
                  mode === 'advanced' ? (
                    <PageBoundary resetKey="customer-management">
                      <Suspense fallback={<p role="status">Müşteri yükleniyor…</p>}>
                        <CustomerProfilePage />
                      </Suspense>
                    </PageBoundary>
                  ) : (
                    <>
                      <PageHeader title="Müşteri işlemleri" />
                      <PageBoundary resetKey={`customer-${mode}`}>
                        <Suspense fallback={<p role="status">Sayfa yükleniyor…</p>}>
                          <CompatibilityPage page="customers" customerMode={mode} />
                        </Suspense>
                      </PageBoundary>
                    </>
                  )
                }
              />
            ))}
            {[
              { path: '/policies', page: <PolicyListPage /> },
              { path: '/policies/legacy', page: <PolicyLegacyPage /> },
              { path: '/policies/new', page: <PolicyFormPage /> },
              { path: '/policies/:policyId/edit', page: <PolicyFormPage /> },
              { path: '/policies/:policyId', page: <PolicyDetailPage /> },
            ].map(({ path, page }) => (
              <Route
                key={path}
                path={path}
                element={
                  <PageBoundary resetKey={path}>
                    <Suspense fallback={<p role="status">Sayfa yükleniyor…</p>}>{page}</Suspense>
                  </PageBoundary>
                }
              />
            ))}
            {navigation
              .filter(
                (item) =>
                  item.path !== '/' &&
                  item.path !== '/customers' &&
                  item.path !== '/policies' &&
                  item.path !== '/today-work',
              )
              .map((item) => (
                <Route
                  key={item.path}
                  path={item.path}
                  element={
                    item.ownerOnly && !session.isOwner ? (
                      <DeniedPage />
                    ) : (
                      <>
                        <PageHeader title={item.label} description={item.description} />
                        <PageBoundary resetKey={item.path}>
                          <Suspense fallback={<p role="status">Sayfa yükleniyor…</p>}>
                            {item.path === '/personnel' ? (
                              <PersonnelPage />
                            ) : (
                              <CompatibilityPage page={item.path.slice(1) as TabType} />
                            )}
                          </Suspense>
                        </PageBoundary>
                      </>
                    )
                  }
                />
              ))}
            <Route
              path="/ops/readiness"
              element={
                session.isOwner ? (
                  <PageBoundary resetKey="operations-readiness">
                    <Suspense fallback={<p role="status">İşletim durumu yükleniyor…</p>}>
                      <OperationsReadinessPage />
                    </Suspense>
                  </PageBoundary>
                ) : (
                  <DeniedPage />
                )
              }
            />
            <Route
              path="/account/password"
              element={<PasswordPage renderPassword={renderPassword} />}
            />
            <Route
              path="*"
              element={
                <>
                  <PageHeader
                    title="Sayfa bulunamadı"
                    description="Bu bağlantı artık geçerli olmayabilir."
                  />
                  <Button asChild variant="outline">
                    <Link to="/">Genel Bakış'a dön</Link>
                  </Button>
                </>
              }
            />
          </Routes>
        </AppShell>
      </CustomerListContextProvider>
    </WorkNavigationProvider>
  );
}
