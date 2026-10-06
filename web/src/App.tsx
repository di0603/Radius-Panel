import { Navigate, Route, Routes } from 'react-router-dom';
import { AppLayout } from './components/AppLayout';
import { RequireAuth } from './components/RequireAuth';
import { LoginPage } from './pages/Login';
import { DashboardPage } from './pages/Dashboard';
import { UsersPage } from './pages/Users';
import { GroupsPage } from './pages/Groups';
import { SessionsPage } from './pages/Sessions';
import { NasPage } from './pages/Nas';
import { AdminsPage } from './pages/Admins';
import { AuditPage } from './pages/Audit';
import { AccountPage } from './pages/Account';
import { ReportsPage } from './pages/Reports';
import { PkiPage } from './pages/Pki';
import { VpnDevicesPage } from './pages/VpnDevices';
import { VpnSettingsPage } from './pages/VpnSettings';
import { VpnProfilesPage } from './pages/VpnProfiles';
import { NotFoundPage } from './pages/NotFound';

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        element={
          <RequireAuth>
            <AppLayout />
          </RequireAuth>
        }
      >
        <Route path="/" element={<DashboardPage />} />
        <Route path="/users" element={<UsersPage />} />
        <Route path="/groups" element={<GroupsPage />} />
        <Route path="/sessions" element={<SessionsPage />} />
        <Route path="/nas" element={<NasPage />} />
        <Route
          path="/admins"
          element={
            <RequireAuth roles={['admin']}>
              <AdminsPage />
            </RequireAuth>
          }
        />
        <Route
          path="/audit"
          element={
            <RequireAuth roles={['admin']}>
              <AuditPage />
            </RequireAuth>
          }
        />
        <Route
          path="/pki"
          element={
            <RequireAuth roles={['admin']}>
              <PkiPage />
            </RequireAuth>
          }
        />
        <Route
          path="/vpn-devices"
          element={
            <RequireAuth roles={['admin']}>
              <VpnDevicesPage />
            </RequireAuth>
          }
        />
        <Route
          path="/vpn-profiles"
          element={
            <RequireAuth roles={['admin']}>
              <VpnProfilesPage />
            </RequireAuth>
          }
        />
        <Route
          path="/vpn-settings"
          element={
            <RequireAuth roles={['admin']}>
              <VpnSettingsPage />
            </RequireAuth>
          }
        />
        <Route path="/reports" element={<ReportsPage />} />
        <Route path="/account" element={<AccountPage />} />
        <Route path="/dashboard" element={<Navigate to="/" replace />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
