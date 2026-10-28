import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router';
import { ArrowUpRight, CalendarClock, MessageSquare, ReceiptText } from 'lucide-react';
import type { PolicyDetailDto, TodayTaskDto } from '../../../shared/types';
import { useCustomerResource, readCustomerResource } from '../customers/customer-resource';
import { RenewalInteractionsSection } from '../today-work/RenewalInteractionsSection';
import { RenewalQuotesSection } from '../today-work/RenewalQuotesSection';
import type { InteractionRisk } from '../today-work/interaction-model';
import { Button } from '../../components/ui/button';
import { PolicyNavigationGuard, type PortfolioRisk } from './PolicyNavigationGuard';
import { PolicyReadNotice, policyDate } from './policy-display';
interface Renewal {
  id: string;
  policyId: string;
  policyNumber: string;
  policyEndDate: string;
  state: string;
  version: number;
}
interface RenewalPage {
  items: Renewal[];
  nextCursor: string | null;
}
const labels: Record<string, string> = {
  CONTACT_PENDING: 'İletişim bekleniyor',
  CONTACTED: 'Görüşüldü',
  QUOTE_PREPARING: 'Teklif hazırlanıyor',
  QUOTE_SENT: 'Teklif gönderildi',
  AWAITING_RESPONSE: 'Yanıt bekleniyor',
  WON: 'Yenilendi',
  LOST: 'Yenilenmedi',
  VOIDED: 'Geçersiz',
};
export function PolicyRenewalWorkspace({ policy }: { policy: PolicyDetailDto }) {
  const [params, setParams] = useSearchParams();
  const [bookmark] = useState(() => params.get('renewal'));
  const restored = useRef(false);
  const [cursor, setCursor] = useState<string | null>(() => params.get('renewalAfter'));
  const [selected, setSelected] = useState<Renewal | null>(null);
  const [tab, setTab] = useState('quotes');
  const [revision, setRevision] = useState(0);
  const [contextReady, setContextReady] = useState(false);
  const [contextError, setContextError] = useState('');
  const risks = useRef<Record<string, PortfolioRisk>>({});
  const risk = useCallback((key: string, value: PortfolioRisk) => {
    const old = risks.current[key];
    if (old?.dirty === value.dirty && old.unresolved === value.unresolved) return;
    risks.current[key] = value;
    setRevision((r) => r + 1);
  }, []);
  const quoteRisk = useCallback((r: PortfolioRisk) => risk('quote', r), [risk]);
  const interactionRisk = useCallback(
    (r: InteractionRisk) =>
      risk('interaction', {
        dirty: r === 'draft',
        unresolved: r === 'uncertain' || r === 'saved-unread',
      }),
    [risk],
  );
  const anyRisk = () => Object.values(risks.current).some((r) => r.dirty || r.unresolved);
  const route = useLocation();
  const url = `/api/customers/${encodeURIComponent(policy.customer.id)}/renewals`;
  const resource = useCustomerResource<RenewalPage>(
    url + '?includePolicyId=true' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''),
  );
  const exact = resource.data?.items.filter((r) => r.policyId === policy.id) ?? [];
  const selectedId = selected?.id;
  useEffect(() => {
    if (!selectedId || Object.values(risks.current).some((r) => r.dirty || r.unresolved)) return;
    const controller = new AbortController();
    let live = true;
    setContextReady(false);
    void readCustomerResource<RenewalPage>(
      url + '?includePolicyId=true' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''),
      controller.signal,
    )
      .then((current) => {
        if (!live) return;
        const fresh = current.items.find((r) => r.id === selectedId && r.policyId === policy.id);
        if (!fresh) throw new Error('TARGET_UNAVAILABLE');
        setSelected(fresh);
        setContextError('');
        setContextReady(true);
      })
      .catch(() => {
        if (live)
          setContextError(
            'Yenilemenin güncel durumu doğrulanamadı. Yeni teklif işlemleri açılmaz; kaydı yeniden yükleyin.',
          );
      });
    return () => {
      live = false;
      controller.abort();
    };
  }, [selectedId, revision, url, cursor, policy.id]);
  useEffect(() => {
    if (restored.current || !resource.data) return;
    restored.current = true;
    // Restore only the bookmarked exact identity after a fresh authorized read.
    if (bookmark) {
      const found = resource.data.items.find((r) => r.id === bookmark && r.policyId === policy.id);
      if (found) setSelected(found);
    }
  }, [resource.data, bookmark, policy.id]);
  const choose = (renewal: Renewal | null) => {
    if (anyRisk()) return;
    restored.current = true;
    setSelected(renewal);
    const next = new URLSearchParams(params);
    if (renewal) next.set('renewal', renewal.id);
    else next.delete('renewal');
    if (cursor) next.set('renewalAfter', cursor);
    else next.delete('renewalAfter');
    setParams(next, { replace: true, state: route.state });
  };
  const compare = useCallback(
    async (signal: AbortSignal) => {
      const current = await readCustomerResource<RenewalPage>(
        url + '?includePolicyId=true' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''),
        signal,
      );
      const match = current.items.find((r) => r.id === selected?.id && r.policyId === policy.id);
      if (!match) return null;
      setSelected(match);
      return match.version;
    },
    [url, cursor, selected?.id, policy.id],
  );
  const open =
    contextReady &&
    selected &&
    !['WON', 'LOST', 'VOIDED'].includes(selected.state) &&
    !policy.archivedAt;
  return (
    <div className="pv4-renewal-workspace" data-risk-revision={revision}>
      <PolicyNavigationGuard risks={risks} revision={revision} />
      <header className="pv4-renewal-heading">
        <div>
          <h2>Yenileme, teklif ve görüşmeler</h2>
          <p>
            {policy.customer.displayName} · {policy.policyNumber} · {policyDate(policy.startDate)} –{' '}
            {policyDate(policy.endDate)}
          </p>
        </div>
        <ReceiptText size={23} aria-hidden="true" />
      </header>
      {!selected && (
        <section className="pv4-surface pv4-select-renewal">
          <h3>Yenileme kaydını seçin</h3>
          <p>Bu poliçeye ait yetkili yenileme kaydını seçin.</p>
          <PolicyReadNotice {...resource} />
          {resource.data && !exact.length && (
            <p>
              Bu sayfada bu poliçeye ait görüntülenebilir yenileme yok.
              {resource.data.nextCursor ? ' Sonraki sayfayı kontrol edebilirsiniz.' : ''}
            </p>
          )}
          {exact.map((r) => (
            <div className="pv4-renewal-choice" key={r.id}>
              <div>
                <strong>{r.policyNumber}</strong>
                <small>
                  {policyDate(r.policyEndDate)} · {labels[r.state] ?? 'Durum sağlanmadı'}
                </small>
              </div>
              <Button onClick={() => choose(r)} aria-label={`${r.policyNumber} yenilemesini aç`}>
                Çalışma alanını aç
                <ArrowUpRight size={15} aria-hidden="true" />
              </Button>
            </div>
          ))}
          <div className="pv4-inline">
            <Button
              variant="ghost"
              disabled={!cursor || resource.loading}
              onClick={() => setCursor(null)}
            >
              İlk yenilemeler
            </Button>
            <Button
              variant="outline"
              disabled={!resource.data?.nextCursor || resource.loading}
              onClick={() => setCursor(resource.data!.nextCursor)}
            >
              Sonraki yenilemeler
            </Button>
          </div>
        </section>
      )}
      {selected && (
        <>
          <div className="pv4-selected-context">
            <span className="pv4-status is-active">
              {labels[selected.state] ?? 'Durum sağlanmadı'}
            </span>
            <span>Yenileme vadesi: {policyDate(selected.policyEndDate)}</span>
            <Button variant="ghost" disabled={anyRisk()} onClick={() => choose(null)}>
              Yenileme seçimini değiştir
            </Button>
          </div>
          <nav className="pv4-work-tabs" aria-label="Yenileme çalışma bölümleri">
            {contextError && <p role="alert">{contextError}</p>}
            {!contextReady && !contextError && !anyRisk() && (
              <p role="status">Yenileme durumu güncelleniyor…</p>
            )}
            {[
              ['quotes', 'Teklifler ve sürümler', ReceiptText],
              ['interactions', 'Görüşmeler', MessageSquare],
              ['followups', 'Takip ve sonuç', CalendarClock],
            ].map(([key, text, Icon]) => {
              const I = Icon as typeof ReceiptText;
              return (
                <Button
                  key={String(key)}
                  variant="ghost"
                  aria-pressed={tab === key}
                  onClick={() => setTab(String(key))}
                >
                  <I size={16} aria-hidden="true" />
                  {String(text)}
                </Button>
              );
            })}
          </nav>
          {anyRisk() && (
            <p className="pv4-draft-notice" role="status">
              Açık işlem bu yenilemeye bağlıdır. Sekmeler arasında korunur; hedef değiştirmek için
              önce kaydedin veya formdan vazgeçin.
            </p>
          )}
          <section
            className="pv4-renewal-body"
            hidden={tab !== 'quotes'}
            aria-label="Yenileme teklifleri"
          >
            <RenewalQuotesSection
              key={selected.id}
              renewalId={selected.id}
              renewalVersion={selected.version}
              renewalOpen={!!open}
              canOperate={() =>
                contextReady &&
                !risks.current.interaction?.dirty &&
                !risks.current.interaction?.unresolved
              }
              compareRenewal={compare}
              onRisk={quoteRisk}
            />
          </section>
          <section
            className="pv4-renewal-body"
            hidden={tab !== 'interactions'}
            aria-label="Yenileme görüşmeleri"
          >
            <fieldset
              className="pv4-action-lock"
              disabled={!!risks.current.quote?.dirty || !!risks.current.quote?.unresolved}
            >
              <RenewalInteractionsSection
                key={selected.id}
                renewalId={selected.id}
                onRiskChange={interactionRisk}
              />
            </fieldset>
          </section>
          <section className="pv4-surface" hidden={tab !== 'followups'}>
            <PolicyFollowups policy={policy} renewalId={selected.id} />
          </section>
        </>
      )}
    </div>
  );
}
function PolicyFollowups({ policy, renewalId }: { policy: PolicyDetailDto; renewalId: string }) {
  const [opened, setOpened] = useState(false);
  return (
    <>
      <h3>Yetkili takip ve sonuç işlemleri</h3>
      <p>
        Yalnız yetkili iş kuyruğunuzdan, aynı müşteri–poliçe–yenileme kimliğine bağlı kayıtlar
        açılır.
      </p>
      {!opened ? (
        <Button variant="outline" onClick={() => setOpened(true)}>
          Yetkili takipleri yükle
        </Button>
      ) : (
        <FollowupPage key={renewalId} policy={policy} renewalId={renewalId} />
      )}
    </>
  );
}
function FollowupPage({ policy, renewalId }: { policy: PolicyDetailDto; renewalId: string }) {
  const [cursor, setCursor] = useState<string | null>(null);
  const route = useLocation();
  const r = useCustomerResource<{ items: TodayTaskDto[]; nextCursor: string | null }>(
    '/api/tasks/today?limit=50' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''),
  );
  const matches =
    r.data?.items.filter(
      (t) =>
        t.renewalId === renewalId &&
        t.customerId === policy.customer.id &&
        t.policyId === policy.id,
    ) ?? [];
  return (
    <>
      <PolicyReadNotice {...r} />
      {r.data && !matches.length && (
        <p>
          Bu yetkili kuyruk sayfasında ilgili takip yok. Başka çalışanın görevi bu ekran üzerinden
          açılmaz.
        </p>
      )}
      {matches.map((t) => (
        <div className="pv4-renewal-choice" key={t.taskId}>
          <div>
            <strong>{t.title}</strong>
            <small>
              {new Intl.DateTimeFormat('tr-TR', {
                timeZone: 'Europe/Istanbul',
                dateStyle: 'medium',
                timeStyle: 'short',
              }).format(new Date(t.dueAt))}
            </small>
          </div>
          <Button asChild>
            <Link
              to={`/today-work?task=${encodeURIComponent(t.taskId)}&queue=WORK`}
              state={route.state}
            >
              Takip ve sonuç işlemlerini aç
            </Link>
          </Button>
        </div>
      ))}
      <div className="pv4-inline">
        <Button variant="ghost" disabled={!cursor || r.loading} onClick={() => setCursor(null)}>
          İlk takip sayfası
        </Button>
        <Button
          variant="outline"
          disabled={!r.data?.nextCursor || r.loading}
          onClick={() => setCursor(r.data!.nextCursor)}
        >
          Sonraki yetkili takipler
        </Button>
      </div>
    </>
  );
}
