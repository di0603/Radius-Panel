import { MantineProvider } from '@mantine/core';
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { DEFAULT_ACCENT, createPanelTheme, cssVariablesResolver, findAccent } from '../theme';

const STORAGE_KEY = 'radius-panel-accent';

interface AccentState {
  accent: string;
  setAccent: (id: string) => void;
}

const AccentContext = createContext<AccentState | null>(null);

/**
 * Envuelve a MantineProvider para poder cambiar el color de acento en caliente:
 * el tema se reconstruye cuando cambia y se guarda en localStorage. El esquema
 * claro/oscuro/sistema lo gestiona Mantine por su cuenta.
 */
export function PanelThemeProvider({ children }: { children: ReactNode }) {
  const [accent, setAccentState] = useState<string>(() => {
    try {
      return findAccent(localStorage.getItem(STORAGE_KEY)).id;
    } catch {
      return DEFAULT_ACCENT;
    }
  });

  const setAccent = useCallback((id: string) => {
    const valid = findAccent(id).id;
    setAccentState(valid);
    try {
      localStorage.setItem(STORAGE_KEY, valid);
    } catch {
      /* modo privado: el acento solo dura esta sesion */
    }
  }, []);

  const theme = useMemo(() => createPanelTheme(accent), [accent]);
  const value = useMemo(() => ({ accent, setAccent }), [accent, setAccent]);

  return (
    <AccentContext.Provider value={value}>
      <MantineProvider
        theme={theme}
        cssVariablesResolver={cssVariablesResolver}
        defaultColorScheme="auto"
      >
        {children}
      </MantineProvider>
    </AccentContext.Provider>
  );
}

export function useAccent(): AccentState {
  const ctx = useContext(AccentContext);
  if (!ctx) throw new Error('useAccent debe usarse dentro de <PanelThemeProvider>');
  return ctx;
}
