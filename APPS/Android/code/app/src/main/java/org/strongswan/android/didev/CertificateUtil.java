/* Copyright (C) didev. GPLv2; see LICENSE-GPLv2.txt. */
package org.strongswan.android.didev;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class CertificateUtil
{
    private CertificateUtil() {}

    public static List<X509Certificate> parseChain(String pem) throws Exception
    {
        List<X509Certificate> result = new ArrayList<>();
        Matcher matcher = Pattern.compile("-----BEGIN CERTIFICATE-----(.*?)-----END CERTIFICATE-----", Pattern.DOTALL).matcher(pem);
        while (matcher.find())
        {
            byte[] der = android.util.Base64.decode(matcher.group(1).replaceAll("\\s", ""), android.util.Base64.DEFAULT);
            result.addAll(parseDer(der));
        }
        if (result.isEmpty()) throw new SecurityException("cadena CA vacia");
        return result;
    }

    public static List<X509Certificate> parseDer(byte[] data) throws Exception
    {
        CertificateFactory factory = CertificateFactory.getInstance("X.509");
        Collection<? extends java.security.cert.Certificate> certificates =
                factory.generateCertificates(new ByteArrayInputStream(data));
        List<X509Certificate> result = new ArrayList<>();
        for (java.security.cert.Certificate certificate : certificates)
            result.add((X509Certificate)certificate);
        if (result.isEmpty()) throw new SecurityException("cadena CA vacia");
        return result;
    }

    public static String toPem(X509Certificate certificate) throws Exception
    {
        return "-----BEGIN CERTIFICATE-----\n" + android.util.Base64.encodeToString(
                certificate.getEncoded(), android.util.Base64.NO_WRAP) +
                "\n-----END CERTIFICATE-----\n";
    }
}
