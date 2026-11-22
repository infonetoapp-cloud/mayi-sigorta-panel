import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { z } from 'zod';
import { taxNumberSchema, manualCustomerNumberSchema } from '../../../shared/customer-registration';
import { istanbulToday, validBirthDate } from '../../../shared/customer-profile';
import { CustomerReferenceField } from './CustomerReferenceField';
import type { ApiResponse, CustomerDto, CustomerType } from '../../../shared/types';
import { getCsrfToken, invalidateCsrfToken, parseAppError } from '../../App';
import { PageHeader } from '../../components/layout/PageContainer';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { NavigationDecision } from '../../components/layout/NavigationDecision';
import { registerQuotePopGuard } from '../today-work/quote-navigation';

const initial = {
  taxNumber: '',
  insurerId: '',
  customerNumber: '',
  birthDate: '',
  referenceName: '',
  referenceMembershipId: '',
  firstName: '',
  lastName: '',
  companyTitle: '',
  email: '',
  phone: '',
  address: '',
};
type Fields = typeof initial;
interface Attempt {
  next?: 'profile' | 'policy';
  body: string;
  key: string;
}
export default function CustomerCreatePage() {
  const navigate = useNavigate();
  const [type, setType] = useState<CustomerType>('INDIVIDUAL');
  const [draft, setDraft] = useState(initial);
  const [errors, setErrors] = useState<Partial<Fields>>({});
  const [insurers, setInsurers] = useState<{ id: string; name: string }[]>([]);
  const [insurerError, setInsurerError] = useState('');
  const [insurerLoad, setInsurerLoad] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setInsurerError('');
    void fetch('/api/catalogs/insurers', { signal: controller.signal, cache: 'no-store' })
      .then(async (response) => {
        const result = (await response.json()) as ApiResponse<{ id: string; name: string }[]>;
        if (controller.signal.aborted) return;
        if (!response.ok || !result.success || !Array.isArray(result.data))
          throw new Error('Insurers unavailable');
        setInsurers(result.data);
        if (!result.data.length)
          setInsurerError('Aktif sigorta şirketi yok. Katalogdan bir şirket eklenmesi gerekiyor.');
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setInsurerError('Sigorta şirketleri yüklenemedi. Yeniden deneyin.');
      });
    return () => controller.abort();
  }, [insurerLoad]);

  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Attempt | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [leave, setLeave] = useState<(() => void) | null>(null);
  const [navigationMessage, setNavigationMessage] = useState('');
  const navigationNotice = useRef<HTMLParagraphElement>(null);
  const created = useRef(false);
  const navigationRisk = useRef({ dirty: false, frozen: false });
  navigationRisk.current = {
    dirty: type !== 'INDIVIDUAL' || Object.values(draft).some((value) => value !== ''),
    frozen: busy || !!pending,
  };
  const saving = useRef(false),
    generation = useRef(0),
    attempt = useRef<Attempt | null>(null);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  const locked = busy || !!pending || blocked;
  useEffect(() => {
    const index: unknown = history.state?.idx;
    let restoring = false;
    let confirmedPop = false;
    const frozen = () => saving.current || navigationRisk.current.frozen;
    const atRisk = () => !created.current && (navigationRisk.current.dirty || frozen());
    const attention = () => document.dispatchEvent(new Event('mayi-navigation-attention'));
    const hold = () => {
      setLeave(null);
      setNavigationMessage(
        'Kayıt isteği henüz sonuçlanmadı. Çift müşteri oluşturmamak için bu ekranda kalın; belirsiz sonuçta yalnız aynı kaydı yeniden deneyin.',
      );
      navigationNotice.current?.focus();
    };
    const click = (event: MouseEvent) => {
      const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (
        !atRisk() ||
        !(link instanceof HTMLAnchorElement) ||
        event.button !== 0 ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.altKey ||
        link.hasAttribute('download') ||
        (link.target && link.target !== '_self') ||
        link.href === location.href
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      attention();
      if (frozen()) return hold();
      const url = new URL(link.href);
      setLeave(() => () => {
        if (url.origin === location.origin) void navigate(url.pathname + url.search + url.hash);
        else location.assign(url.href);
      });
    };
    const pop = (event: PopStateEvent) => {
      if (confirmedPop) {
        confirmedPop = false;
        return;
      }
      if (restoring) {
        restoring = false;
        event.stopImmediatePropagation();
        return;
      }
      const next: unknown = event.state?.idx;
      if (
        !atRisk() ||
        !Number.isSafeInteger(index) ||
        !Number.isSafeInteger(next) ||
        next === index
      )
        return;
      // Reuse the early AuthShell boundary: Router never unmounts the frozen form.
      event.stopImmediatePropagation();
      restoring = true;
      history.go((index as number) - (next as number));
      attention();
      if (frozen()) return hold();
      setLeave(() => () => {
        confirmedPop = true;
        history.go((next as number) - (index as number));
      });
    };
    const unload = (event: BeforeUnloadEvent) => {
      if (atRisk()) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    document.addEventListener('click', click, true);
    addEventListener('beforeunload', unload);
    const removePopGuard = registerQuotePopGuard(pop);
    return () => {
      document.removeEventListener('click', click, true);
      removeEventListener('beforeunload', unload);
      removePopGuard();
    };
  }, [navigate]);
  useEffect(() => {
    if (navigationMessage) navigationNotice.current?.focus();
  }, [navigationMessage]);
  async function send(current: Attempt) {
    if (saving.current || blocked) return;
    saving.current = true;
    setBusy(true);
    setError('');
    const view = generation.current;
    try {
      const token = await getCsrfToken();
      if (view !== generation.current) return;
      const response = await fetch('/api/customers', {
        method: 'POST',
        cache: 'no-store',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': token,
          'Idempotency-Key': current.key,
        },
        body: current.body,
      });
      if (view !== generation.current) return;
      if (response.status === 401) {
        parseAppError(401);
        setBlocked(true);
        setError('Oturum sona erdi. Yeniden giriş yapın.');
        return;
      }
      const envelope = (await response.json().catch(() => null)) as ApiResponse<CustomerDto> | null;
      if (view !== generation.current) return;
      if (!response.ok) {
        if (response.status === 403) invalidateCsrfToken();
        const info = parseAppError(
          response.status,
          envelope && !envelope.success ? envelope.error : null,
        );
        if (info.isRetryable || response.status === 429) throw new Error('UNCERTAIN');
        const duplicateNumber =
          response.status === 409 &&
          envelope &&
          !envelope.success &&
          envelope.error.code === 'DUPLICATE_EXTERNAL_REFERENCE';
        setPending(null);
        setBlocked(!duplicateNumber && [403, 404, 409].includes(response.status));
        setError(
          duplicateNumber
            ? 'Bu sigorta şirketindeki müşteri no başka bir müşteride kayıtlı. Numarayı kontrol edin veya mevcut müşteri kaydını açın.'
            : response.status === 409
              ? 'Kayıt isteği çakıştı veya daha önce işlendi. Yeni kayıt göndermeden müşteri listesini kontrol edin.'
              : info.message,
        );
        attempt.current = null;
        return;
      }
      if (!envelope?.success || typeof envelope.data?.id !== 'string' || !envelope.data.id)
        throw new Error('UNCERTAIN');
      created.current = true;
      void navigate(
        current.next === 'policy'
          ? `/policies/new?customerId=${encodeURIComponent(envelope.data.id)}`
          : `/customers/${encodeURIComponent(envelope.data.id)}`,
        { replace: true, state: { customerCreated: true } },
      );
    } catch {
      if (view !== generation.current) return;
      setPending(current);
      setError(
        'Kaydın tamamlandığı doğrulanamadı. Çift kayıt oluşturmamak için bilgiler kilitlendi; aynı isteği güvenle yeniden deneyin.',
      );
    } finally {
      saving.current = false;
      if (view === generation.current) setBusy(false);
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (locked) return;
    const values = Object.fromEntries(
      Object.entries(draft).map(([key, value]) => [key, value.trim()]),
    ) as Fields;
    const invalid: Partial<Fields> = {};
    if (type === 'INDIVIDUAL') {
      if (!values.firstName) invalid.firstName = 'Ad zorunludur.';
      else if (values.firstName.length > 100)
        invalid.firstName = 'Ad en fazla 100 karakter olabilir.';
      if (!values.lastName) invalid.lastName = 'Soyad zorunludur.';
      else if (values.lastName.length > 100)
        invalid.lastName = 'Soyad en fazla 100 karakter olabilir.';
    } else if (!values.companyTitle) invalid.companyTitle = 'Şirket unvanı zorunludur.';
    else if (values.companyTitle.length > 255)
      invalid.companyTitle = 'Unvan en fazla 255 karakter olabilir.';
    if (type === 'COMPANY' && !taxNumberSchema.safeParse(values.taxNumber).success)
      invalid.taxNumber = values.taxNumber
        ? 'Vergi no 10 rakamdan oluşmalıdır.'
        : 'Vergi no zorunludur.';
    if (!values.insurerId || !insurers.some((insurer) => insurer.id === values.insurerId))
      invalid.insurerId = 'Sigorta şirketi seçin.';
    if (!manualCustomerNumberSchema.safeParse(values.customerNumber).success)
      invalid.customerNumber = 'Geçerli bir müşteri no girin (en fazla 100 karakter).';
    if (values.email && !z.email().safeParse(values.email).success)
      invalid.email = 'Geçerli bir e-posta adresi girin.';
    if (values.phone.length > 50) invalid.phone = 'Telefon en fazla 50 karakter olabilir.';
    if (values.address.length > 1000) invalid.address = 'Adres en fazla 1000 karakter olabilir.';
    if (
      type === 'INDIVIDUAL' &&
      values.birthDate &&
      (!validBirthDate(values.birthDate) || values.birthDate > istanbulToday())
    )
      invalid.birthDate = 'Geçerli, gelecekte olmayan bir doğum tarihi girin.';
    setErrors(invalid);
    setError('');
    if (Object.keys(invalid).length) {
      document.getElementById('new-' + Object.keys(invalid)[0])?.focus();
      return;
    }
    const body = JSON.stringify({
      type,
      ...(type === 'INDIVIDUAL'
        ? { firstName: values.firstName, lastName: values.lastName }
        : { companyTitle: values.companyTitle, taxNumber: values.taxNumber }),
      insurerNumber: { insurerId: values.insurerId, customerNumber: values.customerNumber },
      email: values.email || null,
      phone: values.phone || null,
      address: values.address || null,
      ...(type === 'INDIVIDUAL' && values.birthDate ? { birthDate: values.birthDate } : {}),
      ...(values.referenceMembershipId
        ? { referenceMembershipId: values.referenceMembershipId }
        : {}),
      ...(values.referenceName ? { referenceName: values.referenceName } : {}),
    });
    const snapshot: Attempt =
      attempt.current?.body === body ? attempt.current : { body, key: crypto.randomUUID() };
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    snapshot.next =
      submitter instanceof HTMLElement && submitter.dataset.next === 'policy'
        ? 'policy'
        : 'profile';
    attempt.current = snapshot;
    void send(snapshot);
  }
  function changeField(name: keyof Fields, value: string) {
    setDraft((previous) => ({ ...previous, [name]: value }));
    setErrors((previous) => (previous[name] ? { ...previous, [name]: undefined } : previous));
  }
  const field = (name: keyof Fields, label: string, maximum?: number, inputType = 'text') => (
    <div className={name === 'address' ? 'customer-form-wide' : ''}>
      <label htmlFor={`new-${name}`}>{label}</label>
      {name === 'address' ? (
        <textarea
          id={`new-${name}`}
          rows={4}
          value={draft[name]}
          maxLength={maximum}
          aria-invalid={!!errors[name]}
          aria-describedby={errors[name] ? `error-${name}` : undefined}
          onChange={(event) => changeField(name, event.target.value)}
        />
      ) : (
        <Input
          id={`new-${name}`}
          type={inputType}
          name={name}
          max={inputType === 'date' ? istanbulToday() : undefined}
          autoComplete={
            name === 'birthDate'
              ? 'bday'
              : name === 'firstName'
                ? 'given-name'
                : name === 'lastName'
                  ? 'family-name'
                  : name === 'email'
                    ? 'email'
                    : name === 'phone'
                      ? 'tel'
                      : undefined
          }
          required={[
            'firstName',
            'lastName',
            'companyTitle',
            'taxNumber',
            'customerNumber',
          ].includes(name)}
          inputMode={name === 'taxNumber' ? 'numeric' : undefined}
          pattern={name === 'taxNumber' ? '[0-9]{10}' : undefined}
          spellCheck={name === 'taxNumber' || name === 'customerNumber' ? false : undefined}
          value={draft[name]}
          maxLength={maximum}
          aria-invalid={!!errors[name]}
          aria-describedby={errors[name] ? `error-${name}` : undefined}
          onInput={
            inputType === 'date'
              ? (event) => {
                  const value = event.currentTarget.value;
                  changeField(name, value);
                }
              : undefined
          }
          onChange={(event) => changeField(name, event.target.value)}
        />
      )}
      {errors[name] && (
        <p id={`error-${name}`} className="customer-field-error">
          {errors[name]}
        </p>
      )}
    </div>
  );
  return (
    <div className="customer-modern">
      {leave && (
        <NavigationDecision
          onStay={() => {
            setLeave(null);
            document
              .getElementById(type === 'INDIVIDUAL' ? 'new-firstName' : 'new-companyTitle')
              ?.focus();
          }}
        >
          <h2 id="navigation-decision-title">Kaydedilmemiş müşteri bilgileri var</h2>
          <p>
            Bu ekranda kalırsanız bilgileriniz korunur. Ayrılırsanız kaydedilmemiş taslak silinir.
          </p>
          <Button
            onClick={() => {
              setLeave(null);
              document
                .getElementById(type === 'INDIVIDUAL' ? 'new-firstName' : 'new-companyTitle')
                ?.focus();
            }}
          >
            Bu ekranda kal
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              if (saving.current || navigationRisk.current.frozen) return;
              leave();
              setLeave(null);
            }}
          >
            Taslağı bırak ve ayrıl
          </Button>
        </NavigationDecision>
      )}
      <Link className="customer-back" to="/customers">
        Müşteri listesine dön
      </Link>
      <PageHeader
        title="Yeni müşteri"
        description="Bireysel veya kurumsal müşteri kaydını acentenizin ortak çalışma alanına ekleyin."
      />
      <Card>
        <CardHeader>
          <CardTitle>Müşteri bilgileri</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            noValidate
            onSubmit={submit}
            className="customer-edit-form"
            aria-label="Yeni müşteri oluşturma"
          >
            <fieldset disabled={locked}>
              <legend className="sr-only">Müşteri bilgileri</legend>
              <div>
                <label htmlFor="new-type">Müşteri türü</label>
                <select
                  id="new-type"
                  value={type}
                  onChange={(event) => {
                    setType(event.target.value as CustomerType);
                    setErrors({});
                  }}
                >
                  <option value="INDIVIDUAL">Bireysel</option>
                  <option value="COMPANY">Kurumsal</option>
                </select>
              </div>
              <div className="customer-form-grid">
                {type === 'INDIVIDUAL' ? (
                  <>
                    {field('firstName', 'Ad', 100)}
                    {field('lastName', 'Soyad', 100)}
                    {field('birthDate', 'Doğum tarihi', undefined, 'date')}
                  </>
                ) : (
                  <>
                    {field('companyTitle', 'Şirket unvanı', 255)}
                    {field('taxNumber', 'Vergi no (zorunlu)', 10)}
                  </>
                )}
                <div>
                  <label htmlFor="new-insurerId">Sigorta şirketi (zorunlu)</label>
                  <select
                    id="new-insurerId"
                    name="insurerId"
                    required
                    value={draft.insurerId}
                    aria-invalid={!!errors.insurerId}
                    aria-describedby={errors.insurerId ? 'error-insurerId' : undefined}
                    onChange={(event) => changeField('insurerId', event.target.value)}
                  >
                    <option value="">Sigorta şirketi seçin</option>
                    {insurers.map((insurer) => (
                      <option key={insurer.id} value={insurer.id}>
                        {insurer.name}
                      </option>
                    ))}
                  </select>
                  {errors.insurerId && (
                    <p id="error-insurerId" className="customer-field-error">
                      {errors.insurerId}
                    </p>
                  )}
                  {insurerError && (
                    <p role="alert">
                      {insurerError}{' '}
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => setInsurerLoad((v) => v + 1)}
                      >
                        Şirketleri yeniden yükle
                      </Button>
                    </p>
                  )}
                </div>
                {field('customerNumber', 'Şirket müşteri no (zorunlu)', 100)}
                <CustomerReferenceField
                  membershipId={draft.referenceMembershipId}
                  name={draft.referenceName}
                  onChange={(referenceMembershipId, referenceName) =>
                    setDraft((old) => ({ ...old, referenceMembershipId, referenceName }))
                  }
                />
                {field('email', 'E-posta', undefined, 'email')}
                {field('phone', 'Telefon', 50, 'tel')}
                {field('address', 'Adres', 1000)}
              </div>
            </fieldset>
            <p className="customer-legacy-hint">
              Müşteri no, seçilen sigorta şirketinin verdiği numaradır; elle girilir, başındaki
              sıfırlar korunur. Kurumsal müşteride vergi no da zorunludur. Başka şirketlerin müşteri
              numaraları müşteri kartından eklenebilir. İletişim bilgileri isteğe bağlıdır. Serbest
              metin alanlarına kimlik, sağlık bilgisi veya parola yazmayın.
            </p>
            {error && <p role="alert">{error}</p>}
            {navigationMessage && (
              <p ref={navigationNotice} role="alert" tabIndex={-1}>
                {navigationMessage}
              </p>
            )}
            {busy && <p role="status">Kaydediliyor…</p>}
            <div className="customer-form-actions">
              <Button type="submit" disabled={locked}>
                Müşteriyi kaydet
              </Button>
              <Button type="submit" data-next="policy" variant="outline" disabled={locked}>
                Kaydet ve poliçe ekle
              </Button>
              {pending && (
                <Button variant="outline" disabled={busy} onClick={() => void send(pending)}>
                  Aynı kaydı güvenle yeniden dene
                </Button>
              )}
              <Button asChild variant="ghost">
                <Link to="/customers">Vazgeç ve listeye dön</Link>
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
