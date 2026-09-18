import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { ApiError } from '../lib/http.js';

export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({ error: 'Ruta no encontrada' });
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ZodError) {
    res.status(400).json({ error: 'Datos invalidos', details: err.flatten() });
    return;
  }
  if (err instanceof ApiError) {
    res.status(err.status).json({ error: err.message, details: err.details });
    return;
  }
  const e = err as { code?: string; sqlMessage?: string };
  if (e?.code === 'ER_DUP_ENTRY') {
    res.status(409).json({ error: 'Registro duplicado', details: e.sqlMessage });
    return;
  }
  console.error(`[error] req=${req.id ?? '-'}`, err);
  res.status(500).json({ error: 'Error interno del servidor', requestId: req.id });
}
