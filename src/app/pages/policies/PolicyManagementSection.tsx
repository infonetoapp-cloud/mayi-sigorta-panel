import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import type { CustomerAssignmentOptionDto, PolicyDetailDto } from '../../../shared/types';
import { useCustomerResource } from '../customers/customer-resource';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { policyDate, policyMoney, policyStatusLabel, PolicyReadNotice } from './policy-display';
import { usePolicyLifecycle } from './use-policy-lifecycle';
type Props = { policy: PolicyDetailDto; onUpdated: (fresh: PolicyDetailDto) => void };
type Action = ReturnType<typeof usePolicyLifecycle>;
function Notices({ action }: { action: Action }) {
  return (
    <>
      {action.error && <p role="alert">{action.error}</p>}
      {action.success && <p role="status">{action.success}</p>}
      {action.busy && <p role="status">İşlem sürüyor…</p>}
      {action.pending && (
        <Button variant="outline" disabled={action.busy || action.blocked} onClick={action.retry}>
          Aynı işlemi yeniden dene
        </Button>
      )}
      {action.needsRead && (
        <Button variant="outline" disabled={action.busy} onClick={action.refresh}>
          Kaydedilen poliçeyi yeniden oku
        </Button>
      )}
      {action.needsComparison && !action.needsRead && !action.blocked && (
        <Button variant="outline" disabled={action.busy} onClick={action.refresh}>
          Güncel poliçeyi karşılaştır
        </Button>
      )}
    </>
  );
}
function Contract({ policy }: { policy: PolicyDetailDto }) {
  return (
    <dl className="customer-info-grid">
      <div>
        <dt>Poliçe numarası</dt>
        <dd>{policy.policyNumber}</dd>
      </div>
      <div>
        <dt>Sözleşme dönemi</dt>
        <dd>
          {policyDate(policy.startDate)} – {policyDate(policy.endDate)}
        </dd>
      </div>
      <div>
        <dt>Brüt prim</dt>
        <dd>{policyMoney(policy.grossPremiumMinor, policy.currency)}</dd>
      </div>
      <div>
        <dt>Poliçe durumu</dt>
        <dd>{policyStatusLabel[policy.status]}</dd>
      </div>
    </dl>
  );
}
function Assignment({ policy, onUpdated }: Props) {
  const initial = useCustomerResource<CustomerAssignmentOptionDto[]>(
      `/api/policies/${encodeURIComponent(policy.id)}/assignment-options`,
    ),
    action = usePolicyLifecycle('assign', policy, onUpdated);
  const [selected, setSelected] = useState(''),
    [confirmed, setConfirmed] = useState(false),
    [validation, setValidation] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (action.opened) heading.current?.focus();
  }, [action.opened]);
  useEffect(() => {
    setConfirmed(false);
  }, [action.comparison]);
  const options = action.snapshot?.options ?? initial.data,
    hidden = action.blocked || !!initial.error;
  const label = options?.find(
    (option) => option.membershipId === action.current.assigneeMembershipId,
  )?.label;
  const valid = !!options?.some((option) => option.membershipId === selected);
  return (
    <Card aria-label="Poliçe sorumlusu">
      <CardHeader>
        <CardTitle>Poliçe sorumlusu</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="customer-legacy-hint">
          Bu atama yalnız poliçenin sorumlusudur; kişisel günlük görev, yenileme takip görevi veya
          şirket yetkilisi ataması değildir.
        </p>
        <PolicyReadNotice
          loading={!action.snapshot && initial.loading}
          error={initial.error}
          reload={initial.reload}
        />
        <Notices action={action} />
        {!hidden && options && (
          <>
            <p>
              {label
                ? `Mevcut sorumlu: ${label}`
                : 'Mevcut sorumlu etkin seçenekler arasında bulunmuyor. Tarihsel bağlantı korunuyor; başka kişi otomatik seçilmez.'}
            </p>
            {action.archived ? (
              <p>Arşivlenmiş poliçenin sorumlusu değiştirilemez.</p>
            ) : (
              !action.opened && (
                <Button
                  disabled={action.locked}
                  onClick={() => {
                    if (action.open()) {
                      setSelected('');
                      setConfirmed(false);
                      setValidation('');
                    }
                  }}
                >
                  Sorumluyu değiştir
                </Button>
              )
            )}
            {action.opened && !action.archived && (
              <form
                className="policy-contract-form customer-edit-form"
                aria-label="Poliçe sorumlusu atama formu"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!valid || !confirmed) {
                    setValidation('Etkin bir sorumluyu açıkça seçip değişikliği onaylayın.');
                    return;
                  }
                  setValidation('');
                  action.submit({ assigneeMembershipId: selected });
                }}
              >
                <h3 ref={heading} tabIndex={-1}>
                  Sorumlu değişikliği onayı
                </h3>
                <fieldset disabled={action.locked}>
                  <label htmlFor="policy-assignee">Yeni poliçe sorumlusu</label>
                  <select
                    id="policy-assignee"
                    value={selected}
                    onChange={(event) => {
                      setSelected(event.target.value);
                      setConfirmed(false);
                    }}
                  >
                    <option value="">Açıkça sorumlu seçin</option>
                    {selected && !valid && (
                      <option value={selected} disabled>
                        Seçilen sorumlu artık etkin değil
                      </option>
                    )}
                    {options.map((option) => (
                      <option key={option.membershipId} value={option.membershipId}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <label className="company-primary-choice">
                    <input
                      type="checkbox"
                      checked={confirmed}
                      onChange={(event) => setConfirmed(event.target.checked)}
                    />
                    Sorumlu değişikliğini onaylıyorum
                  </label>
                </fieldset>
                {action.comparison && (
                  <aside className="company-contact-comparison" role="status">
                    <strong>
                      Karşılaştırılan poliçe sürümü: {action.comparison.policy.version}
                    </strong>
                    <p>
                      Güncel sorumlu:{' '}
                      {options.find(
                        (option) =>
                          option.membershipId === action.comparison!.policy.assigneeMembershipId,
                      )?.label ?? 'Etkin seçeneklerde bulunmuyor'}
                    </p>
                    <p>
                      Seçiminiz korundu. Etkin seçenekleri kontrol edip yeniden açıkça onaylayın.
                    </p>
                  </aside>
                )}
                {validation && <p role="alert">{validation}</p>}
                <div className="customer-form-actions">
                  <Button type="submit" disabled={action.locked}>
                    {action.comparison ? 'Karşılaştırdım, atamayı kaydet' : 'Atamayı kaydet'}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={action.busy || !!action.pending || action.needsRead}
                    onClick={action.cancel}
                  >
                    Vazgeç
                  </Button>
                </div>
              </form>
            )}
          </>
        )}
        {initial.error?.status === 403 && (
          <p>
            Atama dizini için etkin AGENCY atama yetkisi gerekir. Mevcut sorumlu değiştirilmedi.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
function Archive({ policy, onUpdated }: Props) {
  const action = usePolicyLifecycle('archive', policy, onUpdated);
  const [reason, setReason] = useState(''),
    [confirmed, setConfirmed] = useState(false),
    [validation, setValidation] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (action.opened) heading.current?.focus();
  }, [action.opened]);
  useEffect(() => {
    setConfirmed(false);
  }, [action.comparison]);
  return (
    <Card className="policy-danger" aria-label="Poliçe arşivleme">
      <CardHeader>
        <CardTitle>Poliçeyi arşivle</CardTitle>
      </CardHeader>
      <CardContent>
        <p>
          Arşivleme sözleşme iptali, geçersiz kılma veya yenileme tamamlama değildir. Özgün durum,
          dönem ve prim korunur. Açık yenileme/takip işi varsa sunucu işlemi engeller; bu ekran
          hiçbir görevi kapatmaz.
        </p>
        <Notices action={action} />
        {action.dependencies && (
          <p className="customer-legacy-hint">
            Açık işleri yetkili çalışma alanında inceleyin.{' '}
            <Link to="/today-work">Bugünkü İşler'e git</Link>. Yetkiniz yoksa sorumlu kişiden
            inceleme isteyin; kontrol atlanamaz.
          </p>
        )}
        {action.archived ? (
          <p>Poliçe arşivlenmiş ve salt okunurdur. Tarihsel sözleşme bilgileri korunur.</p>
        ) : (
          !action.opened &&
          !action.blocked && (
            <Button
              variant="outline"
              disabled={action.locked}
              onClick={() => {
                if (action.open()) {
                  setReason('');
                  setConfirmed(false);
                  setValidation('');
                }
              }}
            >
              Poliçeyi arşivle
            </Button>
          )
        )}
        {action.opened && !action.archived && !action.blocked && (
          <form
            className="policy-contract-form customer-edit-form"
            aria-label="Poliçe arşiv onayı"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(reason) || !confirmed) {
                setValidation(
                  '3–64 karakterli büyük harf/rakam/alt çizgi gerekçe kodu girin (harfle başlamalı) ve arşivlemeyi açıkça onaylayın.',
                );
                return;
              }
              setValidation('');
              action.submit({ reasonCode: reason });
            }}
          >
            <h3 ref={heading} tabIndex={-1}>
              Son arşiv onayı
            </h3>
            <Contract policy={action.comparison?.policy ?? action.opened} />
            <fieldset disabled={action.locked}>
              <label htmlFor="policy-archive-reason">Arşiv gerekçe kodu</label>
              <Input
                id="policy-archive-reason"
                value={reason}
                maxLength={64}
                placeholder="HISTORICAL_RECORD"
                onChange={(event) => {
                  setReason(event.target.value);
                  setConfirmed(false);
                }}
              />
              <p className="customer-legacy-hint">
                Örnek: HISTORICAL_RECORD. Gerekçeyi açıkça girin; otomatik seçim yapılmaz.
              </p>
              <label className="company-primary-choice">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                Bu poliçeyi arşivlemek istediğimi onaylıyorum
              </label>
            </fieldset>
            {action.comparison && (
              <aside className="company-contact-comparison" role="status">
                <strong>Karşılaştırılan poliçe sürümü: {action.comparison.policy.version}</strong>
                <p>
                  Güncel sözleşmeyi ve gerekçeyi inceleyin; arşivlemek için yeniden açıkça
                  onaylayın. Bağımlılık kontrolü tekrar sunucuda yapılır.
                </p>
              </aside>
            )}
            {validation && <p role="alert">{validation}</p>}
            <div className="customer-form-actions">
              <Button type="submit" disabled={action.locked}>
                {action.comparison ? 'Karşılaştırdım, arşivlemeyi onayla' : 'Arşivlemeyi onayla'}
              </Button>
              <Button
                variant="outline"
                disabled={action.busy || !!action.pending || action.needsRead}
                onClick={action.cancel}
              >
                Vazgeç
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
export function PolicyManagementSection(props: Props) {
  return (
    <div className="policy-management">
      <Assignment key={props.policy.id + ':assign'} {...props} />
      <Archive key={props.policy.id + ':archive'} {...props} />
    </div>
  );
}
