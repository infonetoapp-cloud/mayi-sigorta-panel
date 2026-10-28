import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { z } from 'zod';
import type { ApiResponse, CustomerDto, CustomerType } from '../../../shared/types';
import { getCsrfToken, invalidateCsrfToken, parseAppError } from '../../App';
import { PageHeader } from '../../components/layout/PageContainer';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { NavigationDecision } from '../../components/layout/NavigationDecision';
import { registerQuotePopGuard } from '../today-work/quote-navigation';
import './customer360.css';

const initial = {
  firstName: '',
  lastName: '',
  companyTitle: '',
  email: '',
  phone: '',
  address: '',
};
type Fields = typeof initial;
interface Attempt {
  body: string;
  key: string;
}
export default function CustomerCreatePage() {
  const navigate = useNavigate();
  const [type, setType] = useState<CustomerType>('INDIVIDUAL');
  const [draft, setDraft] = useState(initial);
  const [errors, setErrors] = useState<Partial<Fields>>({});
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
    const logout = (event: Event) => {
      if (!atRisk()) return;
      event.preventDefault();
      attention();
      if (frozen()) return hold();
      const proceed = (event as CustomEvent<{ proceed?: () => void }>).detail?.proceed;
      if (typeof proceed === 'function') setLeave(() => proceed);
    };
    document.addEventListener('click', click, true);
    document.addEventListener('mayi-logout-requested', logout);
    addEventListener('beforeunload', unload);
    const removePopGuard = registerQuotePopGuard(pop);
    return () => {
      document.removeEventListener('click', click, true);
      document.removeEventListener('mayi-logout-requested', logout);
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
        setPending(null);
        setBlocked([403, 404, 409].includes(response.status));
        setError(
          response.status === 409
            ? 'Kayıt isteği çakıştı veya daha önce işlendi. Yeni kayıt göndermeden müşteri listesini kontrol edin.'
            : info.message,
        );
        attempt.current = null;
        return;
      }
      if (!envelope?.success || typeof envelope.data?.id !== 'string' || !envelope.data.id)
        throw new Error('UNCERTAIN');
      created.current = true;
      void navigate(`/customers/${encodeURIComponent(envelope.data.id)}`, { replace: true });
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
    if (values.email && !z.email().safeParse(values.email).success)
      invalid.email = 'Geçerli bir e-posta adresi girin.';
    if (values.phone.length > 50) invalid.phone = 'Telefon en fazla 50 karakter olabilir.';
    if (values.address.length > 1000) invalid.address = 'Adres en fazla 1000 karakter olabilir.';
    setErrors(invalid);
    setError('');
    if (Object.keys(invalid).length) return;
    const body = JSON.stringify({
      type,
      ...(type === 'INDIVIDUAL'
        ? { firstName: values.firstName, lastName: values.lastName }
        : { companyTitle: values.companyTitle }),
      email: values.email || null,
      phone: values.phone || null,
      address: values.address || null,
    });
    const snapshot =
      attempt.current?.body === body ? attempt.current : { body, key: crypto.randomUUID() };
    attempt.current = snapshot;
    void send(snapshot);
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
          onChange={(event) =>
            setDraft((previous) => ({ ...previous, [name]: event.target.value }))
          }
        />
      ) : (
        <Input
          id={`new-${name}`}
          type={inputType}
          value={draft[name]}
          maxLength={maximum}
          aria-invalid={!!errors[name]}
          aria-describedby={errors[name] ? `error-${name}` : undefined}
          onChange={(event) =>
            setDraft((previous) => ({ ...previous, [name]: event.target.value }))
          }
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
    <div className="customer-modern customer360 customer360-create">
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
                  </>
                ) : (
                  field('companyTitle', 'Şirket unvanı', 255)
                )}
                {field('email', 'E-posta', undefined, 'email')}
                {field('phone', 'Telefon', 50, 'tel')}
                {field('address', 'Adres', 1000)}
              </div>
            </fieldset>
            <p className="customer-legacy-hint">
              Ad ve soyad veya şirket unvanı zorunludur. İletişim bilgileri isteğe bağlıdır. Bu
              forma kimlik numarası, sağlık bilgisi veya parola yazmayın.
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
