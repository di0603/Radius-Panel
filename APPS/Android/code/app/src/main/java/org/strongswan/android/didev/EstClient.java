/* Copyright (C) didev. GPLv2; see LICENSE-GPLv2.txt. */
package org.strongswan.android.didev;

import android.util.Base64;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.Principal;
import java.security.PrivateKey;
import java.security.cert.X509Certificate;
import java.util.List;

import javax.net.ssl.HostnameVerifier;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.KeyManagerFactory;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;
import javax.net.ssl.X509KeyManager;
import javax.net.ssl.X509ExtendedKeyManager;

/** RFC 7030 client. Bootstrap is used only for QR cacerts, before the anchor exists. */
public final class EstClient
{
    public static final class Status
    {
        public final String minAppVersion, ip, notAfter;
        Status(String minAppVersion, String ip, String notAfter)
        { this.minAppVersion = minAppVersion; this.ip = ip; this.notAfter = notAfter; }
    }

    public List<X509Certificate> fetchBootstrapChain(String baseUrl) throws Exception
    {
        HttpsURLConnection connection = open(estEndpoint(baseUrl, "cacerts"), null, true);
        return CertificateUtil.parseDer(decodePkcs7(read(connection)));
    }

    public byte[] simpleEnroll(ProvisioningProfile profile, byte[] csr, TrustAnchorStore.Anchor anchor)
            throws Exception
    {
        String credentials = Base64.encodeToString((profile.cn + ":" + profile.enrollToken)
                .getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP);
        HttpsURLConnection connection = open(estEndpoint(profile.estBaseUrl, "simpleenroll"), anchor, false);
        connection.setRequestMethod("POST"); connection.setDoOutput(true);
        connection.setRequestProperty("Authorization", "Basic " + credentials);
        connection.setRequestProperty("Content-Type", "application/pkcs10");
        connection.getOutputStream().write(Base64.encode(csr, Base64.NO_WRAP));
        return decodePkcs7(read(connection));
    }

    public Status status(ProvisioningProfile profile, TrustAnchorStore.Anchor anchor, String alias)
            throws Exception
    {
        HttpsURLConnection connection = open(estEndpoint(profile.estBaseUrl, "status"), anchor, false, alias);
        connection.setRequestMethod("GET");
        JSONObject json = new JSONObject(new String(read(connection), StandardCharsets.UTF_8));
        return new Status(json.optString("minAppVersion", "0.0.0"),
                json.optString("ip", ""), json.optString("notAfter", ""));
    }

    public byte[] simpleReEnroll(ProvisioningProfile profile, byte[] csr, TrustAnchorStore.Anchor anchor,
                                 X509Certificate certificate, String alias) throws Exception
    {
        HttpsURLConnection connection = open(estEndpoint(profile.estBaseUrl, "simplereenroll"), anchor, false, alias);
        connection.setRequestMethod("POST"); connection.setDoOutput(true);
        connection.setRequestProperty("Content-Type", "application/pkcs10");
        connection.getOutputStream().write(Base64.encode(csr, Base64.NO_WRAP));
        return decodePkcs7(read(connection));
    }

    private HttpsURLConnection open(String endpoint, TrustAnchorStore.Anchor anchor, boolean bootstrap)
            throws Exception
    { return open(endpoint, anchor, bootstrap, null); }

    private HttpsURLConnection open(String endpoint, TrustAnchorStore.Anchor anchor, boolean bootstrap, String alias)
            throws Exception
    {
        HttpsURLConnection connection = (HttpsURLConnection)new URL(endpoint).openConnection();
        if (bootstrap) connection.setSSLSocketFactory(insecureContext().getSocketFactory());
        else connection.setSSLSocketFactory(pinnedContext(anchor, alias).getSocketFactory());
        if (bootstrap) connection.setHostnameVerifier((host, session) -> true);
        return connection;
    }

