import {
  ActionIcon,
  Autocomplete,
  Button,
  Group,
  Select,
  Table,
  Text,
  TextInput,
} from '@mantine/core';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import { useDictionary } from '../api/hooks';
import type { AttrRow } from '../api/types';

const CHECK_OPS = ['==', ':=', '+=', '!=', '>', '>=', '<', '<='];
const REPLY_OPS = ['=', ':=', '+='];

function isIpv4(v: string): boolean {
  const p = v.split('.');
  return p.length === 4 && p.every((n) => /^\d+$/.test(n) && +n >= 0 && +n <= 255);
}

interface Props {
  kind: 'check' | 'reply';
  rows: AttrRow[];
  onChange: (rows: AttrRow[]) => void;
  hiddenAttributes?: string[];
}

export function AttributeEditor({ kind, rows, onChange, hiddenAttributes = [] }: Props) {
  const ops = kind === 'check' ? CHECK_OPS : REPLY_OPS;
  const dict = useDictionary();
  const defs = dict.data?.defs ?? {};
  const suggestions = dict.data?.attributes ?? [];

  const visible = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => !hiddenAttributes.includes(row.attribute));

  const update = (index: number, patch: Partial<AttrRow>) =>
    onChange(rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  const remove = (index: number) => onChange(rows.filter((_, i) => i !== index));
  const add = () =>
    onChange([...rows, { attribute: '', op: kind === 'check' ? '==' : '=', value: '' }]);

  const validate = (attribute: string, value: string): string | null => {
    const def = defs[attribute];
    if (!def || value === '') return null;
    if (def.type === 'integer' && !/^-?\d+$/.test(value)) return 'Debe ser un entero';
    if (def.type === 'ipaddr' && value !== 'auto' && !isIpv4(value)) return 'IPv4 no valida';
    if (def.type === 'enum' && def.values && !def.values.includes(value))
      return `Valores: ${def.values.join(', ')}`;
    return null;
  };

  return (
    <div>
      <Table withRowBorders={false} verticalSpacing="xs">
        <Table.Tbody>
          {visible.map(({ row, index }) => {
            const def = defs[row.attribute];
            const err = validate(row.attribute, row.value);
            return (
              <Table.Tr key={index}>
                <Table.Td w="42%">
                  <Autocomplete
                    placeholder="Atributo"
                    data={suggestions}
                    value={row.attribute}
                    onChange={(v) => update(index, { attribute: v })}
                    comboboxProps={{ withinPortal: true }}
                  />
                </Table.Td>
                <Table.Td w="14%">
                  <Select
                    data={ops}
                    value={row.op}
                    onChange={(v) => update(index, { op: v ?? ops[0] })}
                    allowDeselect={false}
                    comboboxProps={{ withinPortal: true }}
                  />
                </Table.Td>
                <Table.Td>
                  {def?.type === 'enum' && def.values ? (
                    <Select
                      data={def.values}
                      value={row.value}
                      placeholder="Valor"
                      onChange={(v) => update(index, { value: v ?? '' })}
                      comboboxProps={{ withinPortal: true }}
                    />
                  ) : (
                    <TextInput
                      placeholder={def?.note ?? 'Valor'}
                      value={row.value}
                      onChange={(e) => update(index, { value: e.currentTarget.value })}
                      error={err ?? undefined}
                    />
                  )}
                </Table.Td>
                <Table.Td w={40}>
                  <ActionIcon variant="subtle" color="red" onClick={() => remove(index)}>
                    <IconTrash size={16} />
                  </ActionIcon>
                </Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>
      {!visible.length && (
        <Text size="sm" c="dimmed" mb="xs">
          Sin atributos.
        </Text>
      )}
      <Group mt="xs">
        <Button size="xs" variant="light" leftSection={<IconPlus size={14} />} onClick={add}>
          Anadir atributo
        </Button>
      </Group>
    </div>
  );
}
