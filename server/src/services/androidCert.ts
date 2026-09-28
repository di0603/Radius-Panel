import { randomUUID } from 'node:crypto';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { panelPool, radiusPool } from '../db/pools.js';
import { formatUtcDateTime } from '../lib/dates.js';
import { randomPassword, randomToken, sha256 } from '../lib/crypto.js';
import { conflict, forbidden, notFound, unauthorized } from '../lib/http.js';
import { isIpv4InCidr, isIpv4InRange } from '../lib/ipv4.js';
import { decryptAndroidP12, encryptAndroidP12 } from '../lib/pkiCrypto.js';
import { buildPkcs12 } from '../lib/pkcs12.js';
import { exportPrivateKeyPem, generateEcKeyPair, x509 } from '../lib/x509.js';
import { signDeviceCsr } from './deviceCerts.js';
import { effectiveCertDays, findDeviceByUsername, insertCertificate, supersedeCertificate } from './est.js';
import { getActiveIntermediate, getRootCaCert } from './pki.js';
import { getVpnSettings } from './vpnSettings.js';

/**
 * Emision de certificados Android desde el propio panel: excepcion
 * documentada a "el panel nunca tiene la clave privada de un dispositivo"
 * (ver services/est.ts), porque la app de strongSwan para Android no sabe
 * renovarse sola por EST (RFC 7030). El panel genera la clave, construye un
 * .p12 cifrado con una contrasena aleatoria y lo entrega una unica vez por
 * un enlace de descarga de un solo uso, con caducidad corta y restringido
 * por IP; ni la clave ni el .p12 sin cifrar llegan a escribirse en disco.
 */

const DOWNLOAD_TTL_MINUTES = 15;

function isMissingTable(err: unknown): boolean {
  return (err as { code?: string } | undefined)?.code === 'ER_NO_SUCH_TABLE';
}

export interface AndroidCertIssued {
  /** Contrasena del .p12, en claro. Se ensena una unica vez: no se guarda en ningun sitio. */
  password: string;
  /** Token del enlace de descarga, en claro. Igual que la contrasena, no se guarda en claro. */
  downloadToken: string;
  expiresAt: string;
}

/**
 * Da de alta (o renueva) el certificado de un dispositivo Android. Misma
 * logica de perfil que un alta por EST (`signDeviceCsr`, vigencia
 * `android_cert_days`) y misma logica de solapamiento que una renovacion
 * (`supersedeCertificate`): el certificado anterior, si lo hay, sigue
 * activo durante `overlap_hours` en vez de revocarse en el acto.
 */
export async function issueAndroidCertificate(
  username: string,
  createdBy: number | null,
): Promise<AndroidCertIssued> {
  const device = await findDeviceByUsername(username);
  if (!device) throw notFound(`No existe el dispositivo "${username}"`);
  if (device.platform !== 'android') {
    throw conflict('Este dispositivo no es Android: dale de alta por EST (RFC 7030), no desde aqui');
  }
  if (!device.enabled) throw conflict('El dispositivo esta deshabilitado');

  const active = await getActiveIntermediate();
  const rootCert = await getRootCaCert();
  if (!rootCert) throw conflict('La CA de la VPN todavia no tiene una raiz configurada');

  const days = await effectiveCertDays(device);
  const keys = await generateEcKeyPair('P-256');
  const csr = await x509.Pkcs10CertificateRequestGenerator.create({
    name: `CN=${username}`,
    keys,
    signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
  });
  const signed = await signDeviceCsr({
    csrPem: csr.toString(),
    cn: username,
    days,
    issuerCert: active.cert,
    signingKey: active.signingKey,
  });

  const password = randomPassword(20);
  const keyPem = await exportPrivateKeyPem(keys.privateKey);
  const p12 = await buildPkcs12(signed.certPem, keyPem, password);

  const [[previous]] = await radiusPool.query<RowDataPacket[]>(
    `SELECT serial FROM vpn_certificates WHERE username = :u AND status = 'active' LIMIT 1`,
    { u: username },
  );

  await insertCertificate({
    username,
    caId: active.id,
    serial: signed.serial,
    spkiSha256: signed.spkiSha256,
    notBefore: signed.notBefore,
    notAfter: signed.notAfter,
  });

  if (previous) {
    const settings = await getVpnSettings();
    await supersedeCertificate(previous.serial, settings.overlapHours);
  }

  const downloadToken = randomToken();
  const expiresAt = new Date(Date.now() + DOWNLOAD_TTL_MINUTES * 60 * 1000);
  try {
    await panelPool.query(
      `INSERT INTO panel_vpn_android_downloads
         (username, serial, token_sha256, p12_encrypted, created_by, expires_at)
       VALUES (:username, :serial, :tokenSha256, :p12, :createdBy, :expiresAt)`,
      {
        username,
        serial: signed.serial,
        tokenSha256: sha256(downloadToken),
        p12: encryptAndroidP12(p12.toString('base64')),
        createdBy,
        expiresAt: formatUtcDateTime(expiresAt),
      },
    );
  } catch (err) {
    if (isMissingTable(err)) {
      throw conflict('Falta aplicar sql/panel-schema-vpn-android.sql: aplicala y vuelve a intentarlo');
    }
    throw err;
  }

  return { password, downloadToken, expiresAt: expiresAt.toISOString() };
}

