package com.knupson.aipulse;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.os.Build;
import android.os.PowerManager;
import android.os.SystemClock;
import android.view.View;
import android.widget.RemoteViews;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONObject;

public class PulseWidgetProvider extends AppWidgetProvider {
    public static final String ACTION_REFRESH = "com.knupson.aipulse.ACTION_REFRESH";
    public static final String ACTION_QUICK_APPROVE = "com.knupson.aipulse.ACTION_QUICK_APPROVE";
    public static final String EXTRA_MANUAL = "manual_refresh";
    public static final String EXTRA_SESSION_ID = "session_id";
    public static final String EXTRA_PROVIDER = "provider";
    private static final String NOTIF_CHANNEL_ID = "ai_pulse_alerts";
    private static final ExecutorService EXECUTOR = Executors.newSingleThreadExecutor();

    @Override
    public void onEnabled(Context context) {
        super.onEnabled(context);
        schedulePeriodicRefresh(context);
        requestImmediateUpdate(context);
    }

    @Override
    public void onDisabled(Context context) {
        super.onDisabled(context);
        cancelPeriodicRefresh(context);
    }

    @Override
    public void onUpdate(Context context, AppWidgetManager appWidgetManager, int[] appWidgetIds) {
        schedulePeriodicRefresh(context);
        final PendingResult pendingResult = goAsync();
        final Context appCtx = context.getApplicationContext();
        EXECUTOR.execute(() -> {
            try {
                updateAllWidgetsBlocking(appCtx);
            } finally {
                try {
                    pendingResult.finish();
                } catch (Exception ignored) {}
            }
        });
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        super.onReceive(context, intent);
        if (intent == null || intent.getAction() == null) return;
        String action = intent.getAction();

        if (ACTION_QUICK_APPROVE.equals(action)) {
            final Context appCtx = context.getApplicationContext();
            final String sid = intent.getStringExtra(EXTRA_SESSION_ID);
            final String prov = intent.getStringExtra(EXTRA_PROVIDER);
            showStatusIndicator(appCtx, "✅ Aprobando permiso...");
            try {
                NotificationManager nm = (NotificationManager) appCtx.getSystemService(Context.NOTIFICATION_SERVICE);
                if (nm != null && sid != null) {
                    nm.cancel(Math.abs(sid.hashCode()));
                }
            } catch (Exception ignored) {}
            final PendingResult pendingResult = goAsync();
            EXECUTOR.execute(() -> {
                try {
                    if (sid != null && !sid.isEmpty()) {
                        ConfigStore.sendQuickActionWithFallback(appCtx, sid, prov != null ? prov : "claude", "approve");
                        try { Thread.sleep(600); } catch (Exception ignored) {}
                    }
                    updateAllWidgetsBlocking(appCtx);
                } finally {
                    try {
                        pendingResult.finish();
                    } catch (Exception ignored) {}
                }
            });
            return;
        }

        if (ACTION_REFRESH.equals(action) || Intent.ACTION_USER_PRESENT.equals(action)) {
            schedulePeriodicRefresh(context);
            boolean isManual = intent.getBooleanExtra(EXTRA_MANUAL, false);
            if (!isManual && !isScreenInteractive(context)) {
                return;
            }
            final Context appCtx = context.getApplicationContext();
            if (isManual) {
                showStatusIndicator(appCtx, "Actualizando...");
            }
            final PendingResult pendingResult = goAsync();
            EXECUTOR.execute(() -> {
                try {
                    updateAllWidgetsBlocking(appCtx);
                } finally {
                    try {
                        pendingResult.finish();
                    } catch (Exception ignored) {}
                }
            });
        }
    }

    private static boolean isScreenInteractive(Context ctx) {
        try {
            PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
            return pm == null || pm.isInteractive();
        } catch (Exception ignored) {
            return true;
        }
    }

    public static void requestImmediateUpdate(Context context) {
        final Context appCtx = context.getApplicationContext();
        schedulePeriodicRefresh(appCtx);
        EXECUTOR.execute(() -> updateAllWidgetsBlocking(appCtx));
    }

