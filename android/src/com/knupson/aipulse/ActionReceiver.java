package com.knupson.aipulse;

import android.app.NotificationManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Receptor NO exportado para acciones internas del widget (aprobar, refrescar).
 * Solo recibe intents explícitos de nuestros propios PendingIntent: ninguna otra app puede dispararlo.
 */
public class ActionReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || intent.getAction() == null) return;
        String action = intent.getAction();

        if (PulseWidgetProvider.ACTION_QUICK_APPROVE.equals(action)) {
            handleApprove(context, intent);
        } else if (PulseWidgetProvider.ACTION_REFRESH.equals(action) || Intent.ACTION_USER_PRESENT.equals(action)) {
            handleRefresh(context, intent);
        }
    }

    private void handleApprove(Context context, Intent intent) {
        final Context appCtx = context.getApplicationContext();
        final String sid = intent.getStringExtra(PulseWidgetProvider.EXTRA_SESSION_ID);
        // Validación: solo aprobamos sesiones que la última lectura OK del server reportó en waiting_approval.
        // El provider sale de esa lectura, no del intent.
        final String prov = ConfigStore.findWaitingApprovalProvider(appCtx, sid);
        final boolean valid = prov != null;

        try {
            NotificationManager nm = (NotificationManager) appCtx.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null && sid != null) {
                nm.cancel(Math.abs(sid.hashCode()));
            }
        } catch (Exception ignored) {}

        PulseWidgetProvider.showStatusIndicator(appCtx, valid ? "✅ Aprobando permiso..." : "Permiso ya no pendiente");
        final PendingResult pendingResult = goAsync();
        PulseWidgetProvider.EXECUTOR.execute(() -> {
            try {
                if (valid) {
                    ConfigStore.sendQuickActionWithFallback(appCtx, sid, prov, "approve");
                    try { Thread.sleep(600); } catch (Exception ignored) {}
                }
                PulseWidgetProvider.updateAllWidgetsBlocking(appCtx);
            } finally {
                try {
                    pendingResult.finish();
                } catch (Exception ignored) {}
            }
        });
    }

    private void handleRefresh(Context context, Intent intent) {
        PulseWidgetProvider.schedulePeriodicRefresh(context);
        boolean isManual = intent.getBooleanExtra(PulseWidgetProvider.EXTRA_MANUAL, false);
        if (!isManual && !PulseWidgetProvider.isScreenInteractive(context)) {
            return;
        }
        final Context appCtx = context.getApplicationContext();
        if (isManual) {
            PulseWidgetProvider.showStatusIndicator(appCtx, "Actualizando...");
        }
        final PendingResult pendingResult = goAsync();
        PulseWidgetProvider.EXECUTOR.execute(() -> {
            try {
                PulseWidgetProvider.updateAllWidgetsBlocking(appCtx);
            } finally {
                try {
                    pendingResult.finish();
                } catch (Exception ignored) {}
            }
        });
    }
}
