/* Copyright (C) didev. GPLv2; see LICENSE-GPLv2.txt. */
package org.strongswan.android.didev;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import org.json.JSONObject;
import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.Signature;
import java.time.Instant;
import java.util.Base64;

public class ProfileContractTest
{
    @Test public void versionComparisonBlocksOlderApp() { assertEquals(1, DidevProvisioningManager.compareVersions("1.2.0", "1.0.0")); }

    @Test public void signerHashMustMatchEnvelopeKey() throws Exception
    {
        KeyPairGenerator generator = KeyPairGenerator.getInstance("Ed25519"); KeyPair pair = generator.generateKeyPair();
        String payload = new JSONObject().put("version", "1").put("variant", "full").put("cn", "phone")
                .put("server", "vpn.example").put("aaaId", "aaa.example").put("rootCaSha256", "00")
                .put("signerKeySha256", "00").put("estBaseUrl", "https://vpn.example/.well-known/est")
                .put("enrollToken", "token").put("issuedAt", Instant.now().minusSeconds(10).toString())
                .put("expiresAt", Instant.now().plusSeconds(600).toString()).put("caChainPem", "x").toString();
        Signature signer = Signature.getInstance("Ed25519"); signer.initSign(pair.getPrivate()); signer.update(payload.getBytes(StandardCharsets.UTF_8));
        JSONObject envelope = new JSONObject().put("payload", Base64.getUrlEncoder().withoutPadding().encodeToString(payload.getBytes(StandardCharsets.UTF_8)))
                .put("signature", Base64.getUrlEncoder().withoutPadding().encodeToString(signer.sign()))
                .put("signerPublicKey", Base64.getUrlEncoder().withoutPadding().encodeToString(pair.getPublic().getEncoded()));
        assertThrows(SecurityException.class, () -> new ProfileVerifier().verify(ProfileEnvelope.parse(envelope.toString())));
    }
}
