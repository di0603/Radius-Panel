/* Copyright (C) didev. GPLv2; see LICENSE-GPLv2.txt. */
package org.strongswan.android.didev;

import android.content.Context;

import org.strongswan.android.data.VpnProfile;
import org.strongswan.android.data.VpnProfileDataSource;
import org.strongswan.android.data.VpnProfileSource;
import org.strongswan.android.data.VpnType;

import java.security.cert.X509Certificate;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

/** Import, first-use confirmation, EST enrollment and native-profile bridge. */
public final class DidevProvisioningManager
{
    public static final class Prepared
    {
        public final ProfileEnvelope envelope;
        public final String rootPem;
        public Prepared(ProfileEnvelope envelope, String rootPem) { this.envelope = envelope; this.rootPem = rootPem; }
    }

    private final Context context;
    private final ProfileVerifier verifier = new ProfileVerifier();
    private final EstClient est = new EstClient();
    private final DeviceKeyManager keys = new DeviceKeyManager();
    private final TrustAnchorStore anchors;
    private final ConnectionStore connections;

    public DidevProvisioningManager(Context context)
    { this.context = context.getApplicationContext(); anchors = new TrustAnchorStore(context); connections = new ConnectionStore(context); }

    public Prepared prepare(String envelopeText) throws Exception
    {
        ProfileEnvelope envelope = ProfileEnvelope.parse(envelopeText);
        verifier.verify(envelope);
        List<X509Certificate> chain;
        if ("full".equals(envelope.profile.variant)) chain = CertificateUtil.parseChain(envelope.profile.caChainPem);
        else chain = est.fetchBootstrapChain(envelope.profile.estBaseUrl);
        X509Certificate root = findRoot(chain);
        if (!Fingerprint.equalHex(envelope.profile.rootCaSha256, root.getEncoded()))
            throw new SecurityException("la raiz de /cacerts no coincide con rootCaSha256");
        String rootPem = CertificateUtil.toPem(root);
        TrustAnchorStore.Anchor anchor = anchors.get(envelope.profile.server);
        if (anchor != null && (!anchor.signerKeySha256.equalsIgnoreCase(envelope.profile.signerKeySha256)
                || !anchor.rootCaSha256.equalsIgnoreCase(envelope.profile.rootCaSha256)))
            throw new SecurityException("la identidad del panel ha cambiado; quita la conexion y anadela de nuevo");
        return new Prepared(envelope, rootPem);
    }

    public ConnectionStore.Record complete(Prepared prepared) throws Exception
    {
        ProvisioningProfile profile = prepared.envelope.profile;
        anchors.save(profile.server, profile, prepared.rootPem);
        String id = UUID.randomUUID().toString();
        String alias = DeviceKeyManager.aliasFor(id);
        keys.generate(alias);
        byte[] csr = keys.csr(alias, profile.cn);
        TrustAnchorStore.Anchor anchor = anchors.get(profile.server);
        byte[] response = est.simpleEnroll(profile, csr, anchor);
        List<X509Certificate> chain = CertificateUtil.parseDer(response);
        keys.installCertificateChain(alias, chain);
        EstClient.Status status = est.status(profile, anchor, alias);
        if (compareVersions(status.minAppVersion, "1.0.0") > 0)
            throw new IllegalStateException("La app necesita actualizarse a " + status.minAppVersion);

        VpnProfile vpn = new VpnProfile();
        vpn.setName(profile.server); vpn.setGateway(profile.server); vpn.setVpnType(VpnType.IKEV2_EAP_TLS);
        vpn.setRemoteId(profile.aaaId); vpn.setLocalId(profile.cn); vpn.setUserCertificateAlias(alias);
        vpn.setCertificateAlias("didev-ca-" + profile.server);
        vpn.setIkeProposal(profile.ike); vpn.setEspProposal(profile.esp); vpn.setDnsServers(profile.dns);
        if ("split".equals(profile.tunnelMode)) vpn.setIncludedSubnets(android.text.TextUtils.join(" ", profile.splitRoutes));
        VpnProfileDataSource source = new VpnProfileSource(context); source.open();
        try { source.insertProfile(vpn); } finally { source.close(); }

        ConnectionStore.Record record = new ConnectionStore.Record(); record.id = id; record.name = profile.server;
        record.server = profile.server; record.profileJson = new String(prepared.envelope.payloadBytes, java.nio.charset.StandardCharsets.UTF_8);
        record.profileUuid = vpn.getUUID().toString();
        record.keyAlias = alias; record.state = "Listo"; record.ip = status.ip; record.notAfter = status.notAfter;
        record.lastRenewal = Instant.now().toString(); record.lastError = ""; connections.save(record); return record;
    }

    public ConnectionStore store() { return connections; }
    public TrustAnchorStore anchorStore() { return anchors; }

    private static X509Certificate findRoot(List<X509Certificate> chain)
    {
        for (X509Certificate certificate : chain) if (certificate.getSubjectX500Principal().equals(certificate.getIssuerX500Principal())) return certificate;
        return chain.get(chain.size() - 1);
    }

    static int compareVersions(String left, String right)
    {
        String[] a = left.split("\\."), b = right.split("\\.");
        for (int i=0;i<Math.max(a.length,b.length);i++) { int x=i<a.length?Integer.parseInt(a[i]):0, y=i<b.length?Integer.parseInt(b[i]):0; if (x!=y) return Integer.compare(x,y); }
        return 0;
    }
}
