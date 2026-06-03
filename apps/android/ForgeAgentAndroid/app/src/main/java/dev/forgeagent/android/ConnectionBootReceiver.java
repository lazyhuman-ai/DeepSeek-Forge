package dev.forgeagent.android;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;

public final class ConnectionBootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent == null ? null : intent.getAction();
        if (!Intent.ACTION_BOOT_COMPLETED.equals(action) && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) return;
        SharedPreferences prefs = context.getSharedPreferences(MainActivity.PREFS, Context.MODE_PRIVATE);
        String token = prefs.getString(MainActivity.PREF_TOKEN, "");
        if (token == null || token.isEmpty()) return;
        Intent serviceIntent = new Intent(context, ConnectionMonitorService.class);
        context.startForegroundService(serviceIntent);
    }
}
