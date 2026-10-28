import { PERMISSION_CATALOG } from '../../shared/permissions';
import { fullMemberGrants, isFullMember } from '../../shared/full-staff';
import type { Grant } from './PersonnelPermissions';
export function PersonnelBulk({
  grants,
  onChange,
  owner = false,
}: {
  grants: Grant[];
  onChange: (g: Grant[]) => void;
  owner?: boolean;
}) {
  return (
    <div className="personnel-bulk-actions">
      <div>
        <strong>
          {!owner && isFullMember(grants) ? 'Tam yetki taslağı' : 'Özel erişim taslağı'}
        </strong>
        <small>
          {grants.length} izin kaydı · {grants.filter((g) => g.scope === 'AGENCY').length} acente
          geneli kapsam
        </small>
      </div>
      <button
        type="button"
        className="personnel-primary"
        onClick={() =>
          onChange(
            owner
              ? PERMISSION_CATALOG.filter((p) => p.classification === 'SENSITIVE').map((p) => ({
                  permission_code: p.code,
                  scope: 'UNSCOPED',
                }))
              : fullMemberGrants(),
          )
        }
      >
        {owner ? 'Tüm hassas izinleri seç' : 'Tam Yetki Ver'}
      </button>
      <button type="button" onClick={() => onChange([])}>
        Tümünü Kaldır
      </button>
      <p>
        {owner
          ? 'Sahibin rol kaynaklı olağan yetkileri kaldırılamaz.'
          : 'En geniş devredilebilir erişim. Sahiplik, personel/güvenlik yönetimi ve yönetim raporları verilmez. Kaydetmeden erişim değişmez.'}
      </p>
    </div>
  );
}