function buildSswanProfile(input: {
  username: string;
  vpnFqdn: string;
  aaaId: string;
  rootCertBase64: string;
  p12Base64: string;
}): string {
  // Formato verificado en docs.strongswan.org/docs/latest/os/androidVpnClientProfiles.html:
  // "ikev2-eap-tls" es el tipo para EAP-TLS con certificado; remote.cert lleva
  // solo la raiz (el servidor ya envia la intermedia durante el handshake IKE,
  // y el campo no admite mas de un certificado); local.p12 lleva el PKCS12
  // completo en base64 -la app pide su contrasena al importarlo, que nunca
  // viaja dentro de este fichero-. Siempre full tunnel (sin "split-tunneling"),
  // como en el resto de dispositivos Android del proyecto.
  return JSON.stringify(
    {
      uuid: randomUUID(),
      name: 'Casa',
      type: 'ikev2-eap-tls',
      remote: {
        addr: input.vpnFqdn,
        id: input.aaaId,
        cert: input.rootCertBase64,
      },
      local: {
        eap_id: input.username,
        p12: input.p12Base64,
      },
      'ike-proposal': 'aes256gcm16-prfsha384-ecp384',
      'esp-proposal': 'aes256gcm16-ecp384',
    },
    null,
    2,
  );
}

export interface AndroidDownload {
  filename: string;
  sswanJson: string;
}

/**
 * Consume el enlace de descarga de un solo uso: reclama el token de forma
 * atomica (mismo patron que panel_vpn_enroll_tokens/EST: un UPDATE que solo
 * afecta a una fila si seguia sin descargarse y no habia caducado, asi que
 * dos peticiones simultaneas con el mismo token nunca lo consiguen las dos),
 * y solo dentro del rango de la VPN o de la LAN configurados. Borra la fila
 * entera al servir el fichero: el .p12 no sigue viviendo en la base de
 * datos ni en disco una vez descargado.
 */
export async function consumeAndroidDownload(
  username: string,
  tokenPlain: string,
  requestIp: string,
): Promise<AndroidDownload> {
  const settings = await getVpnSettings();
  const allowed =
    isIpv4InRange(requestIp, settings.poolStart, settings.poolEnd) ||
    isIpv4InCidr(requestIp, settings.lanCidr);
  if (!allowed) {
    throw forbidden('Esta descarga solo esta disponible desde la red local o la VPN');
  }

  const tokenSha256 = sha256(tokenPlain);
  const [result] = await panelPool.query<ResultSetHeader>(
    `UPDATE panel_vpn_android_downloads
        SET downloaded_at = UTC_TIMESTAMP()
      WHERE username = :u AND token_sha256 = :t AND downloaded_at IS NULL AND expires_at > UTC_TIMESTAMP()`,
    { u: username, t: tokenSha256 },
  );
  if (result.affectedRows !== 1) {
    throw unauthorized('Enlace invalido, caducado o ya usado');
  }

  const [[row]] = await panelPool.query<RowDataPacket[]>(
    `SELECT p12_encrypted FROM panel_vpn_android_downloads WHERE username = :u AND token_sha256 = :t`,
    { u: username, t: tokenSha256 },
  );
  await panelPool.query(
    `DELETE FROM panel_vpn_android_downloads WHERE username = :u AND token_sha256 = :t`,
    { u: username, t: tokenSha256 },
  );

  const rootCert = await getRootCaCert();
  if (!rootCert) throw conflict('La CA de la VPN ya no tiene una raiz configurada');

  const sswanJson = buildSswanProfile({
    username,
    vpnFqdn: settings.vpnFqdn,
    aaaId: settings.aaaId,
    rootCertBase64: rootCert.toString('base64'),
    p12Base64: decryptAndroidP12(row.p12_encrypted),
  });

  return { filename: `${username}.sswan`, sswanJson };
}

/** Purga diaria de enlaces caducados que nunca se llegaron a descargar (ver server/src/index.ts). */
export async function purgeExpiredAndroidDownloads(): Promise<number> {
  try {
    const [res] = await panelPool.query<ResultSetHeader>(
      `DELETE FROM panel_vpn_android_downloads WHERE expires_at < UTC_TIMESTAMP()`,
    );
    return res.affectedRows;
  } catch (err) {
    if (isMissingTable(err)) return 0;
    throw err;
  }
}
