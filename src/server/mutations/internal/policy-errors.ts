export class PolicyConstraintError extends Error {
  constructor(
    readonly code: string,
    message = code,
  ) {
    super(message);
    this.name = 'PolicyConstraintError';
  }
}

export class PolicyAuthorizationRaceError extends Error {
  constructor() {
    super('FINAL_AUTHORITY_RECHECK_FAILED');
    this.name = 'PolicyAuthorizationRaceError';
  }
}
