package org.porchday.app;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import com.google.androidbrowserhelper.trusted.LauncherActivity;

/** Browser-owned storage/crypto; no JavaScript bridge or native key extraction. */
public final class MainActivity extends LauncherActivity {
    @Override protected void onCreate(Bundle state) {
        Intent incoming = getIntent();
        String candidate = Intent.ACTION_VIEW.equals(incoming.getAction()) ? incoming.getDataString() : null;
        // Discard arbitrary caller extras, ClipData, share payloads and grants.
        setIntent(new Intent(Intent.ACTION_VIEW, Uri.parse(LaunchPolicy.destination(candidate))));
        super.onCreate(state);
    }
    @Override protected Uri getLaunchingUrl() {
        // The base implementation logs incoming URLs; invitation/recovery tokens must not be logged.
        return Uri.parse(LaunchPolicy.destination(getIntent().getDataString()));
    }
}
