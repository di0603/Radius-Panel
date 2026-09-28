import { Badge, Button, Code, Group, Skeleton, Stack, Text } from '@mantine/core';
import { modals } from '@mantine/modals';
import { IconKey } from '@tabler/icons-react';
import { PageHeader } from '../components/PageHeader';
import { SectionCard } from '../components/SectionCard';
import { useGenerateGatewayToken, useVpnSettings } from '../api/hooks';
import { notifyError, notifyOk } from '../lib/notify';

/**
 * Ajustes del modulo VPN. De momento solo el token de la puerta de enlace
 * del firewall (GET /vpn/gateway/firewall.nft); el resto de ajustes
 * (FQDN, identidad AAA, rango de IPs...) se siguen editando solo en base de
 * datos hasta que exista una pagina completa (ver ideas.md).
 */
export function VpnSettingsPage() {
  const settings = useVpnSettings();
  const generateToken = useGenerateGatewayToken();

  const runGenerateToken = () => {
    modals.openConfirmModal({
      title: settings.data?.gatewayTokenSet
        ? 'Regenerar el token de la puerta de enlace'
        : 'Generar el token de la puerta de enlace',
      children: (
        <Text size="sm">
          {settings.data?.gatewayTokenSet
            ? 'Esto invalida el token actual: hay que actualizar la configuracion de deploy/vpn-gateway-agent en la VM VPN con el nuevo antes de que caduque el que tiene ahora mismo (o dejara de poder descargar el firewall).'
            : 'Lo necesita deploy/vpn-gateway-agent en la VM VPN (192.168.10.29) para descargar el firewall generado.'}
        </Text>
      ),
      labels: { confirm: 'Generar', cancel: 'Cancelar' },
      onConfirm: async () => {
        try {
          const result = await generateToken.mutateAsync();
          modals.open({
            title: 'Token generado',
            size: 'lg',
            closeOnClickOutside: false,
            children: (
              <Stack>
                <Text size="sm" c="dimmed">
                  Se ensena una unica vez: cópialo ahora y pegalo en{' '}
                  <Code>/etc/vpn-gateway-agent/config.sh</Code> en la VM VPN (variable{' '}
                  <Code>GATEWAY_TOKEN</Code>).
                </Text>
                <Code block style={{ wordBreak: 'break-all' }}>
                  {result.token}
                </Code>
                <Group justify="flex-end">
                  <Button
                    onClick={() => {
                      navigator.clipboard?.writeText(result.token);
                      notifyOk('Copiado');
                    }}
                  >
                    Copiar
                  </Button>
                </Group>
              </Stack>
            ),
          });
        } catch (err) {
          notifyError(err);
        }
      },
    });
  };

  return (
    <Stack gap="lg">
      <PageHeader title="Ajustes VPN" subtitle="panel_vpn_settings" />

      <SectionCard
        title="Puerta de enlace del firewall"
        subtitle="Autentica GET /vpn/gateway/firewall.nft, que descarga deploy/vpn-gateway-agent en la VM VPN"
      >
        {settings.isLoading ? (
          <Skeleton height={40} />
        ) : (
          <Group justify="space-between">
            <Group gap="xs">
              <Text size="sm">Token:</Text>
              {settings.data?.gatewayTokenSet ? (
                <Badge color="teal" variant="light">
                  generado
                </Badge>
              ) : (
                <Badge color="yellow" variant="light">
                  sin generar
                </Badge>
              )}
            </Group>
            <Button
              leftSection={<IconKey size={16} />}
              variant="light"
              loading={generateToken.isPending}
              onClick={runGenerateToken}
            >
              {settings.data?.gatewayTokenSet ? 'Regenerar token' : 'Generar token'}
            </Button>
          </Group>
        )}
      </SectionCard>
    </Stack>
  );
}
