/**
 * Cliente minimo de RADIUS por UDP para enviar Disconnect-Request (RFC 5176).
 * No depende de `radclient`; usa solo el modulo `dgram` y `crypto` de Node.
 */
import dgram from 'node:dgram';
import crypto from 'node:crypto';

const CODE_ACCESS_REQUEST = 1;
const CODE_ACCESS_ACCEPT = 2;
const CODE_ACCESS_REJECT = 3;
const CODE_ACCESS_CHALLENGE = 11;
const CODE_STATUS_SERVER = 12;
const CODE_DISCONNECT_REQUEST = 40;
const CODE_DISCONNECT_ACK = 41;
const CODE_DISCONNECT_NAK = 44;

// Numeros de atributo estandar (RFC 2865 / 2866 / 2869)
const ATTR = {
  USER_NAME: 1,
  USER_PASSWORD: 2,
  NAS_IP_ADDRESS: 4,
  FRAMED_IP_ADDRESS: 8,
  REPLY_MESSAGE: 18,
  CALLING_STATION_ID: 31,
  NAS_IDENTIFIER: 32,
  ACCT_SESSION_ID: 44,
  MESSAGE_AUTHENTICATOR: 80,
} as const;

export interface DisconnectParams {
  host: string;
  port: number;
  secret: string;
  timeoutMs: number;
  /** Al menos uno de estos deberia ir para identificar la sesion. */
  attributes: {
    userName?: string;
    nasIpAddress?: string;
    acctSessionId?: string;
    framedIpAddress?: string;
    callingStationId?: string;
  };
}

export interface DisconnectResult {
  ok: boolean;
  code: number;
  codeName: string;
  raw: Buffer;
}

function encodeAttr(type: number, value: Buffer): Buffer {
  const header = Buffer.from([type, value.length + 2]);
  return Buffer.concat([header, value]);
}

function ipv4ToBuffer(ip: string): Buffer {
  const parts = ip
    .trim()
    .split('.')
    .map((n) => Number(n));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    throw new Error(`IPv4 invalida: ${ip}`);
  }
  return Buffer.from(parts);
}

function buildAttributes(p: DisconnectParams['attributes']): Buffer {
  const chunks: Buffer[] = [];
  if (p.userName) chunks.push(encodeAttr(ATTR.USER_NAME, Buffer.from(p.userName, 'utf8')));
  if (p.nasIpAddress) chunks.push(encodeAttr(ATTR.NAS_IP_ADDRESS, ipv4ToBuffer(p.nasIpAddress)));
  if (p.acctSessionId)
    chunks.push(encodeAttr(ATTR.ACCT_SESSION_ID, Buffer.from(p.acctSessionId, 'utf8')));
  if (p.framedIpAddress)
    chunks.push(encodeAttr(ATTR.FRAMED_IP_ADDRESS, ipv4ToBuffer(p.framedIpAddress)));
  if (p.callingStationId)
    chunks.push(encodeAttr(ATTR.CALLING_STATION_ID, Buffer.from(p.callingStationId, 'utf8')));
  return Buffer.concat(chunks);
}

/**
 * Construye el paquete Disconnect-Request. El Request Authenticator se calcula
 * como en Accounting-Request: MD5(Code+ID+Length+16 ceros+Attrs+Secret).
 * Se incluye Message-Authenticator (HMAC-MD5) por recomendacion de RFC 5176.
 */
function buildPacket(
  id: number,
  secret: string,
  attrsInput: DisconnectParams['attributes'],
): Buffer {
  let attrs = buildAttributes(attrsInput);
  // Placeholder de Message-Authenticator (16 bytes a cero)
  const maPlaceholder = encodeAttr(ATTR.MESSAGE_AUTHENTICATOR, Buffer.alloc(16));
  attrs = Buffer.concat([attrs, maPlaceholder]);

  const length = 20 + attrs.length;
  const header = Buffer.alloc(4);
  header.writeUInt8(CODE_DISCONNECT_REQUEST, 0);
  header.writeUInt8(id, 1);
  header.writeUInt16BE(length, 2);

  const zeroAuth = Buffer.alloc(16);
  const packet = Buffer.concat([header, zeroAuth, attrs]);

  // Message-Authenticator = HMAC-MD5(secret, paquete completo con MA a cero)
  const ma = crypto.createHmac('md5', secret).update(packet).digest();
  ma.copy(packet, packet.length - 16);

  // Request Authenticator sobre el paquete ya con Message-Authenticator relleno
  const reqAuth = crypto
    .createHash('md5')
    .update(packet.subarray(0, 4))
    .update(zeroAuth)
    .update(packet.subarray(20))
    .update(Buffer.from(secret, 'utf8'))
    .digest();
  reqAuth.copy(packet, 4);

  return packet;
}

function codeName(code: number): string {
  if (code === CODE_DISCONNECT_ACK) return 'Disconnect-ACK';
  if (code === CODE_DISCONNECT_NAK) return 'Disconnect-NAK';
  return `code-${code}`;
}

export function sendDisconnect(params: DisconnectParams): Promise<DisconnectResult> {
  const id = crypto.randomInt(0, 256);
  const packet = buildPacket(id, params.secret, params.attributes);

  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    const timer = setTimeout(() => {
      socket.close();
      reject(
        new Error(`El NAS ${params.host}:${params.port} no respondio en ${params.timeoutMs} ms`),
      );
    }, params.timeoutMs);

    socket.on('message', (msg) => {
      clearTimeout(timer);
      socket.close();
      const code = msg.readUInt8(0);
      resolve({ ok: code === CODE_DISCONNECT_ACK, code, codeName: codeName(code), raw: msg });
    });

    socket.on('error', (err) => {
      clearTimeout(timer);
      socket.close();
      reject(err);
    });

    socket.send(packet, params.port, params.host, (err) => {
      if (err) {
        clearTimeout(timer);
        socket.close();
        reject(err);
      }
    });
  });
}

