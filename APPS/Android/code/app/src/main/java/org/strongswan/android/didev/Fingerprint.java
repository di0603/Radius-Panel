/* Copyright (C) didev. GPLv2; see LICENSE-GPLv2.txt. */
package org.strongswan.android.didev;

import java.security.MessageDigest;

final class Fingerprint
{
    private Fingerprint() {}

    static String sha256(byte[] value)
    {
        try
        {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(value);
            StringBuilder result = new StringBuilder(digest.length * 2);
            for (byte b : digest) result.append(String.format(java.util.Locale.ROOT, "%02x", b));
            return result.toString();
        }
        catch (Exception e)
        {
            throw new IllegalStateException(e);
        }
    }

    static boolean equalHex(String expected, byte[] value)
    {
        return expected.equalsIgnoreCase(sha256(value));
    }
}
