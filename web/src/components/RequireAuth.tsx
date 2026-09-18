import { Center, Loader } from '@mantine/core';
import { Navigate, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAuth } from '../auth/AuthContext';
import { ForbiddenPage } from '../pages/NotFound';
import type { Role } from '../api/types';

export function RequireAuth({ children, roles }: { children: ReactNode; roles?: Role[] }) {
  const { user, loading, hasRole } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <Center h="100vh">
        <Loader />
      </Center>
    );
  }
  if (!user) return <Navigate to="/login" replace state={{ from: location }} />;
  if (roles && !hasRole(...roles)) return <ForbiddenPage />;
  return <>{children}</>;
}
