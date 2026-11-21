import { RenewalReopenForm } from './RenewalReopenForm';
import { useCallback, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { PageHeader } from '../../components/layout/PageContainer';
import { Button } from '../../components/ui/button';
import { useCustomerResource, readCustomerResource } from '../customers/customer-resource';
import { CustomerNumberGuard } from '../customers/CustomerNumberGuard';
import { VehicleSummary } from '../customers/VehicleFields';
import { policyMoney, storedPolicyDate } from '../policies/policy-display';
import { RenewalQuotesSection, type QuoteRisk } from '../today-work/RenewalQuotesSection';
import { RenewalInteractionsSection } from '../today-work/RenewalInteractionsSection';
import type { InteractionRisk } from '../today-work/interaction-model';
import { renewalStateLabels } from '../../../shared/renewal-browsing';
import { renewalDetailFor } from './renewal-browse-schemas';
import { RenewalActionWorkspace } from './RenewalActionWorkspace';
import type { TaskOperationRisk } from '../today-work/TaskOperationsSection';
import { RenewalPriceWorkspace } from '../sales/RenewalPriceWorkspace';
import type { PriceRisk } from '../sales/SalesPricesSection';
function Detail({ id }: { id: string }) {
  const route = useLocation(),
    root = '/api/renewals/' + encodeURIComponent(id);
  const decoder = useMemo(() => renewalDetailFor(id), [id]);
  const record = useCustomerResource(root, decoder);
  const [section, setSection] = useState<'quotes' | 'communication' | 'outcomes'>('quotes'),
    [actionsVisited, setActionsVisited] = useState(false),
    [operationMessage, setOperationMessage] = useState(''),
    [actionRisk, setActionRisk] = useState<TaskOperationRisk>({ dirty: false, unresolved: false }),
    [quoteRisk, setQuoteRisk] = useState<QuoteRisk>({ dirty: false, unresolved: false }),
    [priceRisk, setPriceRisk] = useState<PriceRisk>({ dirty: false, unresolved: false }),
    [legacyVisited, setLegacyVisited] = useState(false),
    [interaction, setInteraction] = useState<InteractionRisk>('clean');
  const risk = useRef({ quote: quoteRisk, prices: priceRisk, interaction, action: actionRisk });
  risk.current = { quote: quoteRisk, prices: priceRisk, interaction, action: actionRisk };
  const onPriceRisk = useCallback(
    (next: PriceRisk) =>
      setPriceRisk((old) =>
        old.dirty === next.dirty && old.unresolved === next.unresolved ? old : next,
      ),
    [],
  );
  const onActionRisk = useCallback(
    (r: TaskOperationRisk) =>
      setActionRisk((old) => (old.dirty === r.dirty && old.unresolved === r.unresolved ? old : r)),
    [],
  );
  const onQuoteRisk = useCallback(
    (next: QuoteRisk) =>
      setQuoteRisk((old) =>
        old.dirty === next.dirty && old.unresolved === next.unresolved ? old : next,
      ),
    [],
  );
  const onInteraction = useCallback((next: InteractionRisk) => setInteraction(next), []);
  const dirty = quoteRisk.dirty || priceRisk.dirty || interaction !== 'clean' || actionRisk.dirty,
    unresolved =
      quoteRisk.unresolved ||
      priceRisk.unresolved ||
      interaction === 'uncertain' ||
      interaction === 'saved-unread' ||
      actionRisk.unresolved;
  const back: unknown = route.state?.renewalList,
    returnTo =
      typeof back === 'string' && (back === '/renewals' || back.startsWith('/renewals?'))
        ? back
        : '/renewals';
  const item = record.data;
  const listKey: unknown = route.state?.listPositionKey;
  const listState =
    returnTo === back && typeof listKey === 'string' ? { listPositionKey: listKey } : undefined;
  return (
    <div className="customer-modern crm-workspace employee-workspace renewal-browsing">
      <CustomerNumberGuard
        label="Yenileme işlemi"
        dirty={dirty}
        unresolved={unresolved}
        listReturn={listState && { to: returnTo, ...listState }}
      />
      {operationMessage && (
        <p role="status" className="renewal-record-card">
          {operationMessage}
        </p>
      )}
      <Link className="customer-back-link" to={returnTo} state={listState}>
        ← Yenilemelere dön
      </Link>
      {record.loading && <p role="status">Yenileme yükleniyor…</p>}
      {record.error && (
        <div>
          <p role="alert">{record.error.message}</p>
          {record.error.status >= 500 && (
            <Button variant="outline" onClick={record.reload}>
              Yenilemeyi yeniden yükle
            </Button>
          )}
        </div>
      )}
      {item && (
        <>
          <PageHeader
            title={item.customer.displayName}
            description={item.policy.branchName + ' yenilemesi'}
            action={
              <Button variant="outline" disabled={dirty || unresolved} onClick={record.reload}>
                Bilgileri yenile
              </Button>
            }
          />
          <div className="renewal-record-card">
            <div className="customer-form-actions">
              <Button asChild variant="outline">
                <Link to={'/customers/' + encodeURIComponent(item.customer.id)}>Müşteri kartı</Link>
              </Button>
              <Button asChild variant="outline">
                <Link to={'/policies/' + encodeURIComponent(item.policy.id)}>Mevcut poliçe</Link>
              </Button>
            </div>
            <dl className="customer-info-grid">
              <div>
                <dt>Yenileme durumu</dt>
                <dd>{renewalStateLabels[item.state]}</dd>
              </div>
              <div>
                <dt>Sigorta şirketi</dt>
                <dd>{item.policy.insurerName}</dd>
              </div>
              <div>
                <dt>Şirket müşteri no</dt>
                <dd>{item.insurerCustomerNumber ?? 'Belirtilmedi'}</dd>
              </div>
              <div>
                <dt>Poliçe no</dt>
                <dd>{item.policy.number}</dd>
              </div>
              <div>
                <dt>Başlangıç</dt>
                <dd>{storedPolicyDate(item.policy.startDate)}</dd>
              </div>
              <div>
                <dt>Bitiş</dt>
                <dd>{storedPolicyDate(item.policy.endDate)}</dd>
              </div>
              <div>
                <dt>Önceki prim</dt>
                <dd>{policyMoney(item.policy.grossPremiumMinor, item.policy.currency)}</dd>
              </div>
              <div>
                <dt>Referans kişi</dt>
                <dd>{item.referenceName ?? 'Belirtilmedi'}</dd>
              </div>
              <div>
                <dt>Telefon</dt>
                <dd>{item.phone ?? 'Belirtilmedi'}</dd>
              </div>
              <div>
                <dt>E-posta</dt>
                <dd>{item.email ?? 'Belirtilmedi'}</dd>
              </div>
            </dl>
          </div>
          {item.vehicle && (
            <section className="renewal-record-card" aria-label="Yenilenecek poliçenin aracı">
              <h2>Mevcut poliçenin araç bilgileri</h2>
              <VehicleSummary details={item.vehicle.details} />
            </section>
          )}
          {!item.isOpen && (
            <p>Bu yenileme işlem için kapalıdır. Kayıtlı bilgileri inceleyebilirsiniz.</p>
          )}
          {item.parentArchived || item.policy.status !== 'ACTIVE' ? (
            <div>
              <p>
                Arşivlenmiş veya işlem için kapalı müşteri/poliçenin yenileme özeti salt okunur
                gösterilir.
              </p>
              <RenewalPriceWorkspace
                renewalId={id}
                customerId={item.customer.id}
                active
                readOnly
                canOperate={() => false}
                onRisk={onPriceRisk}
              />
            </div>
          ) : (
            <>
              <div className="renewal-section-switch" role="group" aria-label="Yenileme bölümü">
                {item.isOpen && (
                  <Button
                    aria-pressed={section === 'outcomes'}
                    onClick={() => {
                      setActionsVisited(true);
                      setSection('outcomes');
                    }}
                  >
                    Poliçelendirme / takip
                  </Button>
                )}
                <Button
                  variant="outline"
                  aria-pressed={section === 'quotes'}
                  onClick={() => setSection('quotes')}
                >
                  Şirket teklifleri
                </Button>
                <Button
                  variant="outline"
                  aria-pressed={section === 'communication'}
                  onClick={() => setSection('communication')}
                >
                  Görüşmeler
                </Button>
              </div>
              {['LOST', 'VOIDED'].includes(item.state) && (
                <RenewalReopenForm
                  renewalId={id}
                  onRisk={onActionRisk}
                  canOperate={() =>
                    !risk.current.quote.dirty &&
                    !risk.current.quote.unresolved &&
                    !risk.current.prices.dirty &&
                    !risk.current.prices.unresolved &&
                    risk.current.interaction === 'clean'
                  }
                  onApplied={(message) => {
                    onActionRisk({ dirty: false, unresolved: false });
                    setOperationMessage(message);
                    record.reload();
                  }}
                />
              )}
              <div hidden={section !== 'quotes'}>
                <RenewalPriceWorkspace
                  renewalId={id}
                  customerId={item.customer.id}
                  active={section === 'quotes'}
                  canOperate={() =>
                    item.isOpen &&
                    !risk.current.quote.dirty &&
                    !risk.current.quote.unresolved &&
                    risk.current.interaction === 'clean' &&
                    !risk.current.action.dirty &&
                    !risk.current.action.unresolved
                  }
                  onRisk={onPriceRisk}
                  readOnly={!item.isOpen}
                />
                <details
                  className="renewal-record-card"
                  onToggle={(e) => {
                    if (e.currentTarget.open) setLegacyVisited(true);
                  }}
                >
                  <summary>Kayıtlı teklif belgeleri ve önceki işlemler</summary>
                  <p>
                    Önceden oluşturulan tekliflerin paylaşım ve poliçe bağlantıları burada korunur.
                  </p>
                  {legacyVisited && (
                    <RenewalQuotesSection
                      renewalId={id}
                      active={section === 'quotes'}
                      renewalVersion={item.version}
                      renewalOpen={item.isOpen}
                      canOperate={() =>
                        item.isOpen &&
                        risk.current.interaction === 'clean' &&
                        !risk.current.action.dirty &&
                        !risk.current.action.unresolved &&
                        !risk.current.prices.dirty &&
                        !risk.current.prices.unresolved
                      }
                      compareRenewal={async (signal) => {
                        const current = await readCustomerResource(root, signal, decoder);
                        return current.isOpen ? current.version : null;
                      }}
                      onRisk={onQuoteRisk}
                    />
                  )}
                </details>
              </div>
              <div hidden={section !== 'communication'}>
                <fieldset
                  className="renewal-operation-boundary"
                  disabled={
                    quoteRisk.dirty ||
                    quoteRisk.unresolved ||
                    priceRisk.dirty ||
                    priceRisk.unresolved ||
                    actionRisk.dirty ||
                    actionRisk.unresolved
                  }
                >
                  <RenewalInteractionsSection
                    renewalId={id}
                    readOnly={!item.isOpen}
                    onRiskChange={onInteraction}
                  />
                </fieldset>
              </div>
              {actionsVisited && item.isOpen && (
                <div hidden={section !== 'outcomes'}>
                  <RenewalActionWorkspace
                    renewalId={id}
                    onRisk={onActionRisk}
                    canOperate={() =>
                      item.isOpen &&
                      !risk.current.quote.dirty &&
                      !risk.current.quote.unresolved &&
                      !risk.current.prices.dirty &&
                      !risk.current.prices.unresolved &&
                      risk.current.interaction === 'clean'
                    }
                    onApplied={(message) => {
                      setOperationMessage(message);
                      setSection('quotes');
                      record.reload();
                    }}
                  />
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
export default function RenewalDetailPage() {
  const { renewalId = '' } = useParams();
  return <Detail key={renewalId} id={renewalId} />;
}
