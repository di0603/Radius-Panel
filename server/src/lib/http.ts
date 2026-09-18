import type { NextFunction, Request, Response } from 'express';

/** Error con codigo HTTP explicito; lo captura el middleware de errores. */
export class ApiError extends Error {
  status: number;
  details?: unknown;
  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const badRequest = (msg: string, details?: unknown) => new ApiError(400, msg, details);
export const unauthorized = (msg = 'No autenticado') => new ApiError(401, msg);
export const forbidden = (msg = 'Sin permisos') => new ApiError(403, msg);
export const notFound = (msg = 'No encontrado') => new ApiError(404, msg);
export const conflict = (msg: string) => new ApiError(409, msg);
/** 423 Locked: cuenta bloqueada temporalmente por intentos fallidos. */
export const locked = (msg: string) => new ApiError(423, msg);
export const tooManyRequests = (msg: string) => new ApiError(429, msg);

/** Envuelve un handler async para que los rejects lleguen a next(). */
export function asyncHandler<T extends Request>(
  fn: (req: T, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req as T, res, next).catch(next);
  };
}
