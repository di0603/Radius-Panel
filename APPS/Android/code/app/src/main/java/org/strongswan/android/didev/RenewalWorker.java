/* Copyright (C) didev. GPLv2; see LICENSE-GPLv2.txt. */
package org.strongswan.android.didev;

import android.content.Context;
import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import java.security.cert.X509Certificate;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import org.strongswan.android.data.VpnProfile;
import org.strongswan.android.data.VpnProfileDataSource;
import org.strongswan.android.data.VpnProfileSource;

/** Runs every 12 hours while online; it never changes a trust anchor. */
public final class RenewalWorker extends Worker
{
    public RenewalWorker(@NonNull Context context, @NonNull WorkerParameters parameters) { super(context, parameters); }

    @NonNull @Override public Result doWork()
    {
        DidevProvisioningManager manager = new DidevProvisioningManager(getApplicationContext());
        DeviceKeyManager keys = new DeviceKeyManager(); EstClient est = new EstClient();
        for (ConnectionStore.Record record : manager.store().all())
        {
            try
            {
                ProvisioningProfile profile = ProvisioningProfile.parse(record.profileJson);
                TrustAnchorStore.Anchor anchor = manager.anchorStore().get(profile.server);
                if (anchor == null || !manager.anchorStore().matches(profile.server, profile)) throw new SecurityException("la identidad del panel ha cambiado");
                EstClient.Status status = est.status(profile, anchor, record.keyAlias);
                if (DidevProvisioningManager.compareVersions(status.minAppVersion, "1.0.0") > 0) throw new IllegalStateException("version minima superior");
                X509Certificate current = keys.certificate(record.keyAlias);
                if (current != null && current.getNotAfter().toInstant().isAfter(Instant.now().plus(7, ChronoUnit.DAYS))) continue;
                String nextAlias = DeviceKeyManager.aliasFor(record.id + "-" + System.currentTimeMillis());
                keys.generate(nextAlias);
                List<X509Certificate> nextChain = CertificateUtil.parseDer(est.simpleReEnroll(profile, keys.csr(nextAlias, profile.cn), anchor, current, nextAlias));
                keys.installCertificateChain(nextAlias, nextChain);
                VpnProfileDataSource source = new VpnProfileSource(getApplicationContext()); source.open();
                try { VpnProfile vpn = source.getVpnProfile(record.profileUuid); if (vpn != null) { vpn.setUserCertificateAlias(nextAlias); source.updateVpnProfile(vpn); } }
                finally { source.close(); }
                record.keyAlias = nextAlias; record.ip = status.ip; record.notAfter = status.notAfter; record.lastRenewal = Instant.now().toString(); record.lastError = ""; manager.store().save(record);
            }
            catch (Exception error)
            {
                record.lastError = error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage(); manager.store().save(record);
            }
        }
        return Result.success();
    }
}
