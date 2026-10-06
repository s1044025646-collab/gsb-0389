export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const fail = (
  code: string,
  message: string,
  status = 400,
  details?: unknown
): never => {
  throw new AppError(code, message, status, details);
};
