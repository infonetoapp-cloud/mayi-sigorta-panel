import { Component, lazy, Suspense, type ReactNode } from 'react';
import { Link, Route, Routes, useNavigate } from 'react-router';
import type { AuthSessionDto } from './AuthShell';
import type { TabType } from './App';
import { AppShell } from './components/layout/AppShell';
import { PageHeader } from './components/layout/PageContainer';
import { navigation } from './components/layout/navigation';
import { Button } from './components/ui/button';
import OverviewPage from './pages/OverviewPage';
const CompatibilityPage = lazy(() => import('./pages/CompatibilityPage'));
const CustomerListPage = lazy(() => import('./pages/customers/CustomerListPage'));
const CustomerProfilePage = lazy(() => import('./pages/customers/CustomerProfilePage'));
const CustomerCreatePage = lazy(() => import('./pages/customers/CustomerCreatePage'));
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
    <AppShell session={session} busy={busy} onLogout={onLogout} onReauth={onReauth}>
      {error && <p role="alert">{error}</p>}
      {reauth}
      <Routes>
        <Route path="/" element={<OverviewPage owner={session.isOwner} />} />
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
            path={mode === 'advanced' ? '/customers/:customerId/advanced' : `/customers/${mode}`}
            element={
              <>
                <PageHeader title="Müşteri işlemleri" />
                <PageBoundary resetKey={`customer-${mode}`}>
                  <Suspense fallback={<p role="status">Sayfa yükleniyor…</p>}>
                    <CompatibilityPage page="customers" customerMode={mode} />
                  </Suspense>
                </PageBoundary>
              </>
            }
          />
        ))}
        {navigation
          .filter((item) => item.path !== '/' && item.path !== '/customers')
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
  );
}
