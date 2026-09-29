import QRCode from 'qrcode';
import { conflict } from '../lib/http.js';
import { isProfileSigningConfigured, signProfilePayload, type SignedProfileEnvelope } from '../lib/vpnProfileSigning.js';
import { getCaChainPem } from './pki.js';
import { getVpnSettings } from './vpnSettings.js';

/**
 * Perfil de aprovisionamiento (.didevvpn) de un dispositivo: se construye al
 * generar su token de alta (services/vpnDevices.ts:generateEnrollToken) y se
 * entrega una unica vez, igual que el propio token -de hecho lo lleva
 * dentro-. Firmado con Ed25519 (lib/vpnProfileSigning.ts) para que una app
 * nunca acepte un perfil que no venga de este panel.
 */

export const PROFILE_SCHEMA_VERSION = 1;

/**
 * Mismas propuestas IKE/ESP que ya usa el resto del modulo (paquete de
 * conexion Linux/Windows, ver services/vpnClientPackages.ts, y el lado
 * strongSwan real): ECDSA P-384, AES-256-GCM, SHA-384. En sintaxis
 * strongSwan (la fuente de verdad, ya que el servidor es strongSwan) en vez
 * de una ya traducida a la API de una plataforma concreta -cada app la
 * traduce a su propia convencion (p.ej. Windows: GCMAES256/SHA384/ECP384).
 */
export const IKE_PROPOSAL = { encryption: 'aes256gcm16', prf: 'sha384', dhGroup: 'ecp384' } as const;
export const ESP_PROPOSAL = { encryption: 'aes256gcm16', dhGroup: 'ecp384' } as const;

export interface ProvisioningProfilePayload {
  version: number;
  cn: string;
  server: string;
  aaaId: string;
  caChainPem: string;
  ike: typeof IKE_PROPOSAL;
  esp: typeof ESP_PROPOSAL;
  tunnelMode: 'full' | 'split';
  /** Vacio en modo "full" (todo el trafico va por el tunel). */
  splitRoutes: string[];
  dns: string | null;
  estBaseUrl: string;
  /** Token de alta de un solo uso: lo unico secreto de todo el perfil. */
  enrollToken: string;
  issuedAt: string;
  expiresAt: string;
}

export interface DeviceForProfile {
  username: string;
  tunnelMode: 'full' | 'split';
}

/**
 * Construye el payload (sin firmar). Publica solo para los tests -en
 * produccion se usa siempre a traves de `buildSignedProvisioningProfile`-.
 */
export async function buildProvisioningProfilePayload(input: {
  device: DeviceForProfile;
  token: string;
  issuedAt: Date;
  expiresAt: Date;
}): Promise<ProvisioningProfilePayload> {
  const [settings, chainPem] = await Promise.all([getVpnSettings(), getCaChainPem()]);
  if (!chainPem) {
    throw conflict('La CA de la VPN todavia no esta configurada: no se puede construir el perfil');
  }
  return {
    version: PROFILE_SCHEMA_VERSION,
    cn: input.device.username,
    server: settings.vpnFqdn,
    aaaId: settings.aaaId,
    caChainPem: chainPem,
    ike: IKE_PROPOSAL,
    esp: ESP_PROPOSAL,
    tunnelMode: input.device.tunnelMode,
    splitRoutes: input.device.tunnelMode === 'split' ? [settings.lanCidr] : [],
    dns: settings.dns || null,
    estBaseUrl: `${settings.estUrl}/.well-known/est`,
    enrollToken: input.token,
    issuedAt: input.issuedAt.toISOString(),
    expiresAt: input.expiresAt.toISOString(),
  };
}

export interface SignedProvisioningProfile {
  envelope: SignedProfileEnvelope;
  filename: string;
}

/**
 * `null` si la firma de perfiles no esta configurada (falta
 * VPN_PROFILE_SIGNING_KEY): el llamador debe seguir devolviendo el token
 * igualmente, sin perfil ni QR, para no bloquear el alta manual por EST.
 */
export async function buildSignedProvisioningProfile(input: {
  device: DeviceForProfile;
  token: string;
  issuedAt: Date;
  expiresAt: Date;
}): Promise<SignedProvisioningProfile | null> {
  if (!isProfileSigningConfigured()) return null;
  const payload = await buildProvisioningProfilePayload(input);
  const envelope = signProfilePayload(payload);
  return { envelope, filename: `${input.device.username}.didevvpn` };
}

/**
 * QR con el sobre firmado completo (mismo contenido que el fichero
 * .didevvpn), para el alta en Android. `null` si no cabe en un QR legible
 * -la cadena de CA puede ser demasiado grande-: la app de Windows sigue
 * teniendo el fichero descargable como alternativa siempre disponible.
 */
export async function buildProvisioningQrDataUrl(envelope: SignedProfileEnvelope): Promise<string | null> {
  const text = JSON.stringify(envelope);
  try {
    return await QRCode.toDataURL(text, { errorCorrectionLevel: 'L', margin: 1 });
  } catch (err) {
    if (err instanceof Error && /too big/i.test(err.message)) return null;
    throw err;
  }
}
