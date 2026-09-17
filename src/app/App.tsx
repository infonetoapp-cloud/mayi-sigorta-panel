import React from 'react';
import { APP_NAME } from '../shared/constants';

export const App: React.FC = () => {
  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#f8fafc',
        color: '#0f172a',
        fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        padding: '1.5rem',
      }}
    >
      <div
        style={{
          maxWidth: '32rem',
          width: '100%',
          backgroundColor: '#ffffff',
          borderRadius: '0.75rem',
          border: '1px solid #e2e8f0',
          boxShadow: '0 1px 3px 0 rgba(0, 0, 0, 0.05)',
          padding: '2rem',
          textAlign: 'center',
        }}
      >
        <h1
          style={{
            fontSize: '1.5rem',
            fontWeight: 700,
            letterSpacing: '-0.025em',
            margin: '0 0 0.5rem 0',
            color: '#0f172a',
          }}
        >
          {APP_NAME}
        </h1>
        <p
          style={{
            fontSize: '0.875rem',
            color: '#64748b',
            margin: '0 0 1.5rem 0',
          }}
        >
          Yönetim Paneli ve İş Akışı Sistemi
        </p>

        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.5rem',
            padding: '0.375rem 0.875rem',
            borderRadius: '9999px',
            backgroundColor: '#f1f5f9',
            border: '1px solid #cbd5e1',
            fontSize: '0.8125rem',
            color: '#334155',
            fontWeight: 500,
          }}
        >
          <span
            style={{
              width: '0.5rem',
              height: '0.5rem',
              borderRadius: '9999px',
              backgroundColor: '#10b981',
            }}
          />
          <span>Sistem Temeli Aktif (M1-T01)</span>
        </div>
      </div>
    </main>
  );
};
