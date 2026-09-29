import QRCode from 'qrcode';
import { conflict } from '../lib/http.js';
import { sha256Hex } from '../lib/x509.js';
import { isProfileSigningConfigured, signProfilePayload, type SignedProfileEnvelope } from '../lib/vpnProfileSigning.js';
import { getCaChainPem, getRootCaCert } from './pki.js';
import { getVpnSettings, type VpnSettings } from './vpnSettings.js';

/**
 * Perfil de aprovisionamiento (.didevvpn) de un dispositivo: se construye al
 * generar su token de alta (services/vpnDevices.ts:generateEnrollToken) y se
 * entrega una unica vez, igual que el propio token -de hecho lo lleva
 * dentro-. Firmado con Ed25519 (lib/vpnProfileSigning.ts) para que una app
 * nunca acepte un perfil que no venga de este panel.
 *
 * Dos variantes, firmadas por separado (cada una con su propio sobre, mismo
 * keyId):
 *   - "full" (fichero .didevvpn descargable): lleva la cadena de CA completa
 *     (raiz + intermedia) en `caChainPem`.
 *   - "qr" (codigo QR): SIN `caChainPem` -la cadena completa (~2800
 *     caracteres con una raiz+intermedia P-384 reales) deja el QR en una
 *     version ~39, practicamente imposible de escanear desde una pantalla, y
 *     con nombres un poco mas largos dejaria de caber sin avisar-. En su
 *     lugar lleva `rootCaSha256` (presente en las dos variantes): la app
 *     obtiene la cadena por `GET /.well-known/est/cacerts` (sin TLS mutuo
 *     todavia, RFC 7030 4.1.1) y solo la acepta si la raiz recibida tiene
 *     exactamente esa huella. Contrato completo documentado en el README,
 *     seccion "Aprovisionamiento de apps".
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

export type ProfileVariant = 'full' | 'qr';

interface ProvisioningProfileBase {
  version: number;
  variant: ProfileVariant;
  cn: string;
  server: string;
  aaaId: string;
  /** SHA-256 (hex) del DER de la raiz offline: presente en las dos variantes, ver el comentario del fichero. */
  rootCaSha256: string;
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

export interface FullProvisioningProfilePayload extends ProvisioningProfileBase {
  variant: 'full';
  caChainPem: string;
}

export interface QrProvisioningProfilePayload extends ProvisioningProfileBase {
  variant: 'qr';
}

export type ProvisioningProfilePayload = FullProvisioningProfilePayload | QrProvisioningProfilePayload;

export interface DeviceForProfile {
  username: string;
  tunnelMode: 'full' | 'split';
}

interface ProfileInput {
  device: DeviceForProfile;
  token: string;
  issuedAt: Date;
  expiresAt: Date;
}

interface ProfileContext {
  settings: VpnSettings;
  chainPem: string;
  rootCaSha256: string;
}

async function loadProfileContext(): Promise<ProfileContext> {
  const [settings, chainPem, rootCert] = await Promise.all([
    getVpnSettings(),
    getCaChainPem(),
    getRootCaCert(),
  ]);
  if (!chainPem || !rootCert) {
    throw conflict('La CA de la VPN todavia no esta configurada: no se puede construir el perfil');
  }
  return { settings, chainPem, rootCaSha256: sha256Hex(rootCert.rawData) };
}

function buildPayload(ctx: ProfileContext, input: ProfileInput, variant: ProfileVariant): ProvisioningProfilePayload {
  const base: ProvisioningProfileBase = {
    version: PROFILE_SCHEMA_VERSION,
    variant,
    cn: input.device.username,
    server: ctx.settings.vpnFqdn,
    aaaId: ctx.settings.aaaId,
    rootCaSha256: ctx.rootCaSha256,
    ike: IKE_PROPOSAL,
    esp: ESP_PROPOSAL,
    tunnelMode: input.device.tunnelMode,
    splitRoutes: input.device.tunnelMode === 'split' ? [ctx.settings.lanCidr] : [],
    dns: ctx.settings.dns || null,
    estBaseUrl: `${ctx.settings.estUrl}/.well-known/est`,
    enrollToken: input.token,
    issuedAt: input.issuedAt.toISOString(),
    expiresAt: input.expiresAt.toISOString(),
  };
  return variant === 'full' ? { ...base, variant: 'full', caChainPem: ctx.chainPem } : { ...base, variant: 'qr' };
}

/**
 * Construye el payload de una variante (sin firmar). Publica solo para los
 * tests -en produccion se usa siempre a traves de
 * `buildSignedProvisioningProfiles`-.
 */
export async function buildProvisioningProfilePayload(
  input: ProfileInput & { variant: ProfileVariant },
): Promise<ProvisioningProfilePayload> {
  const ctx = await loadProfileContext();
  return buildPayload(ctx, input, input.variant);
}

export interface SignedProvisioningProfiles {
  /** Sobre completo (con la cadena de CA), para el fichero .didevvpn descargable. */
  full: SignedProfileEnvelope;
  /** Sobre compacto (sin la cadena de CA, solo su huella), para el QR. */
  qr: SignedProfileEnvelope;
  filename: string;
}

/**
 * `null` si la firma de perfiles no esta configurada (falta
 * VPN_PROFILE_SIGNING_KEY): el llamador debe seguir devolviendo el token
 * igualmente, sin perfil ni QR, para no bloquear el alta manual por EST.
 */
export async function buildSignedProvisioningProfiles(input: ProfileInput): Promise<SignedProvisioningProfiles | null> {
  if (!isProfileSigningConfigured()) return null;
  const ctx = await loadProfileContext();
  return {
    full: signProfilePayload(buildPayload(ctx, input, 'full')),
    qr: signProfilePayload(buildPayload(ctx, input, 'qr')),
    filename: `${input.device.username}.didevvpn`,
  };
}

/**
 * QR con el sobre firmado **compacto** (variante "qr", sin la cadena de CA).
 * Nivel de correccion M (mas robusto que L; el contenido ya es pequeno sin
 * la cadena, hay margen de sobra). `null` si aun asi no cupiera en un QR
 * legible -no deberia pasar nunca con la variante compacta, pero se
 * mantiene el margen de seguridad-: quien llama debe entonces DECIRLO en
 * pantalla (no omitirlo en silencio) y ofrecer el fichero .didevvpn como
 * alternativa siempre disponible.
 */
export async function buildProvisioningQrDataUrl(envelope: SignedProfileEnvelope): Promise<string | null> {
  const text = JSON.stringify(envelope);
  try {
    return await QRCode.toDataURL(text, { errorCorrectionLevel: 'M', margin: 1 });
  } catch (err) {
    if (err instanceof Error && /too big/i.test(err.message)) return null;
    throw err;
  }
}
