package com.knupson.aipulse;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class ConfigStore {
    private static final String PREFS_NAME = "ai_pulse_prefs";
    private static final long LAN_FAIL_COOLDOWN_MS = 180_000L; // 3 min sin insistir LAN si falló

    // Valores preconfigurados al compilar el APK desde tu PC
    public static final String DEFAULT_LAN_BASE = "__DEFAULT_LAN_BASE__";
    public static final String DEFAULT_TUNNEL_BASE = "__DEFAULT_TUNNEL_BASE__";
    public static final String DEFAULT_AUTH_TOKEN = "__DEFAULT_AUTH_TOKEN__";
    public static final String DEFAULT_NTFY_TOPIC = "__DEFAULT_NTFY_TOPIC__";

    private ConfigStore() {}

    public static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    public static String getLanBase(Context ctx) {
        String v = prefs(ctx).getString("lan_base", DEFAULT_LAN_BASE);
        return cleanBase(v != null && !v.isEmpty() ? v : DEFAULT_LAN_BASE);
    }

    public static String getTunnelBase(Context ctx) {
        String v = prefs(ctx).getString("tunnel_base", DEFAULT_TUNNEL_BASE);
        return cleanBase(v != null && !v.isEmpty() ? v : DEFAULT_TUNNEL_BASE);
    }

    public static String getAuthToken(Context ctx) {
        String v = prefs(ctx).getString("auth_token", DEFAULT_AUTH_TOKEN);
        return v != null && !v.isEmpty() ? v.trim() : DEFAULT_AUTH_TOKEN;
    }

    public static String getNtfyTopic(Context ctx) {
        String v = prefs(ctx).getString("ntfy_topic", DEFAULT_NTFY_TOPIC);
        return v != null && !v.isEmpty() ? v.trim() : DEFAULT_NTFY_TOPIC;
    }

    public static String getLastGoodJson(Context ctx) {
        return prefs(ctx).getString("last_good_json", null);
    }

    public static long getLastGoodTimestamp(Context ctx) {
        return prefs(ctx).getLong("last_good_ts", 0L);
    }

    public static String getLastActiveBase(Context ctx) {
        String v = prefs(ctx).getString("last_active_base", "");
        if (v != null && !v.isEmpty()) return cleanBase(v);
        String tun = getTunnelBase(ctx);
        if (!tun.isEmpty()) return tun;
        return getLanBase(ctx);
    }

    /**
     * Detecta si el celular tiene transporte Wi-Fi o Ethernet activo en el sistema Android.
     */
    public static boolean isWifiConnected(Context ctx) {
        try {
            ConnectivityManager cm = (ConnectivityManager) ctx.getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm == null) return false;
            Network activeNet = cm.getActiveNetwork();
            if (activeNet == null) return false;
            NetworkCapabilities caps = cm.getNetworkCapabilities(activeNet);
            if (caps == null) return false;
            return caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
                    || caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET);
        } catch (Exception ignored) {
            return false;
        }
    }

    /**
     * Etiqueta real de red (distingue transporte físico Wi-Fi vs Datos Móviles, y ruta LAN vs Túnel).
     */
    public static String getConnectionStatusLabel(Context ctx) {
        boolean onWifi = isWifiConnected(ctx);
        String active = getLastActiveBase(ctx);
        boolean viaTunnel = active.contains("trycloudflare") || active.startsWith("https://");
        if (onWifi) {
            return viaTunnel ? "📶 Wi-Fi (Túnel)" : "📶 Wi-Fi (LAN)";
        }
        return "🌐 4G/5G (Túnel)";
    }

    public static String getShortConnectionTag(Context ctx) {
        boolean onWifi = isWifiConnected(ctx);
        String active = getLastActiveBase(ctx);
        boolean viaTunnel = active.contains("trycloudflare") || active.startsWith("https://");
        if (onWifi) {
            return viaTunnel ? "Wi-Fi·Túnel" : "Wi-Fi·LAN";
        }
        return "4G/5G";
    }

    public static void saveConfig(Context ctx, String lanBase, String tunnelBase, String token) {
        SharedPreferences.Editor ed = prefs(ctx).edit();
        if (lanBase != null) ed.putString("lan_base", cleanBase(lanBase));
        if (tunnelBase != null) ed.putString("tunnel_base", cleanBase(tunnelBase));
        if (token != null && !token.trim().isEmpty()) ed.putString("auth_token", token.trim());
        ed.putLong("last_lan_fail_ts", 0L);
        ed.commit();
    }

    public static void saveDiscoveredBases(Context ctx, String activeBase, String lanBase, String tunnelBase) {
        SharedPreferences.Editor ed = prefs(ctx).edit();
        if (activeBase != null && !activeBase.isEmpty()) {
            ed.putString("last_active_base", cleanBase(activeBase));
        }
        if (lanBase != null && !lanBase.isEmpty()) {
            ed.putString("lan_base", cleanBase(lanBase));
        }
        if (tunnelBase != null && !tunnelBase.isEmpty()) {
            ed.putString("tunnel_base", cleanBase(tunnelBase));
        }
        ed.commit();
    }

    private static void saveSuccessState(Context ctx, String activeBase, String json) {
        prefs(ctx).edit()
                .putString("last_active_base", cleanBase(activeBase))
                .putString("last_good_json", json)
                .putLong("last_good_ts", System.currentTimeMillis())
                .commit();
    }

    public static String buildAppWebUrl(Context ctx, String base, String sessionId) {
        String b = (base != null && !base.isEmpty()) ? cleanBase(base) : getLastActiveBase(ctx);
        String tok = getAuthToken(ctx);
        StringBuilder sb = new StringBuilder(b);
        sb.append("/?mode=web&inApp=1");
        if (tok != null && !tok.isEmpty()) {
            sb.append("&token=").append(tok);
        }
        if (sessionId != null && !sessionId.isEmpty()) {
            sb.append("&session=").append(sessionId);
        }
        return sb.toString();
    }

    public static String fetchCompactJsonWithFallback(Context ctx) {
        String tok = getAuthToken(ctx);
        String lan = getLanBase(ctx);
        String tun = getTunnelBase(ctx);
        String lastActive = cleanBase(prefs(ctx).getString("last_active_base", ""));
        boolean onWifi = isWifiConnected(ctx);

        // 0. Intentar primero la última base que funcionó (ultra rápido para el Widget con app cerrada)
        if (!lastActive.isEmpty()) {
            boolean isLastLan = lastActive.equals(lan) && !lastActive.contains("trycloudflare");
            if (!isLastLan || onWifi) {
                int timeout = isLastLan ? 900 : 2800;
                String json = tryGet(lastActive + "/api/widget/compact?token=" + tok, timeout, timeout + 400);
                if (json != null) {
                    saveSuccessState(ctx, lastActive, json);
                    return json;
                }
            }
        }

        // 1. Intentar IP Wi-Fi LAN SOLO si el celular está en Wi-Fi y no acaba de fallar
        if (onWifi && !lan.isEmpty() && !lan.equals(lastActive)) {
            long lastFail = prefs(ctx).getLong("last_lan_fail_ts", 0L);
            boolean lanCooldownExpired = (System.currentTimeMillis() - lastFail) > LAN_FAIL_COOLDOWN_MS || tun.isEmpty();
            if (lanCooldownExpired) {
                String json = tryGet(lan + "/api/widget/compact?token=" + tok, 850, 1200);
                if (json != null) {
                    prefs(ctx).edit().putLong("last_lan_fail_ts", 0L).commit();
                    saveSuccessState(ctx, lan, json);
                    return json;
                } else {
                    prefs(ctx).edit().putLong("last_lan_fail_ts", System.currentTimeMillis()).commit();
                }
            }
        }

        // 2. Intentar URL Cloudflare Tunnel conocida
        if (!tun.isEmpty() && !tun.equals(lastActive)) {
            String json = tryGet(tun + "/api/widget/compact?token=" + tok, 2800, 3200);
            if (json != null) {
                saveSuccessState(ctx, tun, json);
                return json;
            }
        }

        // 3. Si el túnel rotó, autodescubrir nuevo link desde el canal ntfy
        String discoveredTun = discoverTunnelFromNtfy(ctx);
        if (discoveredTun != null && !discoveredTun.isEmpty() && !discoveredTun.equals(tun)) {
            prefs(ctx).edit().putString("tunnel_base", discoveredTun).commit();
            String json = tryGet(discoveredTun + "/api/widget/compact?token=" + tok, 3000, 3500);
            if (json != null) {
                saveSuccessState(ctx, discoveredTun, json);
                return json;
            }
        }

        return null;
    }

    public static boolean sendQuickActionWithFallback(Context ctx, String sessionId, String provider, String action) {
        String tok = getAuthToken(ctx);
        String lan = getLanBase(ctx);
        String tun = getTunnelBase(ctx);
        String lastActive = cleanBase(prefs(ctx).getString("last_active_base", ""));
        boolean onWifi = isWifiConnected(ctx);

        String payload = "{\"id\":\"" + escapeJson(sessionId) + "\",\"sessionId\":\"" + escapeJson(sessionId)
                + "\",\"provider\":\"" + escapeJson(provider) + "\",\"quickAction\":\"" + escapeJson(action) + "\"}";

        if (!lastActive.isEmpty()) {
            boolean isLastLan = lastActive.equals(lan) && !lastActive.contains("trycloudflare");
            if (!isLastLan || onWifi) {
                int timeout = isLastLan ? 1500 : 4000;
                if (tryPostJson(lastActive + "/api/sessions/reply?token=" + tok, payload, timeout, timeout + 1500)) {
                    return true;
                }
            }
        }

        if (onWifi && !lan.isEmpty() && !lan.equals(lastActive)) {
            if (tryPostJson(lan + "/api/sessions/reply?token=" + tok, payload, 1500, 2500)) {
                prefs(ctx).edit().putString("last_active_base", lan).commit();
                return true;
            }
        }

        if (!tun.isEmpty() && !tun.equals(lastActive)) {
            if (tryPostJson(tun + "/api/sessions/reply?token=" + tok, payload, 4000, 5000)) {
                prefs(ctx).edit().putString("last_active_base", tun).commit();
                return true;
            }
        }

        String discoveredTun = discoverTunnelFromNtfy(ctx);
        if (discoveredTun != null && !discoveredTun.isEmpty()) {
            prefs(ctx).edit().putString("tunnel_base", discoveredTun).commit();
            if (tryPostJson(discoveredTun + "/api/sessions/reply?token=" + tok, payload, 4000, 5000)) {
                prefs(ctx).edit().putString("last_active_base", discoveredTun).commit();
                return true;
            }
        }

        return false;
    }

    private static String escapeJson(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\").replace("\"", "\\\"");
    }

    private static boolean tryPostJson(String urlStr, String jsonBody, int connTimeout, int readTimeout) {
        HttpURLConnection conn = null;
        try {
            URL url = new URL(urlStr);
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("POST");
            conn.setConnectTimeout(connTimeout);
            conn.setReadTimeout(readTimeout);
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            conn.setRequestProperty("Accept", "application/json");
            byte[] bytes = jsonBody.getBytes(StandardCharsets.UTF_8);
            conn.setFixedLengthStreamingMode(bytes.length);
            conn.getOutputStream().write(bytes);
            conn.getOutputStream().flush();
            int code = conn.getResponseCode();
            return code >= 200 && code < 300;
        } catch (Exception ignored) {
        } finally {
            if (conn != null) conn.disconnect();
        }
        return false;
    }

    private static String discoverTunnelFromNtfy(Context ctx) {
        String topic = getNtfyTopic(ctx);
        if (topic == null || topic.isEmpty()) return null;
        String raw = tryGet("https://ntfy.sh/" + topic + "/json?poll=1&since=48h", 2500, 3000);
        if (raw == null || raw.isEmpty()) return null;
        Pattern p = Pattern.compile("https://[a-zA-Z0-9-]+\\.trycloudflare\\.com");
        Matcher m = p.matcher(raw);
        String lastMatch = null;
        while (m.find()) {
            lastMatch = m.group(0);
        }
        return lastMatch;
    }

    private static String tryGet(String urlStr, int connTimeout, int readTimeout) {
        HttpURLConnection conn = null;
        try {
            URL url = new URL(urlStr);
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(connTimeout);
            conn.setReadTimeout(readTimeout);
            conn.setRequestProperty("Accept", "application/json");
            conn.setRequestProperty("Cache-Control", "no-cache");
            int code = conn.getResponseCode();
            if (code >= 200 && code < 300) {
                BufferedReader br = new BufferedReader(
                        new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8));
                StringBuilder sb = new StringBuilder();
                String line;
                while ((line = br.readLine()) != null) {
                    sb.append(line).append('\n');
                }
                br.close();
                return sb.toString();
            }
        } catch (Exception ignored) {
        } finally {
            if (conn != null) conn.disconnect();
        }
        return null;
    }

    public static String cleanBase(String raw) {
        if (raw == null) return "";
        String s = raw.trim();
        if (s.startsWith("__DEFAULT_")) return "";
        int qIdx = s.indexOf('?');
        if (qIdx > 0) s = s.substring(0, qIdx);
        while (s.endsWith("/")) {
            s = s.substring(0, s.length() - 1);
        }
        return s;
    }
}
