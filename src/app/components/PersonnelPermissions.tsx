import { useState } from 'react';
import { PERMISSION_CATALOG } from '../../shared/permissions';
import {
  NON_DELEGABLE_PERMISSIONS,
  selectPermissionGroup,
  removePermissionGroup,
} from '../../shared/full-staff';
export interface Grant {
  permission_code: string;
  scope: 'UNSCOPED' | 'ASSIGNED' | 'AGENCY';
}
export const scopeLabel = (g?: Grant) =>
  !g
    ? 'Yok'
    : g.scope === 'AGENCY'
      ? 'Acente geneli'
      : g.scope === 'ASSIGNED'
        ? 'Atanan kayıtlar'
        : 'Açık';
export function changedGrants(before: Grant[], after: Grant[]) {
  return PERMISSION_CATALOG.filter(
    (p) =>
      before.find((g) => g.permission_code === p.code)?.scope !==
      after.find((g) => g.permission_code === p.code)?.scope,
  );
}
const groups = [
  ['customer', 'Müşteriler'],
  ['policy', 'Poliçeler'],
  ['renewal', 'Yenilemeler'],
  ['quote', 'Teklifler'],
  ['interaction', 'Görüşmeler'],
  ['task', 'Kişisel görevler'],
  ['document', 'Belgeler'],
  ['sensitive', 'Hassas veriler'],
  ['report', 'Raporlar'],
  ['export', 'Dışa aktarma'],
  ['audit', 'Denetim'],
  ['catalog', 'Kataloglar'],
  ['agency', 'Acente ayarları'],
];
export function PermissionComparison({ before, after }: { before: Grant[]; after: Grant[] }) {
  const [all, setAll] = useState(false);
  const changed = changedGrants(before, after);
  return (
    <section className="permission-comparison" aria-label="Mevcut ve önerilen izinler">
      <div className="personnel-section-heading">
        <h3>Değişiklik özeti</h3>
        <span className="personnel-count">{changed.length} değişiklik</span>
      </div>
      <p>Mevcut → önerilen erişim. Değişiklikler Kaydet ile uygulanır.</p>
      <button type="button" className="personnel-text-button" onClick={() => setAll(!all)}>
        {all ? 'Yalnız değişiklikleri göster' : 'Tüm izinleri karşılaştır'}
      </button>
      {!changed.length && !all ? (
        <p className="personnel-muted">İzin değişikliği yok.</p>
      ) : (
        <div
          className="personnel-comparison-scroll"
          role="region"
          aria-label="İzin karşılaştırma tablosu"
          tabIndex={0}
        >
          <table>
            <thead>
              <tr>
                <th>İzin</th>
                <th>Mevcut</th>
                <th>Önerilen</th>
              </tr>
            </thead>
            <tbody>
              {(all ? PERMISSION_CATALOG : changed).map((p) => (
                <tr key={p.code} data-sensitive={p.classification === 'SENSITIVE'}>
                  <th scope="row">{p.title}</th>
                  <td>{scopeLabel(before.find((g) => g.permission_code === p.code))}</td>
                  <td>
                    <strong>{scopeLabel(after.find((g) => g.permission_code === p.code))}</strong>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
export function PermissionEditor({
  grants,
  onChange,
  owner = false,
}: {
  grants: Grant[];
  onChange: (g: Grant[]) => void;
  owner?: boolean;
}) {
  const [query, setQuery] = useState(''),
    [group, setGroup] = useState('all');
  const visible = PERMISSION_CATALOG.filter(
    (p) =>
      (!owner || p.classification === 'SENSITIVE') &&
      (owner || !NON_DELEGABLE_PERMISSIONS.includes(p.code)) &&
      (group === 'all' || p.code.startsWith(group + '.')) &&
      `${p.title} ${p.description}`
        .toLocaleLowerCase('tr-TR')
        .includes(query.toLocaleLowerCase('tr-TR').trim()),
  );
  return (
    <section className="permission-editor" aria-label="İzin düzenleyici">
      <div className="personnel-section-heading">
        <div>
          <h3>İş alanları ve erişim</h3>
          <p>
            {owner
              ? 'Sahibin olağan yetkileri rolünden gelir; burada ek hassas izinler düzenlenir.'
              : 'İzin ve kapsam birlikte değerlendirilir. Önkoşullar otomatik eklenmez.'}
          </p>
        </div>
        <span className="personnel-count">{grants.length} taslak izin kaydı</span>
      </div>
      <label className="personnel-search">
        İzin ara
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Müşteri, belge, kimlik…"
        />
      </label>
      <div className="permission-group-nav" aria-label="İş alanı filtresi">
        <button type="button" aria-pressed={group === 'all'} onClick={() => setGroup('all')}>
          Tümü
        </button>
        {groups
          .filter(([key]) => !owner || key === 'sensitive')
          .map(([key, title]) => (
            <button
              type="button"
              key={key}
              aria-pressed={group === key}
              onClick={() => setGroup(key!)}
            >
              {title}
            </button>
          ))}
      </div>
      {visible.length === 0 && <p role="status">Bu aramada izin bulunamadı.</p>}
      {groups.map(([key, title]) => {
        const rows = visible.filter((p) => p.code.startsWith(key + '.'));
        if (!rows.length) return null;
        return (
          <section
            className="permission-group"
            key={key}
            data-sensitive={key === 'sensitive' || key === 'export' || key === 'audit'}
          >
            <h4>
              {title}
              <span>
                {rows.filter((p) => grants.some((g) => g.permission_code === p.code)).length} /{' '}
                {rows.length}
              </span>
            </h4>
            <div className="permission-group-bulk">
              <button
                type="button"
                aria-label={`${title} grubunu seç`}
                onClick={() =>
                  onChange(
                    selectPermissionGroup(
                      grants,
                      rows.map((p) => p.code),
                    ).filter(
                      (g) =>
                        !owner ||
                        PERMISSION_CATALOG.find((p) => p.code === g.permission_code)
                          ?.classification === 'SENSITIVE',
                    ),
                  )
                }
              >
                Grubu seç
              </button>
              <button
                type="button"
                aria-label={`${title} grubunu kaldır`}
                onClick={() =>
                  onChange(
                    removePermissionGroup(
                      grants,
                      rows.map((p) => p.code),
                    ),
                  )
                }
              >
                Grubu kaldır
              </button>
            </div>
            {key === 'task' && (
              <p className="permission-rule">
                Standart çalışanların görevleri kişiseldir. Ekip Görevlerine Erişim ve ilgili Acente
                Geneli görev izinleri birlikte verilirse diğer çalışanların görevleri açılır. Atama
                ayrıca task/yenileme atama izinlerini gerektirir.
              </p>
            )}
            {rows.map((p) => {
              const grant = grants.find((g) => g.permission_code === p.code);
              return (
                <div className="permission-row" key={p.code}>
                  <label>
                    <input
                      type="checkbox"
                      checked={!!grant}
                      onChange={(e) =>
                        onChange(
                          e.target.checked
                            ? [
                                ...grants,
                                {
                                  permission_code: p.code,
                                  scope: p.scopeKind === 'UNSCOPED' ? 'UNSCOPED' : 'ASSIGNED',
                                },
                              ]
                            : grants.filter((g) => g.permission_code !== p.code),
                        )
                      }
                    />
                    <span>
                      <strong>{p.title}</strong>
                      <small>{p.description}</small>
                      {p.dependencies.length > 0 && (
                        <small className="permission-dependencies">
                          Gerekli:{' '}
                          {p.dependencies
                            .map(
                              (code) =>
                                PERMISSION_CATALOG.find((d) => d.code === code)?.title ??
                                'Tanımsız önkoşul',
                            )
                            .join(' · ')}
                        </small>
                      )}
                    </span>
                  </label>
                  {p.scopeKind === 'RECORD_SCOPED' && grant && (
                    <select
                      aria-label={`${p.title} kapsamı`}
                      value={grant.scope}
                      onChange={(e) =>
                        onChange(
                          grants.map((g) =>
                            g.permission_code === p.code
                              ? { ...g, scope: e.target.value as Grant['scope'] }
                              : g,
                          ),
                        )
                      }
                    >
                      <option value="ASSIGNED">Atanan kayıtlar</option>
                      <option value="AGENCY">Acente geneli</option>
                    </select>
                  )}
                </div>
              );
            })}
          </section>
        );
      })}
    </section>
  );
}
