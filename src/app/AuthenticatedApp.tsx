import { Component, lazy, Suspense, type ReactNode } from 'react';
import { Link, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router';
import type { AuthSessionDto } from './AuthShell';
import { modernCompatibilityTarget } from './pages/modern-compatibility';
import { AppShell } from './components/layout/AppShell';
import { PageHeader } from './components/layout/PageContainer';
import { navigation } from './components/layout/navigation';
import { Button } from './components/ui/button';
import OverviewPage from './pages/OverviewPage';
import { WorkNavigationProvider } from './pages/today-work/work-navigation';
import { CustomerListContextProvider } from './pages/customers/customer-list-context';
const IdentitySearchPage = lazy(() => import('./pages/customers/IdentitySearchPage'));
const CustomerListPage = lazy(() => import('./pages/customers/CustomerListPage'));
const CustomerProfilePage = lazy(() => import('./pages/customers/CustomerProfilePage'));
const CustomerCreatePage = lazy(() => import('./pages/customers/CustomerCreatePage'));
const CustomerManagementPage = lazy(() => import('./pages/customers/CustomerManagementPage'));
const PolicyListPage = lazy(() => import('./pages/policies/PolicyListPage'));
const PolicyDetailPage = lazy(() => import('./pages/policies/PolicyDetailPage'));

const PolicyFormPage = lazy(() => import('./pages/policies/PolicyFormPage'));
const TodayWorkPage = lazy(() => import('./pages/today-work/TodayWorkPage'));
const CatalogPage = lazy(() =>
  import('./components/CatalogsPanel').then((module) => ({ default: module.CatalogsPanel })),
);
const SettingsPage = lazy(() =>
  import('./components/AgencySettingsWorkspace').then((module) => ({
    default: module.AgencySettingsPanel,
  })),
);
const PersonnelPage = lazy(() =>
  import('./components/PersonnelPanel').then((module) => ({ default: module.PersonnelPanel })),
);

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
function CompatibleLink({ kind }: { kind: 'customers' | 'policies' | 'today-work' }) {
  const location = useLocation();
  const target = modernCompatibilityTarget(kind, location.search);
  return target ? (
    <Navigate to={target} replace state={location.state} />
  ) : (
    <>
      <PageHeader
        title="Bağlantının işlem hedefi belirsiz"
        description="Müşteri veya poliçe kaydını yeniden açın; başka bir kayıt otomatik seçilmedi."
      />
      <Button asChild>
        <Link to="/policies">Poliçe portföyüne dön</Link>
      </Button>
    </>
  );
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
            <Route path="/" element={<OverviewPage owner={session.isOwner} />} />
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
            <Route path="/today-work/legacy" element={<CompatibleLink kind="today-work" />} />
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
            <Route path="/customers/legacy" element={<CompatibleLink kind="customers" />} />
            <Route
              path="/customers/search-identity"
              element={
                <Suspense fallback={<p role="status">Sayfa yükleniyor…</p>}>
                  <IdentitySearchPage />
                </Suspense>
              }
            />
            {(['manage', 'advanced'] as const).map((mode) => (
              <Route
                key={mode}
                path={`/customers/:customerId/${mode}`}
                element={
                  <PageBoundary resetKey={`customer-${mode}`}>
                    <Suspense fallback={<p role="status">Sayfa yükleniyor…</p>}>
                      <CustomerManagementPage />
                    </Suspense>
                  </PageBoundary>
                }
              />
            ))}
            {[
              { path: '/policies', page: <PolicyListPage /> },
              { path: '/policies/legacy', page: <CompatibleLink kind="policies" /> },
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
                        {item.path !== '/personnel' &&
                          item.path !== '/catalogs' &&
                          item.path !== '/agency-settings' && (
                            <PageHeader title={item.label} description={item.description} />
                          )}
                        <PageBoundary resetKey={item.path}>
                          <Suspense fallback={<p role="status">Sayfa yükleniyor…</p>}>
                            {item.path === '/personnel' ? (
                              <PersonnelPage />
                            ) : item.path === '/catalogs' ? (
                              <CatalogPage />
                            ) : item.path === '/agency-settings' ? (
                              <SettingsPage key={`${session.email}:${session.isOwner}`} />
                            ) : (
                              <DeniedPage />
                            )}
                          </Suspense>
                        </PageBoundary>
                      </>
                    )
                  }
                />
              ))}
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