    private static void showStatusIndicator(Context ctx, String text) {
        try {
            AppWidgetManager mgr = AppWidgetManager.getInstance(ctx);
            int[] ids = mgr.getAppWidgetIds(new ComponentName(ctx, PulseWidgetProvider.class));
            if (ids == null || ids.length == 0) return;
            for (int id : ids) {
                RemoteViews rv = new RemoteViews(ctx.getPackageName(), R.layout.widget_pulse);
                rv.setTextViewText(R.id.tv_summary, text);
                mgr.partiallyUpdateAppWidget(id, rv);
            }
        } catch (Exception ignored) {}
    }

    private static void updateAllWidgetsBlocking(Context ctx) {
        AppWidgetManager mgr = AppWidgetManager.getInstance(ctx);
        int[] ids = mgr.getAppWidgetIds(new ComponentName(ctx, PulseWidgetProvider.class));

        String liveJson = ConfigStore.fetchCompactJsonWithFallback(ctx);
        boolean isCached = false;
        String jsonToRender = liveJson;
        if (jsonToRender == null || jsonToRender.isEmpty()) {
            jsonToRender = ConfigStore.getLastGoodJson(ctx);
            isCached = (jsonToRender != null && !jsonToRender.isEmpty());
        } else {
            try {
                checkAndPostNotifications(ctx, new JSONObject(liveJson));
            } catch (Exception ignored) {}
        }

        if (ids == null || ids.length == 0) return;
        for (int id : ids) {
            RemoteViews rv = buildRemoteViews(ctx, jsonToRender, isCached, id);
            mgr.updateAppWidget(id, rv);
        }
    }

