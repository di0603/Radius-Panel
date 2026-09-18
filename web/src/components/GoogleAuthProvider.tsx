import { GoogleOAuthProvider } from '@react-oauth/google';
import type { ReactNode } from 'react';

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;

/**
 * Envuelve con GoogleOAuthProvider solo si hay client ID configurado, para no
 * intentar cargar el script de Google en instalaciones que no usan ese login.
 */
export function GoogleAuthProvider({ children }: { children: ReactNode }) {
  if (!GOOGLE_CLIENT_ID) return <>{children}</>;
  return <GoogleOAuthProvider clientId={GOOGLE_CLIENT_ID}>{children}</GoogleOAuthProvider>;
}
