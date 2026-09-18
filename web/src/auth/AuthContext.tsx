import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api, refreshSession, setToken, setUnauthorizedHandler } from '../api/client';
import type { AuthUser, Role } from '../api/types';

export type LoginResult = { status: 'ok' } | { status: '2fa'; ticket: string };

interface AuthState {
  user: AuthUser | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<LoginResult>;
  loginWith2fa: (ticket: string, code: string) => Promise<void>;
  loginWithGoogle: (credential: string) => Promise<LoginResult>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
  hasRole: (...roles: Role[]) => boolean;
}

interface LoginResponse {
  token?: string;
  user?: AuthUser;
  twoFactorRequired?: boolean;
  ticket?: string;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null));
  }, []);

  /**
   * Al cargar la pagina no hay access token (vive en memoria), pero puede haber
   * cookie de refresco: se intenta renovar y, si funciona, se recupera la sesion.
   */
  useEffect(() => {
    let cancelled = false;
    refreshSession()
      .then(async (token) => {
        if (cancelled || !token) return;
        const res = await api.get<{ user: AuthUser }>('/auth/me');
        if (!cancelled) setUser(res.data.user);
      })
      .catch(() => setToken(null))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (username: string, password: string): Promise<LoginResult> => {
    const res = await api.post<LoginResponse>('/auth/login', { username, password });
    if (res.data.twoFactorRequired && res.data.ticket) {
      return { status: '2fa', ticket: res.data.ticket };
    }
    setToken(res.data.token ?? null);
    setUser(res.data.user ?? null);
    return { status: 'ok' };
  }, []);

  const loginWith2fa = useCallback(async (ticket: string, code: string) => {
    const res = await api.post<LoginResponse>('/auth/login/2fa', { ticket, code });
    setToken(res.data.token ?? null);
    setUser(res.data.user ?? null);
  }, []);

  const loginWithGoogle = useCallback(async (credential: string): Promise<LoginResult> => {
    const res = await api.post<LoginResponse>('/auth/google', { credential });
    if (res.data.twoFactorRequired && res.data.ticket) {
      return { status: '2fa', ticket: res.data.ticket };
    }
    setToken(res.data.token ?? null);
    setUser(res.data.user ?? null);
    return { status: 'ok' };
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } catch {
      /* si el servidor no responde, al menos limpiamos el estado local */
    }
    setToken(null);
    setUser(null);
  }, []);

  const refreshUser = useCallback(async () => {
    const res = await api.get<{ user: AuthUser }>('/auth/me');
    setUser(res.data.user);
  }, []);

  const hasRole = useCallback(
    (...roles: Role[]) => (user ? roles.includes(user.role) : false),
    [user],
  );

  const value = useMemo(
    () => ({ user, loading, login, loginWith2fa, loginWithGoogle, logout, refreshUser, hasRole }),
    [user, loading, login, loginWith2fa, loginWithGoogle, logout, refreshUser, hasRole],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth debe usarse dentro de <AuthProvider>');
  return ctx;
}
