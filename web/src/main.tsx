import React from 'react';
import ReactDOM from 'react-dom/client';
import { Notifications } from '@mantine/notifications';
import { ModalsProvider } from '@mantine/modals';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import '@mantine/core/styles.css';
import '@mantine/notifications/styles.css';
import '@mantine/dates/styles.css';
import './styles.css';
import { App } from './App';
import { AuthProvider } from './auth/AuthContext';
import { PanelThemeProvider } from './components/PanelThemeProvider';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 10_000 } },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <PanelThemeProvider>
      <Notifications position="top-right" limit={4} autoClose={4000} />
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <AuthProvider>
            <ModalsProvider labels={{ confirm: 'Confirmar', cancel: 'Cancelar' }}>
              <App />
            </ModalsProvider>
          </AuthProvider>
        </BrowserRouter>
      </QueryClientProvider>
    </PanelThemeProvider>
  </React.StrictMode>,
);
