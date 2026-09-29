/* Copyright (C) didev. GPLv2; see LICENSE-GPLv2.txt. */
package org.strongswan.android.didev;

import android.content.Context;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import java.util.concurrent.TimeUnit;

public final class RenewalScheduler
{
    private RenewalScheduler() { }
    public static void schedule(Context context)
    {
        Constraints constraints = new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
        PeriodicWorkRequest request = new PeriodicWorkRequest.Builder(RenewalWorker.class, 12, TimeUnit.HOURS).setConstraints(constraints).build();
        WorkManager.getInstance(context).enqueueUniquePeriodicWork("didev-vpn-renewal", ExistingPeriodicWorkPolicy.KEEP, request);
    }
}