    private static String estEndpoint(String base, String endpoint)
    {
        String normalized = base.endsWith("/") ? base.substring(0, base.length() - 1) : base;
        if (normalized.endsWith("/.well-known/est")) return normalized + "/" + endpoint;
        return normalized + "/.well-known/est/" + endpoint;
    }

    private SSLContext pinnedContext(TrustAnchorStore.Anchor anchor, String alias) throws Exception
    {
        KeyStore trust = KeyStore.getInstance(KeyStore.getDefaultType()); trust.load(null);
        for (X509Certificate certificate : CertificateUtil.parseChain(anchor.rootCertificatePem))
            trust.setCertificateEntry("didev-" + certificate.getSerialNumber(), certificate);
        javax.net.ssl.TrustManagerFactory factory = javax.net.ssl.TrustManagerFactory.getInstance(
                javax.net.ssl.TrustManagerFactory.getDefaultAlgorithm()); factory.init(trust);
        KeyManagerFactory keys = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());
        KeyStore client = KeyStore.getInstance("AndroidKeyStore"); client.load(null);
        keys.init(client, null);
        SSLContext context = SSLContext.getInstance("TLS");
        javax.net.ssl.KeyManager[] managers = keys.getKeyManagers();
        if (alias != null)
            for (int i = 0; i < managers.length; i++)
                if (managers[i] instanceof X509KeyManager)
                    managers[i] = new AliasKeyManager((X509KeyManager)managers[i], alias);
        context.init(managers, factory.getTrustManagers(), null); return context;
    }

    private SSLContext insecureContext() throws Exception
    {
        TrustManager[] managers = { new X509TrustManager()
        {
            public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
            public void checkClientTrusted(X509Certificate[] chain, String authType) { }
            public void checkServerTrusted(X509Certificate[] chain, String authType) { }
        }};
        SSLContext context = SSLContext.getInstance("TLS"); context.init(null, managers, null); return context;
    }

    private static byte[] read(HttpURLConnection connection) throws Exception
    {
        int code = connection.getResponseCode();
        InputStream stream = code >= 400 ? connection.getErrorStream() : connection.getInputStream();
        if (stream == null) throw new IllegalStateException("EST respondio " + code);
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192]; int count;
        while ((count = stream.read(buffer)) >= 0) output.write(buffer, 0, count);
        if (code >= 400) throw new IllegalStateException("EST respondio " + code + ": " + output);
        return output.toByteArray();
    }

    private static byte[] decodePkcs7(byte[] body)
    {
        return Base64.decode(new String(body, StandardCharsets.US_ASCII).trim(), Base64.DEFAULT);
    }

    private static final class AliasKeyManager extends X509ExtendedKeyManager
    {
        private final X509KeyManager delegate; private final String alias;
        AliasKeyManager(X509KeyManager delegate, String alias) { this.delegate = delegate; this.alias = alias; }
        public String[] getClientAliases(String keyType, Principal[] issuers) { return new String[]{alias}; }
        public String chooseClientAlias(String[] keyTypes, Principal[] issuers, Socket socket) { return alias; }
        public String[] getServerAliases(String keyType, Principal[] issuers) { return delegate.getServerAliases(keyType, issuers); }
        public String chooseServerAlias(String keyType, Principal[] issuers, Socket socket) { return delegate.chooseServerAlias(keyType, issuers, socket); }
        public X509Certificate[] getCertificateChain(String requestedAlias) { return delegate.getCertificateChain(alias); }
        public PrivateKey getPrivateKey(String requestedAlias) { return delegate.getPrivateKey(alias); }
        public String chooseEngineClientAlias(String[] keyTypes, Principal[] issuers, javax.net.ssl.SSLEngine engine) { return alias; }
        public String chooseEngineServerAlias(String keyType, Principal[] issuers, javax.net.ssl.SSLEngine engine) { return delegate.chooseServerAlias(keyType, issuers, null); }
    }
}
