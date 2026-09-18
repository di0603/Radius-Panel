import { test } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { sendAccessRequest, sendDisconnect } from './radiusPacket.js';

/** Servidor UDP de pega que responde con un codigo fijo copiando el id. */
function fakeServer(replyCode: number): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const srv = dgram.createSocket('udp4');
    srv.on('message', (msg, rinfo) => {
      const resp = Buffer.alloc(20);
      resp.writeUInt8(replyCode, 0);
      resp.writeUInt8(msg.readUInt8(1), 1); // mismo id
      resp.writeUInt16BE(20, 2);
      srv.send(resp, rinfo.port, rinfo.address);
    });
    srv.bind(0, '127.0.0.1', () => {
      const addr = srv.address();
      resolve({ port: typeof addr === 'string' ? 0 : addr.port, close: () => srv.close() });
    });
  });
}

test('sendAccessRequest: interpreta Access-Accept', async () => {
  const srv = await fakeServer(2);
  try {
    const res = await sendAccessRequest({
      host: '127.0.0.1',
      port: srv.port,
      secret: 'testing123',
      timeoutMs: 1000,
      username: 'ana',
      password: 'secreta',
    });
    assert.equal(res.accepted, true);
    assert.equal(res.codeName, 'Access-Accept');
  } finally {
    srv.close();
  }
});

test('sendAccessRequest: interpreta Access-Reject', async () => {
  const srv = await fakeServer(3);
  try {
    const res = await sendAccessRequest({
      host: '127.0.0.1',
      port: srv.port,
      secret: 'x',
      timeoutMs: 1000,
      username: 'ana',
      password: 'mal',
    });
    assert.equal(res.accepted, false);
    assert.equal(res.codeName, 'Access-Reject');
  } finally {
    srv.close();
  }
});

test('sendDisconnect: interpreta Disconnect-ACK', async () => {
  const srv = await fakeServer(41);
  try {
    const res = await sendDisconnect({
      host: '127.0.0.1',
      port: srv.port,
      secret: 's',
      timeoutMs: 1000,
      attributes: { userName: 'ana', acctSessionId: 'abc' },
    });
    assert.equal(res.ok, true);
    assert.equal(res.codeName, 'Disconnect-ACK');
  } finally {
    srv.close();
  }
});

test('sendAccessRequest: timeout si nadie responde', async () => {
  await assert.rejects(
    sendAccessRequest({
      host: '127.0.0.1',
      port: 1, // puerto sin escuchar
      secret: 's',
      timeoutMs: 300,
      username: 'a',
      password: 'b',
    }),
  );
});
