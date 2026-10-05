import { Alert, Select, Stack, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useVpnProfiles, type AccessProfile } from '../api/hooks';

interface Props {
  value: AccessProfile;
  onChange: (value: AccessProfile) => void;
  label?: string;
  disabled?: boolean;
}

/**
 * Selector del perfil de acceso de un dispositivo VPN, con la descripcion del
 * perfil elegido y un aviso en rojo en los perfiles que llegan a
 * infraestructura (lan_full e internet_lan_full). Los textos vienen del
 * servidor (GET /vpn-profiles), una unica fuente de verdad.
 */
export function AccessProfileSelect({
  value,
  onChange,
  label = 'Perfil de acceso',
  disabled,
}: Props) {
  const profiles = useVpnProfiles();
  const info = profiles.data?.profiles.find((p) => p.profile === value);

  return (
    <Stack gap="xs">
      <Select
        label={label}
        data={(profiles.data?.profiles ?? []).map((p) => ({ value: p.profile, label: p.label }))}
        value={value}
        onChange={(v) => v && onChange(v as AccessProfile)}
        allowDeselect={false}
        disabled={disabled || !profiles.data}
      />
      {info && (
        <Text size="xs" c="dimmed">
          {info.description}
        </Text>
      )}
      {info?.infrastructureAccess && (
        <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />} p="xs">
          <Text size="sm" fw={600}>
            {profiles.data?.infrastructureWarning}
          </Text>
        </Alert>
      )}
    </Stack>
  );
}
