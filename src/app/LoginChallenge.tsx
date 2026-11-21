import { useEffect, useRef, useState } from 'react';

interface Turnstile {
  render(
    container: HTMLElement,
    options: {
      sitekey: string;
      action: string;
      language: string;
      size: 'normal' | 'compact';
      'response-field': false;
      callback: (token: string) => void;
      'expired-callback': () => void;
      'error-callback': () => boolean;
      'timeout-callback': () => void;
    },
  ): string;
  remove(id: string): void;
}

declare const turnstile: Turnstile | undefined;
const turnstileApi = () => (typeof turnstile === 'undefined' ? undefined : turnstile);
let loading: Promise<Turnstile> | undefined;

function loadTurnstile(): Promise<Turnstile> {
  const available = turnstileApi();
  if (available) return Promise.resolve(available);
  loading ??= new Promise<Turnstile>((resolve, reject) => {
    const script = document.createElement('script');
    const fail = () => {
      clearTimeout(timeout);
      script.remove();
      reject(new Error('TURNSTILE_SCRIPT_UNAVAILABLE'));
    };
    const timeout = setTimeout(fail, 15_000);
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    script.onerror = fail;
    script.onload = () => {
      const api = turnstileApi();
      if (api) {
        clearTimeout(timeout);
        resolve(api);
      } else fail();
    };
    document.head.appendChild(script);
  }).catch((error: unknown) => {
    loading = undefined;
    throw error;
  });
  return loading;
}

export function LoginChallenge({
  siteKey,
  onToken,
}: {
  siteKey: string;
  onToken: (token: string | null) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const node = container.current;
    if (!node) return;
    let active = true;
    let remove: (() => void) | undefined;
    const fail = () => {
      if (!active) return;
      onToken(null);
      setFailed(true);
    };
    void loadTurnstile()
      .then((api) => {
        if (!active) return;
        const id = api.render(node, {
          sitekey: siteKey,
          action: 'crm_login',
          language: 'tr',
          size: node.clientWidth < 300 ? 'compact' : 'normal',
          'response-field': false,
          callback: (token) => {
            if (active) {
              setFailed(false);
              onToken(token);
            }
          },
          'expired-callback': () => {
            if (active) onToken(null);
          },
          'error-callback': () => {
            fail();
            return true;
          },
          'timeout-callback': fail,
        });
        remove = () => api.remove(id);
      })
      .catch(fail);
    return () => {
      active = false;
      remove?.();
    };
  }, [siteKey, onToken, retry]);

  return (
    <div className="auth-login-challenge">
      <div ref={container} aria-label="Robot doğrulaması" />
      {failed && (
        <>
          <p role="alert">Robot doğrulaması yüklenemedi.</p>
          <button
            type="button"
            onClick={() => {
              setFailed(false);
              setRetry((value) => value + 1);
            }}
          >
            Doğrulamayı yeniden yükle
          </button>
        </>
      )}
    </div>
  );
}
