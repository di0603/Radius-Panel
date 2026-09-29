/* Copyright (C) didev. GPLv2; see LICENSE-GPLv2.txt. */
package org.strongswan.android.didev;

import android.app.Activity;
import android.content.Intent;
import android.net.VpnService;
import android.os.Bundle;
import android.provider.Settings;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import com.google.zxing.integration.android.IntentIntegrator;
import com.google.zxing.integration.android.IntentResult;

import org.strongswan.android.data.VpnProfileDataSource;
import org.strongswan.android.ui.VpnProfileControlActivity;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.Executors;

public final class DidevMainActivity extends Activity
{
    private static final int FILE = 40, TRUST = 41;
    private DidevProvisioningManager manager;
    private String pendingEnvelope;
    private DidevProvisioningManager.Prepared pendingPrepared;
    private LinearLayout list;

    @Override public void onCreate(Bundle state)
    {
        super.onCreate(state); manager = new DidevProvisioningManager(this); build(); refresh();
    }

    private void build()
    {
        LinearLayout root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL); root.setPadding(24,24,24,24);
        TextView title = new TextView(this); title.setText("didev VPN"); title.setTextSize(28); root.addView(title);
        Button scan = new Button(this); scan.setText("Escanear QR"); scan.setOnClickListener(v -> new IntentIntegrator(this).setCaptureActivity(QrCaptureActivity.class).initiateScan()); root.addView(scan);
        Button file = new Button(this); file.setText("Importar .didevvpn"); file.setOnClickListener(v -> { Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("application/vnd.didev.vpn").addCategory(Intent.CATEGORY_OPENABLE); startActivityForResult(i, FILE); }); root.addView(file);
        list = new LinearLayout(this); list.setOrientation(LinearLayout.VERTICAL); root.addView(list);
        setContentView(root);
    }

    private void refresh()
    {
        list.removeAllViews();
        for (ConnectionStore.Record record : manager.store().all())
        {
            TextView text = new TextView(this); text.setText(record.name + "\n" + record.server + "\nEstado: " + record.state + "\nIP: " + record.ip + "\nCaducidad: " + record.notAfter + "\nUltima renovacion: " + record.lastRenewal + "\nUltimo error: " + record.lastError); text.setTextSize(16); text.setPadding(0, 24, 0, 8); list.addView(text);
            Button connect = new Button(this); connect.setText("Conectar"); connect.setOnClickListener(v -> connect(record)); list.addView(connect);
            Button disconnect = new Button(this); disconnect.setText("Desconectar"); disconnect.setOnClickListener(v -> disconnect(record)); list.addView(disconnect);
            Button remove = new Button(this); remove.setText("Quitar"); remove.setOnClickListener(v -> { manager.store().remove(record.id); manager.anchorStore().remove(record.server); refresh(); }); list.addView(remove);
        }
    }

    private void disconnect(ConnectionStore.Record record)
    {
        Intent intent = new Intent(this, VpnProfileControlActivity.class).setAction(VpnProfileControlActivity.DISCONNECT);
        intent.putExtra(VpnProfileDataSource.KEY_UUID, record.profileUuid); startActivity(intent);
    }

    private void connect(ConnectionStore.Record record)
    {
        Intent prepare = VpnService.prepare(this); if (prepare != null) { startActivityForResult(prepare, 42); return; }
        Intent intent = new Intent(this, VpnProfileControlActivity.class).setAction(VpnProfileControlActivity.START_PROFILE);
        intent.putExtra(VpnProfileDataSource.KEY_UUID, record.profileUuid); startActivity(intent);
    }

    @Override protected void onActivityResult(int request, int result, Intent data)
    {
        super.onActivityResult(request, result, data);
        if (request == FILE && result == RESULT_OK && data != null) try (InputStream input = getContentResolver().openInputStream(data.getData())) { importEnvelope(new String(read(input), StandardCharsets.UTF_8)); } catch (Exception e) { fail(e); }
        if (request == TRUST && result == RESULT_OK) Executors.newSingleThreadExecutor().execute(() -> { try { manager.complete(pendingPrepared); runOnUiThread(this::refresh); } catch (Exception e) { runOnUiThread(() -> fail(e)); } });
        if (request != FILE && request != TRUST) refresh();
        IntentResult scan = IntentIntegrator.parseActivityResult(request, result, data); if (scan != null && scan.getContents() != null) importEnvelope(scan.getContents());
    }

    private void importEnvelope(String envelope)
    {
        pendingEnvelope = envelope; Executors.newSingleThreadExecutor().execute(() -> { try { pendingPrepared = manager.prepare(envelope); ProvisioningProfile p = pendingPrepared.envelope.profile;
            if (manager.anchorStore().matches(p.server, p))
            {
                manager.complete(pendingPrepared); runOnUiThread(this::refresh); return;
            }
            Intent trust = new Intent(this, TrustConfirmationActivity.class).putExtra("server", p.server).putExtra("signerShort", p.shortSignerFingerprint()).putExtra("signerFull", p.signerKeySha256).putExtra("rootShort", p.shortRootFingerprint()).putExtra("rootFull", p.rootCaSha256); runOnUiThread(() -> startActivityForResult(trust, TRUST));
        } catch (Exception e) { runOnUiThread(() -> fail(e)); } });
    }

    private static byte[] read(InputStream input) throws Exception { java.io.ByteArrayOutputStream output = new java.io.ByteArrayOutputStream(); byte[] buffer = new byte[8192]; int n; while ((n=input.read(buffer))>=0) output.write(buffer,0,n); return output.toByteArray(); }
    private void fail(Exception e) { Toast.makeText(this, e.getMessage() == null ? "Operacion rechazada" : e.getMessage(), Toast.LENGTH_LONG).show(); }
}
