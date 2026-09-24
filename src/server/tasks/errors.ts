export class TaskNotFoundError extends Error {}
export class TaskForbiddenError extends Error {}
export class TaskReplayNotAuthorizedError extends Error {}

export class TaskValidationError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

export class TaskConstraintError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
