import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * Sincroniza un valor de estado con un parametro de la query string, para que
 * los filtros se puedan compartir por URL y sobrevivan a un refresco.
 */
export function useUrlState(key: string, fallback = ''): [string, (value: string) => void] {
  const [params, setParams] = useSearchParams();
  const value = params.get(key) ?? fallback;

  const setValue = useCallback(
    (next: string) => {
      setParams(
        (prev) => {
          const p = new URLSearchParams(prev);
          if (next === '' || next === fallback) p.delete(key);
          else p.set(key, next);
          return p;
        },
        { replace: true },
      );
    },
    [key, fallback, setParams],
  );

  return [value, setValue];
}