/* ------------------------------------------------------------------ *
 * Access-Request (probar la autenticacion de un usuario, PAP)
 * ------------------------------------------------------------------ */

function udpTransceive(
  host: string,
  port: number,
  packet: Buffer,
  timeoutMs: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`${host}:${port} no respondio en ${timeoutMs} ms`));
    }, timeoutMs);
    socket.on('message', (msg) => {
      clearTimeout(timer);
      socket.close();
      resolve(msg);
    });
    socket.on('error', (err) => {
      clearTimeout(timer);
      socket.close();
      reject(err);
    });
    socket.send(packet, port, host, (err) => {
      if (err) {
        clearTimeout(timer);
        socket.close();
        reject(err);
      }
    });
  });
}

/** Cifrado PAP del atributo User-Password (RFC 2865 5.2). */
function encryptPap(password: string, secret: string, requestAuth: Buffer): Buffer {
  const pw = Buffer.from(password, 'utf8');
  const padLen = Math.max(16, Math.ceil(pw.length / 16) * 16);
  const plain = Buffer.alloc(padLen);
  pw.copy(plain);
  const out = Buffer.alloc(padLen);
  let prev = requestAuth;
  for (let i = 0; i < padLen; i += 16) {
    const hash = crypto.createHash('md5').update(secret).update(prev).digest();
    for (let j = 0; j < 16; j++) out[i + j] = plain[i + j] ^ hash[j];
    prev = out.subarray(i, i + 16);
  }
  return out;
}

function parseAttributes(packet: Buffer): { type: number; value: Buffer }[] {
  const attrs: { type: number; value: Buffer }[] = [];
  let off = 20;
  while (off + 2 <= packet.length) {
    const type = packet.readUInt8(off);
    const len = packet.readUInt8(off + 1);
    if (len < 2 || off + len > packet.length) break;
    attrs.push({ type, value: packet.subarray(off + 2, off + len) });
    off += len;
  }
  return attrs;
}

export interface AccessRequestParams {
  host: string;
  port: number;
  secret: string;
  timeoutMs: number;
  username: string;
  password: string;
  nasIpAddress?: string;
}

export interface AccessRequestResult {
  code: number;
  codeName: 'Access-Accept' | 'Access-Reject' | 'Access-Challenge' | string;
  accepted: boolean;
  replyMessage?: string;
  attributes: { type: number; hex: string; text: string }[];
}

export async function sendAccessRequest(p: AccessRequestParams): Promise<AccessRequestResult> {
  const id = crypto.randomInt(0, 256);
  const reqAuth = crypto.randomBytes(16);

  const chunks: Buffer[] = [
    encodeAttr(ATTR.USER_NAME, Buffer.from(p.username, 'utf8')),
    encodeAttr(ATTR.USER_PASSWORD, encryptPap(p.password, p.secret, reqAuth)),
  ];
  if (p.nasIpAddress) chunks.push(encodeAttr(ATTR.NAS_IP_ADDRESS, ipv4ToBuffer(p.nasIpAddress)));
  chunks.push(encodeAttr(ATTR.MESSAGE_AUTHENTICATOR, Buffer.alloc(16)));
  const attrs = Buffer.concat(chunks);

  const header = Buffer.alloc(4);
  header.writeUInt8(CODE_ACCESS_REQUEST, 0);
  header.writeUInt8(id, 1);
  header.writeUInt16BE(20 + attrs.length, 2);

  const packet = Buffer.concat([header, reqAuth, attrs]);
  const ma = crypto.createHmac('md5', p.secret).update(packet).digest();
  ma.copy(packet, packet.length - 16);

  const resp = await udpTransceive(p.host, p.port, packet, p.timeoutMs);
  const code = resp.readUInt8(0);
  const parsed = parseAttributes(resp);
  const reply = parsed.find((a) => a.type === ATTR.REPLY_MESSAGE);

  const codeName =
    code === CODE_ACCESS_ACCEPT
      ? 'Access-Accept'
      : code === CODE_ACCESS_REJECT
        ? 'Access-Reject'
        : code === CODE_ACCESS_CHALLENGE
          ? 'Access-Challenge'
          : `code-${code}`;

  return {
    code,
    codeName,
    accepted: code === CODE_ACCESS_ACCEPT,
    replyMessage: reply ? reply.value.toString('utf8') : undefined,
    attributes: parsed.map((a) => ({
      type: a.type,
      hex: a.value.toString('hex'),
      text: a.value.toString('utf8').replace(/[^\x20-\x7e]/g, '.'),
    })),
  };
}

/** Sondeo best-effort: envia un Status-Server y dice si el destino contesta. */
export async function probe(
  host: string,
  port: number,
  secret: string,
  timeoutMs: number,
): Promise<boolean> {
  const id = crypto.randomInt(0, 256);
  const reqAuth = crypto.randomBytes(16);
  const attrs = encodeAttr(ATTR.MESSAGE_AUTHENTICATOR, Buffer.alloc(16));
  const header = Buffer.alloc(4);
  header.writeUInt8(CODE_STATUS_SERVER, 0);
  header.writeUInt8(id, 1);
  header.writeUInt16BE(20 + attrs.length, 2);
  const packet = Buffer.concat([header, reqAuth, attrs]);
  const ma = crypto.createHmac('md5', secret).update(packet).digest();
  ma.copy(packet, packet.length - 16);
  try {
    await udpTransceive(host, port, packet, timeoutMs);
    return true;
  } catch {
    return false;
  }
}
