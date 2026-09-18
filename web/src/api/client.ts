import axios, { AxiosError, type InternalAxiosRequestConfig } from 'axios';

/**
 * El access token vive solo en memoria: no se guarda en localStorage para que
 * un XSS no pueda robarlo. La sesion persiste mediante el refresh token, que
 * viaja en una cookie HttpOnly que JavaScript no puede leer.
 */
let accessToken: string | null = null;

export function getToken(): string | null {
  return accessToken;
}

export function setToken(token: string | null): void {
  accessToken = token;
}

export const api = axios.create({ baseURL: '/api', withCredentials: true });

api.interceptors.request.use((config) => {
  if (accessToken) config.headers.Authorization = `Bearer ${accessToken}`;
  return config;
});

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

/** Rutas que nunca deben disparar un intento de renovacion. */
const NO_REFRESH = ['/auth/login', '/auth/login/2fa', '/auth/refresh', '/auth/logout'];

interface RetriableRequest extends InternalAxiosRequestConfig {
  _retried?: boolean;
}

/**
 * Renueva el access token. Si llegan varias peticiones con 401 a la vez,
 * todas esperan a la misma llamada en vez de lanzar una renovacion cada una.
 */
let refreshing: Promise<string | null> | null = null;

export function refreshSession(): Promise<string | null> {
  if (!refreshing) {
    refreshing = axios
      .post<{ token: string }>('/api/auth/refresh', null, { withCredentials: true })
      .then((res) => {
        setToken(res.data.token);
        return res.data.token;
      })
      .catch(() => {
        setToken(null);
        return null;
      })
      .finally(() => {
        refreshing = null;
      });
  }
  return refreshing;
}

api.interceptors.response.use(
  (res) => res,
  async (error: AxiosError) => {
    const original = error.config as RetriableRequest | undefined;
    const url = original?.url ?? '';
    const isAuthCall = NO_REFRESH.some((path) => url.includes(path));

    if (error.response?.status === 401 && original && !original._retried && !isAuthCall) {
      original._retried = true;
      const token = await refreshSession();
      if (token) {
        original.headers.Authorization = `Bearer ${token}`;
        return api(original);
      }
      onUnauthorized?.();
    } else if (error.response?.status === 401 && isAuthCall && url.includes('/auth/refresh')) {
      onUnauthorized?.();
    }

    return Promise.reject(error);
  },
);

export function apiErrorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    return (error.response?.data as { error?: string })?.error ?? error.message ?? 'Error de red';
  }
  return error instanceof Error ? error.message : 'Error desconocido';
}
