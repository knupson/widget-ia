package com.knupson.aipulse;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.PowerManager;
import android.provider.Settings;
import android.text.InputType;
import android.view.Gravity;
import android.view.ViewGroup;
import android.view.Window;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

public class MainActivity extends Activity {
    private WebView webView;
    private TextView statusBadge;
    private String loadedBaseUrl = "";
    private final ExecutorService executor = Executors.newSingleThreadExecutor();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        requestWindowFeature(Window.FEATURE_NO_TITLE);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.parseColor("#090705"));

        // Barra superior nativa compacta con controles de sincronización de Widget y Ajustes de Red
        LinearLayout topBar = new LinearLayout(this);
        topBar.setOrientation(LinearLayout.HORIZONTAL);
        topBar.setGravity(Gravity.CENTER_VERTICAL);
        topBar.setBackgroundColor(Color.parseColor("#120D09"));
        int padH = dp(10);
        int padV = dp(7);
        topBar.setPadding(padH, padV, padH, padV);

        TextView brand = new TextView(this);
        brand.setText("● AI PULSE");
        brand.setTextColor(Color.parseColor("#FF6B1A"));
        brand.setTextSize(12.5f);
        brand.setTypeface(Typeface.DEFAULT_BOLD);
        topBar.addView(brand);

        statusBadge = new TextView(this);
        statusBadge.setText("Conectando...");
        statusBadge.setTextColor(Color.parseColor("#E09F3E"));
        statusBadge.setTextSize(10.5f);
        statusBadge.setSingleLine(true);
        LinearLayout.LayoutParams badgeLp = new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        badgeLp.setMarginStart(dp(8));
        topBar.addView(statusBadge, badgeLp);

        TextView btnSyncWidget = new TextView(this);
        btnSyncWidget.setText("↻ Sync");
        btnSyncWidget.setTextColor(Color.parseColor("#FAF4ED"));
        btnSyncWidget.setTextSize(10.5f);
        btnSyncWidget.setPadding(dp(8), dp(4), dp(8), dp(4));
        btnSyncWidget.setBackgroundColor(Color.parseColor("#241911"));
        btnSyncWidget.setOnClickListener(v -> {
            PulseWidgetProvider.requestImmediateUpdate(this);
            loadedBaseUrl = "";
            connectAndLoad(getIntentSessionId(), true);
            Toast.makeText(this, "Sincronizando App y Widget...", Toast.LENGTH_SHORT).show();
        });
        topBar.addView(btnSyncWidget);

        TextView btnSettings = new TextView(this);
        btnSettings.setText("⚙️ Red");
        btnSettings.setTextColor(Color.parseColor("#FAF4ED"));
        btnSettings.setTextSize(10.5f);
        btnSettings.setPadding(dp(8), dp(4), dp(8), dp(4));
        btnSettings.setBackgroundColor(Color.parseColor("#241911"));
        LinearLayout.LayoutParams setLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        setLp.setMarginStart(dp(5));
        btnSettings.setOnClickListener(v -> showConnectionDialog());
        topBar.addView(btnSettings, setLp);

        root.addView(topBar, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        webView = new WebView(this);
        webView.setBackgroundColor(Color.parseColor("#090705"));
        WebSettings ws = webView.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setDatabaseEnabled(true);
        // CRÍTICO para responsive móvil: usar el ancho nativo del dispositivo (360px-412px)
        ws.setLoadWithOverviewMode(false);
        ws.setUseWideViewPort(false);
        ws.setTextZoom(100);
        ws.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        ws.setCacheMode(WebSettings.LOAD_DEFAULT);

        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(webView, true);

        webView.setWebChromeClient(new WebChromeClient());
        webView.setWebViewClient(new WebViewClient());

        root.addView(webView, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        setContentView(root);

        ensureWidgetBackgroundAccess();
        connectAndLoad(getIntentSessionId(), true);
    }

    private void ensureWidgetBackgroundAccess() {
        try {
            if (Build.VERSION.SDK_INT >= 33) {
                if (checkSelfPermission("android.permission.POST_NOTIFICATIONS") != PackageManager.PERMISSION_GRANTED) {
                    requestPermissions(new String[] { "android.permission.POST_NOTIFICATIONS" }, 101);
                }
            }
        } catch (Exception ignored) {}
        try {
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            if (pm != null && !pm.isIgnoringBatteryOptimizations(getPackageName())) {
                Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
                i.setData(Uri.parse("package:" + getPackageName()));
                startActivity(i);
            }
        } catch (Exception ignored) {}
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        connectAndLoad(getIntentSessionId(), true);
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) {
            webView.onResume();
            webView.resumeTimers();
        }
        PulseWidgetProvider.requestImmediateUpdate(this);
        // Actualizar etiqueta de red sin recargar todo el WebView si ya está abierto
        connectAndLoad(null, false);
    }

    @Override
    protected void onPause() {
        if (webView != null) {
            webView.onPause();
            webView.pauseTimers();
        }
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        executor.shutdownNow();
        if (webView != null) {
            webView.destroy();
        }
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    private String getIntentSessionId() {
        Intent i = getIntent();
        return i != null ? i.getStringExtra("session_id") : null;
    }

    private void connectAndLoad(final String sessionId, final boolean forceReloadWeb) {
        executor.execute(() -> {
            String raw = ConfigStore.fetchCompactJsonWithFallback(MainActivity.this);
            if (raw != null) {
                try {
                    JSONObject obj = new JSONObject(raw);
                    ConfigStore.saveDiscoveredBases(
                            MainActivity.this,
                            null,
                            obj.optString("lanBase", ""),
                            obj.optString("tunnelBase", ""));
                } catch (Exception ignored) {}
            }
            final String activeBase = ConfigStore.getLastActiveBase(MainActivity.this);
            final String targetUrl = ConfigStore.buildAppWebUrl(MainActivity.this, activeBase, sessionId);
            final java.util.Map<String, String> webHeaders = ConfigStore.primeWebAuth(MainActivity.this, activeBase);
            final String statusLabel = ConfigStore.getConnectionStatusLabel(MainActivity.this);
            final boolean isOk = raw != null;

            runOnUiThread(() -> {
                if (targetUrl.isEmpty()) {
                    statusBadge.setText("⛔ Base no permitida (usá https o IP privada)");
                    statusBadge.setTextColor(Color.parseColor("#F87171"));
                    return;
                }
                if (isOk) {
                    statusBadge.setText(statusLabel);
                    statusBadge.setTextColor(Color.parseColor("#10B981"));
                } else {
                    statusBadge.setText("⚠️ Sin respuesta (" + activeBase + ")");
                    statusBadge.setTextColor(Color.parseColor("#F59E0B"));
                }
                boolean baseChanged = !activeBase.equals(loadedBaseUrl);
                if (forceReloadWeb || baseChanged || (sessionId != null && !sessionId.isEmpty())) {
                    loadedBaseUrl = activeBase;
                    webView.loadUrl(targetUrl, webHeaders);
                }
            });
        });
    }

    private void showConnectionDialog() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        int p = dp(16);
        box.setPadding(p, p, p, p);

        final EditText etLan = new EditText(this);
        etLan.setHint("URL Wi-Fi LAN (ej: http://192.168.1.50:19876)");
        etLan.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        etLan.setText(ConfigStore.getLanBase(this));
        box.addView(etLan);

        final EditText etTunnel = new EditText(this);
        etTunnel.setHint("URL Túnel Cloudflare (https://xxx.trycloudflare.com)");
        etTunnel.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        etTunnel.setText(ConfigStore.getTunnelBase(this));
        box.addView(etTunnel);

        final EditText etToken = new EditText(this);
        etToken.setHint("Token de Acceso Remoto");
        etToken.setInputType(InputType.TYPE_CLASS_TEXT);
        etToken.setText(ConfigStore.getAuthToken(this));
        box.addView(etToken);

        new AlertDialog.Builder(this)
                .setTitle("Conexión con tu PC")
                .setView(box)
                .setPositiveButton("Guardar y Conectar", (d, w) -> {
                    ConfigStore.saveConfig(
                            MainActivity.this,
                            etLan.getText().toString(),
                            etTunnel.getText().toString(),
                            etToken.getText().toString());
                    loadedBaseUrl = "";
                    connectAndLoad(null, true);
                })
                .setNeutralButton("⬇️ Actualizar APK", (d, w) -> downloadApkUpdate())
                .setNegativeButton("Cancelar", null)
                .show();
    }

    /** /api/apk exige el token por header: el navegador no puede mandarlo, DownloadManager sí. */
    private void downloadApkUpdate() {
        String base = ConfigStore.getLastActiveBase(this);
        if (base == null || base.isEmpty()) {
            Toast.makeText(this, "Conectate a la PC primero", Toast.LENGTH_SHORT).show();
            return;
        }
        try {
            DownloadManager.Request req = new DownloadManager.Request(Uri.parse(base + "/api/apk"));
            req.addRequestHeader("Authorization", "Bearer " + ConfigStore.getAuthToken(this));
            req.setTitle("AI Pulse – actualización");
            req.setMimeType("application/vnd.android.package-archive");
            req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, "ai-pulse.apk");
            DownloadManager dm = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
            dm.enqueue(req);
            Toast.makeText(this, "Descargando… tocá la notificación para instalar", Toast.LENGTH_LONG).show();
        } catch (Exception e) {
            Toast.makeText(this, "No se pudo descargar: " + e.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    private int dp(int v) {
        float d = getResources().getDisplayMetrics().density;
        return Math.round(v * d);
    }
}
