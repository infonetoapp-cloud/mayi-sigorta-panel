export function modernCompatibilityTarget(
  kind: 'customers' | 'policies' | 'today-work',
  search: string,
): string | null {
  const params = new URLSearchParams(search);
  if (['task', 'queue', 'work'].some((key) => params.getAll(key).length > 1)) return null;
  const customer = params.get('customerId'),
    policy = params.get('policyId');
  if (
    params.getAll('customerId').length > 1 ||
    params.getAll('policyId').length > 1 ||
    (customer && policy)
  )
    return null;
  if (kind === 'customers')
    return customer ? `/customers/${encodeURIComponent(customer)}/manage` : '/customers';
  if (kind === 'policies') {
    if (policy) return `/policies/${encodeURIComponent(policy)}`;
    if (customer) return `/policies/new?${new URLSearchParams({ customerId: customer })}`;
    const allowed = new URLSearchParams();
    for (const key of ['search', 'searchMode', 'status', 'insurerId', 'endFrom', 'endTo', 'sort'])
      if (params.has(key)) allowed.set(key, params.get(key)!);
    return '/policies' + (allowed.size ? '?' + allowed : '');
  }
  const allowed = new URLSearchParams();
  for (const key of ['task', 'queue', 'work'])
    if (params.has(key)) allowed.set(key, params.get(key)!);
  return '/today-work' + (allowed.size ? '?' + allowed : '');
}
