import { Skeleton, Table } from '@mantine/core';

/** Filas fantasma mientras carga una tabla: evita el salto de altura del spinner. */
export function TableSkeleton({ rows = 6, cols }: { rows?: number; cols: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, r) => (
        <Table.Tr key={r}>
          {Array.from({ length: cols }).map((_, c) => (
            <Table.Td key={c}>
              <Skeleton height={14} radius="sm" width={c === 0 ? '60%' : '80%'} />
            </Table.Td>
          ))}
        </Table.Tr>
      ))}
    </>
  );
}
