export class RenewalCommandError extends Error {
  readonly code: string;
  readonly status: 400 | 403 | 404 | 409 | 500;

  constructor(code: string, status: 400 | 403 | 404 | 409 | 500 = 409) {
    super(code);
    this.name = 'RenewalCommandError';
    this.code = code;
    this.status = status;
  }
}

export function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}
