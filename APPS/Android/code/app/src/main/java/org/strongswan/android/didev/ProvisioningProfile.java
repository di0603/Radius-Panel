/*
 * Copyright (C) didev
 *
 * This program is free software; you can redistribute it and/or modify it
 * under the terms of the GNU General Public License version 2.
 */
package org.strongswan.android.didev;

import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/** Exact signed profile contract shared with the panel and Windows client. */
public final class ProvisioningProfile
{
    public final String version, variant, cn, server, aaaId, rootCaSha256, signerKeySha256;
    public final String ike, esp, tunnelMode, dns, estBaseUrl, enrollToken, caChainPem;
    public final List<String> splitRoutes;
    public final Instant issuedAt, expiresAt;
    public final JSONObject raw;

    private ProvisioningProfile(JSONObject value) throws JSONException
    {
        raw = value;
        version = value.getString("version");
        variant = value.getString("variant");
        cn = value.getString("cn");
        server = value.getString("server");
        aaaId = value.getString("aaaId");
        rootCaSha256 = value.getString("rootCaSha256").toLowerCase(java.util.Locale.ROOT);
        signerKeySha256 = value.getString("signerKeySha256").toLowerCase(java.util.Locale.ROOT);
        ike = value.optString("ike", "");
        esp = value.optString("esp", "");
        tunnelMode = value.optString("tunnelMode", "full");
        dns = value.optString("dns", "");
        estBaseUrl = value.getString("estBaseUrl");
        enrollToken = value.getString("enrollToken");
        caChainPem = value.optString("caChainPem", "");
        JSONArray routes = value.optJSONArray("splitRoutes");
        ArrayList<String> parsedRoutes = new ArrayList<>();
        if (routes != null)
        {
            for (int i = 0; i < routes.length(); i++) parsedRoutes.add(routes.getString(i));
        }
        splitRoutes = Collections.unmodifiableList(parsedRoutes);
        issuedAt = Instant.parse(value.getString("issuedAt"));
        expiresAt = Instant.parse(value.getString("expiresAt"));
    }

    public static ProvisioningProfile parse(byte[] json) throws JSONException
    {
        return new ProvisioningProfile(new JSONObject(new String(json, StandardCharsets.UTF_8)));
    }

    public static ProvisioningProfile parse(String json) throws JSONException
    {
        return parse(json.getBytes(StandardCharsets.UTF_8));
    }

    public boolean isExpired(Instant now)
    {
        return !now.isBefore(expiresAt) || now.isBefore(issuedAt.minusSeconds(300));
    }

    public boolean isKnownVersion()
    {
        return "1".equals(version) || "1.0".equals(version);
    }

    public String shortRootFingerprint()
    {
        return rootCaSha256.substring(0, Math.min(16, rootCaSha256.length())).toUpperCase(java.util.Locale.ROOT);
    }

    public String shortSignerFingerprint()
    {
        return signerKeySha256.substring(0, Math.min(16, signerKeySha256.length())).toUpperCase(java.util.Locale.ROOT);
    }
}
