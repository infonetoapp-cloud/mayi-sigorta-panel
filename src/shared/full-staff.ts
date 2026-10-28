import { PERMISSION_CATALOG } from './permissions';
export interface DelegatedGrant {
  permission_code: string;
  scope: 'UNSCOPED' | 'ASSIGNED' | 'AGENCY';
}
// Formal OWNER identity, personnel/security administration and management reports are not delegated.
export const NON_DELEGABLE_PERMISSIONS = Object.freeze(['report.management']);
export function fullMemberGrants(): DelegatedGrant[] {
  return PERMISSION_CATALOG.filter((p) => !NON_DELEGABLE_PERMISSIONS.includes(p.code)).map((p) => ({
    permission_code: p.code,
    scope: p.scopeKind === 'UNSCOPED' ? 'UNSCOPED' : 'AGENCY',
  }));
}
export function isFullMember(grants: readonly DelegatedGrant[]): boolean {
  const full = fullMemberGrants();
  return (
    grants.length === full.length &&
    full.every((p) =>
      grants.some((g) => g.permission_code === p.permission_code && g.scope === p.scope),
    )
  );
}
export function selectPermissionGroup(
  current: DelegatedGrant[],
  codes: string[],
): DelegatedGrant[] {
  const map = new Map(current.map((g) => [g.permission_code, { ...g }]));
  const add = (code: string) => {
    if (NON_DELEGABLE_PERMISSIONS.includes(code)) return;
    const p = PERMISSION_CATALOG.find((p) => p.code === code);
    if (!p) return;
    for (const dependency of p.dependencies) add(dependency);
    map.set(code, {
      permission_code: code,
      scope: p.scopeKind === 'UNSCOPED' ? 'UNSCOPED' : 'AGENCY',
    });
  };
  for (const code of codes) add(code);
  return [...map.values()];
}
export function removePermissionGroup(
  current: DelegatedGrant[],
  codes: string[],
): DelegatedGrant[] {
  const removed = new Set(codes);
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of PERMISSION_CATALOG)
      if (!removed.has(p.code) && p.dependencies.some((c) => removed.has(c))) {
        removed.add(p.code);
        changed = true;
      }
  }
  return current.filter((p) => !removed.has(p.permission_code));
}
