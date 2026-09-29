/* Copyright (C) didev; GPLv2. */
package org.strongswan.android.didev;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class TrustAnchorInstrumentedTest
{
    @Test public void firstImportIsUnanchoredUntilConfirmation()
    {
        TrustAnchorStore store = new TrustAnchorStore(InstrumentationRegistry.getInstrumentation().getTargetContext());
        store.remove("first-import.example");
        assertFalse(store.matches("first-import.example", null));
    }

    @Test public void removingConnectionRemovesAnchor()
    {
        TrustAnchorStore store = new TrustAnchorStore(InstrumentationRegistry.getInstrumentation().getTargetContext());
        store.remove("changed-root.example");
        assertTrue(store.get("changed-root.example") == null);
    }
}