    private static RemoteViews buildRemoteViews(Context ctx, String rawJson, boolean isCached, int widgetId) {
        RemoteViews rv = new RemoteViews(ctx.getPackageName(), R.layout.widget_pulse);

        // Intent para abrir la App Completa al tocar el contenedor del widget
        Intent openAppIntent = new Intent(ctx, MainActivity.class);
        openAppIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent openAppPi = PendingIntent.getActivity(
                ctx,
                100 + widgetId,
                openAppIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        rv.setOnClickPendingIntent(R.id.widget_root, openAppPi);

        // Intent para el botón ↻ Refrescar (manual = true)
        Intent refreshIntent = new Intent(ctx, PulseWidgetProvider.class);
        refreshIntent.setAction(ACTION_REFRESH);
        refreshIntent.putExtra(EXTRA_MANUAL, true);
        PendingIntent refreshPi = PendingIntent.getBroadcast(
                ctx,
                200 + widgetId,
                refreshIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        rv.setOnClickPendingIntent(R.id.btn_refresh, refreshPi);

        int[] rowIds = new int[] { R.id.row_1, R.id.row_2, R.id.row_3 };
        int[] provIds = new int[] { R.id.r1_prov, R.id.r2_prov, R.id.r3_prov };
        int[] titleIds = new int[] { R.id.r1_title, R.id.r2_title, R.id.r3_title };
        int[] statusIds = new int[] { R.id.r1_status, R.id.r2_status, R.id.r3_status };
        int[] approveIds = new int[] { R.id.r1_approve, R.id.r2_approve, R.id.r3_approve };

        for (int i = 0; i < rowIds.length; i++) {
            rv.setViewVisibility(rowIds[i], View.GONE);
            rv.setViewVisibility(approveIds[i], View.GONE);
        }

        if (rawJson == null || rawJson.isEmpty()) {
            rv.setTextViewText(R.id.tv_brand, "○ AI PULSE");
            rv.setTextColor(R.id.tv_brand, Color.parseColor("#E09F3E"));
            rv.setTextViewText(R.id.tv_summary, "Sin conexión con PC");
            rv.setTextViewText(R.id.tv_quotas, "Tocá ↻");
            rv.setTextViewText(
                    R.id.tv_footer,
                    "Tocá ↻ para actualizar o abrí la App (" + ConfigStore.getShortConnectionTag(ctx) + ")");
            return rv;
        }

        try {
            JSONObject root = new JSONObject(rawJson);
            if (!isCached) {
                String lanBase = root.optString("lanBase", "");
                String tunnelBase = root.optString("tunnelBase", "");
                ConfigStore.saveDiscoveredBases(ctx, null, lanBase, tunnelBase);
            }

            JSONObject sum = root.optJSONObject("summary");
            int openCount = sum != null ? sum.optInt("openCount", 0) : 0;
            int workingCount = sum != null ? sum.optInt("workingCount", 0) : 0;
            int waitingCount = sum != null ? sum.optInt("waitingCount", 0) : 0;
            int approvalCount = sum != null ? sum.optInt("approvalCount", 0) : 0;

            if (approvalCount > 0) {
                rv.setTextViewText(R.id.tv_brand, "⚠️ AI PULSE");
                rv.setTextColor(R.id.tv_brand, Color.parseColor("#F59E0B"));
            } else if (waitingCount > 0) {
                rv.setTextViewText(R.id.tv_brand, "● AI PULSE");
                rv.setTextColor(R.id.tv_brand, Color.parseColor("#10B981"));
            } else if (workingCount > 0) {
                rv.setTextViewText(R.id.tv_brand, "⚡ AI PULSE");
                rv.setTextColor(R.id.tv_brand, Color.parseColor("#FF6B1A"));
            } else {
                rv.setTextViewText(R.id.tv_brand, "● AI PULSE");
                rv.setTextColor(R.id.tv_brand, Color.parseColor("#FF6B1A"));
            }

            String summaryText = openCount + " abiertas";
            if (approvalCount > 0) {
                summaryText += " · " + approvalCount + " permiso!";
            } else if (waitingCount > 0) {
                summaryText += " · " + waitingCount + " listas";
            } else if (workingCount > 0) {
                summaryText += " · " + workingCount + " activas";
            }
            rv.setTextViewText(R.id.tv_summary, summaryText);

            JSONObject quotas = root.optJSONObject("quotas");
            int cl5h = quotas != null ? quotas.optInt("claude5hPct", 0) : 0;
            int cl7d = quotas != null ? quotas.optInt("claude7dPct", 0) : 0;
            int agy5h = quotas != null ? quotas.optInt("agy5hPct", 0) : 0;
            int agy7d = quotas != null ? quotas.optInt("agy7dPct", 0) : 0;
            rv.setTextViewText(
                    R.id.tv_quotas,
                    "CL " + cl5h + "/" + cl7d + "% · AGY " + agy5h + "/" + agy7d + "%");
            int maxPct = Math.max(Math.max(cl5h, cl7d), Math.max(agy5h, agy7d));
            if (maxPct >= 100) {
                rv.setTextColor(R.id.tv_quotas, Color.parseColor("#F87171"));
            } else if (maxPct >= 85) {
                rv.setTextColor(R.id.tv_quotas, Color.parseColor("#FBBF24"));
            } else {
                rv.setTextColor(R.id.tv_quotas, Color.parseColor("#E09F3E"));
            }

            JSONArray sessions = root.optJSONArray("sessions");
            int count = sessions != null ? Math.min(sessions.length(), 3) : 0;
            for (int i = 0; i < count; i++) {
                JSONObject s = sessions.getJSONObject(i);
                String sid = s.optString("id", "");
                String prov = s.optString("provider", "agy");
                String provLabel = s.optString("providerLabel", "AGY");
                String proj = s.optString("projectName", "Consola");
                String state = s.optString("state", "idle");
                String statusText = s.optString("statusText", "● Activa");

                rv.setViewVisibility(rowIds[i], View.VISIBLE);
                rv.setTextViewText(provIds[i], provLabel);
                rv.setTextColor(
                        provIds[i],
                        "claude".equalsIgnoreCase(prov)
                                ? Color.parseColor("#FF6B1A")
                                : Color.parseColor("#FACC15"));

                rv.setTextViewText(titleIds[i], proj);
                rv.setTextViewText(statusIds[i], statusText);

                int stColor = Color.parseColor("#9A8878");
                if ("waiting_approval".equals(state)) {
                    stColor = Color.parseColor("#F59E0B");
                } else if ("waiting_input".equals(state)) {
                    stColor = Color.parseColor("#10B981");
                } else if ("running".equals(state) || "working".equals(state)) {
                    stColor = Color.parseColor("#FF6B1A");
                }
                rv.setTextColor(statusIds[i], stColor);

                if ("waiting_approval".equals(state)) {
                    rv.setViewVisibility(approveIds[i], View.VISIBLE);
                    Intent appIntent = new Intent(ctx, PulseWidgetProvider.class);
                    appIntent.setAction(ACTION_QUICK_APPROVE);
                    appIntent.putExtra(EXTRA_SESSION_ID, sid);
                    appIntent.putExtra(EXTRA_PROVIDER, prov);
                    PendingIntent appPi = PendingIntent.getBroadcast(
                            ctx,
                            500 + widgetId * 10 + i,
                            appIntent,
                            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
                    rv.setOnClickPendingIntent(approveIds[i], appPi);
                } else {
                    rv.setViewVisibility(approveIds[i], View.GONE);
                }

                Intent rowIntent = new Intent(ctx, MainActivity.class);
                rowIntent.putExtra("session_id", sid);
                rowIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
                PendingIntent rowPi = PendingIntent.getActivity(
                        ctx,
                        300 + widgetId * 10 + i,
                        rowIntent,
                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
                rv.setOnClickPendingIntent(rowIds[i], rowPi);
            }

            long ts = isCached ? ConfigStore.getLastGoodTimestamp(ctx) : System.currentTimeMillis();
            String hhmm = new SimpleDateFormat("HH:mm", Locale.getDefault()).format(new Date(ts > 0 ? ts : System.currentTimeMillis()));
            String modeTag = ConfigStore.getShortConnectionTag(ctx);
            String prefix = isCached ? "Últ. estado " : "Sincronizado ";
            rv.setTextViewText(
                    R.id.tv_footer,
                    prefix + hhmm + " (" + modeTag + ") · Tocá una fila para responder");
        } catch (Exception e) {
            rv.setTextViewText(R.id.tv_summary, "Error de lectura");
        }

        return rv;
    }

    private static void schedulePeriodicRefresh(Context ctx) {
        try {
            AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
            if (am == null) return;
            Intent intent = new Intent(ctx, PulseWidgetProvider.class);
            intent.setAction(ACTION_REFRESH);
            intent.putExtra(EXTRA_MANUAL, false);
            PendingIntent pi = PendingIntent.getBroadcast(
                    ctx,
                    901,
                    intent,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            // setWindow cada 2 minutos mientras el teléfono está despierto (sobrevive al cierre de la app)
            long intervalMs = 2 * 60 * 1000L;
            am.setWindow(
                    AlarmManager.ELAPSED_REALTIME,
                    SystemClock.elapsedRealtime() + intervalMs,
                    30_000L,
                    pi);
        } catch (Exception ignored) {}
    }

    private static void cancelPeriodicRefresh(Context ctx) {
        try {
            AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
            if (am == null) return;
            Intent intent = new Intent(ctx, PulseWidgetProvider.class);
            intent.setAction(ACTION_REFRESH);
            PendingIntent pi = PendingIntent.getBroadcast(
                    ctx,
                    901,
                    intent,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            am.cancel(pi);
        } catch (Exception ignored) {}
    }

    private static void checkAndPostNotifications(Context ctx, JSONObject root) {
        try {
            NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;

            if (Build.VERSION.SDK_INT >= 26) {
                NotificationChannel ch = new NotificationChannel(
                        NOTIF_CHANNEL_ID,
                        "Alertas de Consolas IA",
                        NotificationManager.IMPORTANCE_HIGH);
                ch.setDescription("Avisa cuando una consola pide permiso, termina su tarea o se resetea tu cuota.");
                nm.createNotificationChannel(ch);
            }

            SharedPreferences prefs = ConfigStore.prefs(ctx);
            boolean hadPrevSnapshot = prefs.getBoolean("notif_initialized", false);
            String prevMapStr = prefs.getString("last_notified_states", "{}");
            JSONObject prevStates;
            try {
                prevStates = new JSONObject(prevMapStr);
            } catch (Exception e) {
                prevStates = new JSONObject();
            }

            JSONObject nextStates = new JSONObject();
            JSONArray sessions = root.optJSONArray("sessions");
            if (sessions != null) {
                for (int i = 0; i < sessions.length(); i++) {
                    JSONObject s = sessions.optJSONObject(i);
                    if (s == null) continue;
                    String sid = s.optString("id", "");
                    String state = s.optString("state", "idle");
                    String prov = s.optString("provider", "claude");
                    String provLabel = s.optString("providerLabel", "IA");
                    String proj = s.optString("projectName", "Consola");
                    if (sid.isEmpty()) continue;

                    nextStates.put(sid, state);
                    String prevState = prevStates.optString(sid, "");

                    if (hadPrevSnapshot && !state.equals(prevState)) {
                        if ("waiting_approval".equals(state)) {
                            postSessionNotification(
                                    ctx,
                                    nm,
                                    sid,
                                    prov,
                                    "⚠️ Permiso requerido · " + proj,
                                    "[" + provLabel + "] Tocá para abrir o aprobá directo desde acá.",
                                    true);
                        } else if ("waiting_input".equals(state) && ("running".equals(prevState) || "working".equals(prevState))) {
                            postSessionNotification(
                                    ctx,
                                    nm,
                                    sid,
                                    prov,
                                    "✅ Consola lista · " + proj,
                                    "[" + provLabel + "] Terminó su tarea y espera tu respuesta.",
                                    false);
                        }
                    }
                }
            }

            JSONObject quotas = root.optJSONObject("quotas");
            String resetId = quotas != null ? quotas.optString("claudeResetId", "") : "";
            String resetMsg = quotas != null ? quotas.optString("claudeResetMsg", "") : "";
            String prevResetId = prefs.getString("last_notified_reset_id", "");

            SharedPreferences.Editor ed = prefs.edit();
            ed.putString("last_notified_states", nextStates.toString());
            ed.putBoolean("notif_initialized", true);
            if (!resetId.isEmpty()) {
                if (hadPrevSnapshot && !resetId.equals(prevResetId) && !resetMsg.isEmpty()) {
                    postSessionNotification(
                            ctx,
                            nm,
                            "quota_reset",
                            "claude",
                            "🎁 Cuota Claude Actualizada",
                            resetMsg,
                            false);
                }
                ed.putString("last_notified_reset_id", resetId);
            }
            ed.commit();
        } catch (Exception ignored) {}
    }

    private static void postSessionNotification(
            Context ctx,
            NotificationManager nm,
            String sid,
            String prov,
            String title,
            String body,
            boolean includeApproveAction) {
        try {
            int notifId = Math.abs(sid.hashCode());
            Intent openIntent = new Intent(ctx, MainActivity.class);
            if (!"quota_reset".equals(sid)) {
                openIntent.putExtra(EXTRA_SESSION_ID, sid);
            }
            openIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            PendingIntent contentPi = PendingIntent.getActivity(
                    ctx,
                    notifId % 100000,
                    openIntent,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

            Notification.Builder nb;
            if (Build.VERSION.SDK_INT >= 26) {
                nb = new Notification.Builder(ctx, NOTIF_CHANNEL_ID);
            } else {
                nb = new Notification.Builder(ctx);
            }
            nb.setSmallIcon(R.drawable.ic_launcher)
                    .setContentTitle(title)
                    .setContentText(body)
                    .setAutoCancel(true)
                    .setContentIntent(contentPi);

            if (includeApproveAction) {
                Intent appIntent = new Intent(ctx, PulseWidgetProvider.class);
                appIntent.setAction(ACTION_QUICK_APPROVE);
                appIntent.putExtra(EXTRA_SESSION_ID, sid);
                appIntent.putExtra(EXTRA_PROVIDER, prov);
                PendingIntent appPi = PendingIntent.getBroadcast(
                        ctx,
                        (notifId % 100000) + 1,
                        appIntent,
                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
                Notification.Action action = new Notification.Action.Builder(
                        0, "✅ Aprobar (y)", appPi).build();
                nb.addAction(action);
            }

            nm.notify(notifId, nb.build());
        } catch (Exception ignored) {}
    }
}
