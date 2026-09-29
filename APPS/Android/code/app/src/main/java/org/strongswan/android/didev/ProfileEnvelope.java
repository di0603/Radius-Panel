/* Copyright (C) didev. GPLv2; see LICENSE-GPLv2.txt. */
package org.strongswan.android.didev;

import android.util.Base64;
import org.json.JSONException;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;

public final class ProfileEnvelope
{
    public final byte[] payloadBytes;
    public final byte[] signature;
    public final byte[] signerPublicKey;
    public final ProvisioningProfile profile;

    private ProfileEnvelope(byte[] payloadBytes, byte[] signature, byte[] signerPublicKey,
                            ProvisioningProfile profile)
    {
        this.payloadBytes = payloadBytes;
        this.signature = signature;
        this.signerPublicKey = signerPublicKey;
        this.profile = profile;
    }

    public static ProfileEnvelope parse(String text) throws Exception
    {
        JSONObject envelope = new JSONObject(text);
        byte[] payload = decode(envelope.getString("payload"));
        byte[] signature = decode(envelope.getString("signature"));
        byte[] publicKey = decode(envelope.getString("signerPublicKey"));
        return new ProfileEnvelope(payload, signature, publicKey,
                ProvisioningProfile.parse(payload));
    }

    private static byte[] decode(String value)
    {
        return Base64.decode(value, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
    }
}
