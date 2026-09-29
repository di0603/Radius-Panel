/* Copyright (C) didev. GPLv2; see LICENSE-GPLv2.txt. */
package org.strongswan.android.didev;

import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;

import org.bouncycastle.asn1.DEROctetString;
import org.bouncycastle.asn1.x500.X500Name;
import org.bouncycastle.asn1.x509.Extension;
import org.bouncycastle.asn1.x509.Extensions;
import org.bouncycastle.asn1.x509.GeneralName;
import org.bouncycastle.asn1.x509.GeneralNames;
import org.bouncycastle.asn1.x509.SubjectPublicKeyInfo;
import org.bouncycastle.asn1.pkcs.PKCSObjectIdentifiers;
import org.bouncycastle.cert.jcajce.JcaPKCS10CertificationRequestBuilder;
import org.bouncycastle.operator.ContentSigner;
import org.bouncycastle.pkcs.PKCS10CertificationRequest;
import org.bouncycastle.pkcs.PKCS10CertificationRequestBuilder;

import java.io.ByteArrayOutputStream;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.Signature;
import java.security.cert.X509Certificate;
import java.util.Locale;
import java.util.List;

/** Generates non-exportable EC keys and signs the CSR through AndroidKeyStore. */
public final class DeviceKeyManager
{
    public static String aliasFor(String connectionId) { return "didev-vpn-" + connectionId; }

    public KeyPair generate(String alias) throws Exception
    {
        KeyPairGenerator generator = KeyPairGenerator.getInstance("EC", "AndroidKeyStore");
        KeyGenParameterSpec.Builder builder = new KeyGenParameterSpec.Builder(alias,
                KeyProperties.PURPOSE_SIGN | KeyProperties.PURPOSE_VERIFY)
                .setAlgorithmParameterSpec(new java.security.spec.ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256, KeyProperties.DIGEST_SHA384)
                .setUserAuthenticationRequired(false);
        if (Build.VERSION.SDK_INT >= 28)
        {
            try { builder.setIsStrongBoxBacked(true); } catch (Exception ignored) { }
        }
        generator.initialize(builder.build());
        return generator.generateKeyPair();
    }

    public PrivateKey privateKey(String alias) throws Exception
    {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        return (PrivateKey)store.getKey(alias, null);
    }

    public X509Certificate certificate(String alias) throws Exception
    {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        return (X509Certificate)store.getCertificate(alias);
    }

    public byte[] csr(String alias, String cn) throws Exception
    {
        PublicKey publicKey = certificate(alias) == null ? publicKey(alias) : certificate(alias).getPublicKey();
        PKCS10CertificationRequestBuilder builder = new JcaPKCS10CertificationRequestBuilder(
                new X500Name("CN=" + cn), publicKey);
        GeneralNames names = new GeneralNames(new GeneralName(GeneralName.dNSName, cn));
        Extensions extensions = new Extensions(new Extension(Extension.subjectAlternativeName,
                false, new DEROctetString(names.getEncoded())));
        builder.addAttribute(PKCSObjectIdentifiers.pkcs_9_at_extensionRequest, extensions);
        ContentSigner signer = new KeyStoreContentSigner(privateKey(alias));
        return builder.build(signer).getEncoded();
    }

    public void installCertificateChain(String alias, List<X509Certificate> chain) throws Exception
    {
        if (chain.isEmpty()) throw new IllegalArgumentException("cadena de certificado vacia");
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        store.setKeyEntry(alias, privateKey(alias), null, chain.toArray(new X509Certificate[0]));
    }

    private PublicKey publicKey(String alias) throws Exception
    {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        return store.getCertificate(alias).getPublicKey();
    }

    private static final class KeyStoreContentSigner implements ContentSigner
    {
        private final ByteArrayOutputStream output = new ByteArrayOutputStream();
        private final PrivateKey key;
        KeyStoreContentSigner(PrivateKey key) { this.key = key; }
        public org.bouncycastle.asn1.x509.AlgorithmIdentifier getAlgorithmIdentifier()
        { return new org.bouncycastle.asn1.x509.AlgorithmIdentifier(
                org.bouncycastle.asn1.x9.X9ObjectIdentifiers.ecdsa_with_SHA256); }
        public ByteArrayOutputStream getOutputStream() { return output; }
        public byte[] getSignature() throws Exception
        {
            Signature signature = Signature.getInstance("SHA256withECDSA");
            signature.initSign(key); signature.update(output.toByteArray()); return signature.sign();
        }
    }
}
