/* Copyright (C) didev. GPLv2; see LICENSE-GPLv2.txt. */
package org.strongswan.android.didev;

import android.util.Base64;

import java.security.KeyFactory;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.X509EncodedKeySpec;
import java.time.Instant;

/** Verifies the exact UTF-8 payload bytes before any network operation. */
public final class ProfileVerifier
{
    public void verify(ProfileEnvelope envelope) throws Exception
    {
        ProvisioningProfile profile = envelope.profile;
        if (!profile.isKnownVersion()) throw new SecurityException("version de perfil no conocida");
        if (!("full".equals(profile.variant) || "qr".equals(profile.variant)))
            throw new SecurityException("variante de perfil no conocida");
        if (profile.isExpired(Instant.now())) throw new SecurityException("perfil caducado");
        if (!Fingerprint.equalHex(profile.signerKeySha256, envelope.signerPublicKey))
            throw new SecurityException("signerKeySha256 no coincide con la clave del sobre");

        PublicKey key = KeyFactory.getInstance("Ed25519")
                .generatePublic(new X509EncodedKeySpec(envelope.signerPublicKey));
        Signature verifier = Signature.getInstance("Ed25519");
        verifier.initVerify(key);
        verifier.update(envelope.payloadBytes);
        if (!verifier.verify(envelope.signature)) throw new SecurityException("firma del perfil invalida");
        if ("full".equals(profile.variant) && profile.caChainPem.trim().isEmpty())
            throw new SecurityException("el perfil full no contiene cadena CA");
        if (profile.estBaseUrl.startsWith("http://"))
            throw new SecurityException("EST exige HTTPS");
    }
}
