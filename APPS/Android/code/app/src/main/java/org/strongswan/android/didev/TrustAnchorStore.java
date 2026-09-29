/* Copyright (C) didev. GPLv2; see LICENSE-GPLv2.txt. */
package org.strongswan.android.didev;

import android.content.Context;
import android.content.SharedPreferences;

import java.util.Locale;

/** Per-server TOFU anchors. Changing either fingerprint requires deleting the connection. */
public final class TrustAnchorStore
{
    public static final class Anchor
    {
        public final String signerKeySha256, rootCaSha256, rootCertificatePem;
        Anchor(String signer, String root, String pem)
        { signerKeySha256 = signer; rootCaSha256 = root; rootCertificatePem = pem; }
    }

    private final SharedPreferences preferences;
    public TrustAnchorStore(Context context)
    { preferences = context.getSharedPreferences("didev-trust-anchors", Context.MODE_PRIVATE); }

    public Anchor get(String server)
    {
        String key = key(server);
        String signer = preferences.getString(key + ".signer", null);
        String root = preferences.getString(key + ".root", null);
        String pem = preferences.getString(key + ".pem", null);
        return signer == null || root == null || pem == null ? null : new Anchor(signer, root, pem);
    }

    public boolean matches(String server, ProvisioningProfile profile)
    {
        Anchor anchor = get(server);
        return anchor != null && profile != null && anchor.signerKeySha256.equalsIgnoreCase(profile.signerKeySha256)
                && anchor.rootCaSha256.equalsIgnoreCase(profile.rootCaSha256);
    }

    public void save(String server, ProvisioningProfile profile, String rootPem)
    {
        preferences.edit().putString(key(server) + ".signer", profile.signerKeySha256)
                .putString(key(server) + ".root", profile.rootCaSha256)
                .putString(key(server) + ".pem", rootPem).apply();
    }

    public void remove(String server)
    {
        String key = key(server);
        preferences.edit().remove(key + ".signer").remove(key + ".root").remove(key + ".pem").apply();
    }

    private static String key(String server)
    { return "server." + server.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9._-]", "_"); }
}
