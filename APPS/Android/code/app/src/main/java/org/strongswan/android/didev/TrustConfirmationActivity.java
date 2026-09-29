/* Copyright (C) didev. GPLv2; see LICENSE-GPLv2.txt. */
package org.strongswan.android.didev;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.view.View;
import android.widget.Button;

public final class TrustConfirmationActivity extends Activity
{
    @Override public void onCreate(Bundle state)
    {
        super.onCreate(state);
        String server = getIntent().getStringExtra("server");
        String signerShort = getIntent().getStringExtra("signerShort");
        String signerFull = getIntent().getStringExtra("signerFull");
        String rootShort = getIntent().getStringExtra("rootShort");
        String rootFull = getIntent().getStringExtra("rootFull");
        LinearLayout layout = new LinearLayout(this); layout.setOrientation(LinearLayout.VERTICAL); layout.setPadding(32,32,32,32);
        add(layout, "Servidor\n" + server, 20); add(layout, "Huella de la clave del panel\n" + signerShort + "\n" + signerFull, 18);
        add(layout, "Huella de la raiz CA\n" + rootShort + "\n" + rootFull, 18);
        add(layout, "Compara estas huellas con las que muestra el panel. Si no coinciden, cancela", 16);
        Button confirm = new Button(this); confirm.setText("Confirmar y dar de alta"); confirm.setOnClickListener(v -> { setResult(RESULT_OK); finish(); }); layout.addView(confirm);
        Button cancel = new Button(this); cancel.setText("Cancelar"); cancel.setOnClickListener(v -> { setResult(RESULT_CANCELED); finish(); }); layout.addView(cancel);
        setTitle("Confirmar identidad del panel"); setContentView(layout);
    }
    private void add(LinearLayout parent, String text, int size) { TextView view = new TextView(this); view.setText(text); view.setTextSize(size); view.setPadding(0, 12, 0, 12); parent.addView(view); }
}
