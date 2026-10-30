package com.knupson.aipulse;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.webkit.CookieManager;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.json.JSONArray;
import org.json.JSONObject;

public final class ConfigStore {
    private static final String PREFS_NAME = "ai_pulse_prefs";
    private static final long LAN_FAIL_COOLDOWN_MS = 180_000L; // 3 min sin insistir LAN si falló
    private static final String COMPACT_PATH = "/api/widget/compact";
    private static final String REPLY_PATH = "/api/sessions/reply";
    private static final Pattern IPV4_RE = Pattern.compile("(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})");

    // Valores preconfigurados al compilar el APK desde tu PC
    public static final String DEFAULT_LAN_BASE = "__DEFAULT_LAN_BASE__";
    public static final String DEFAULT_TUNNEL_BASE = "__DEFAULT_TUNNEL_BASE__";
    public static final String DEFAULT_AUTH_TOKEN = "__DEFAULT_AUTH_TOKEN__";
    public static final String DEFAULT_NTFY_TOPIC = "__DEFAULT_NTFY_TOPIC__";

    private ConfigStore() {}

    private static volatile boolean buildDefaultsApplied = false;

    public static SharedPreferences prefs(Context ctx) {
        SharedPreferences p = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        if (!buildDefaultsApplied) applyBuildDefaultsIfChanged(p);
        return p;
    }

    /**
     * Las SharedPreferences sobreviven a una actualización del APK. Si el APK trae credenciales distintas
     * a las del build anterior (token/tópico rotados), las guardadas quedan muertas: se reemplazan y se
     * olvidan las bases conocidas (el túnel viejo ya no existe; se redescubre por LAN o ntfy).
     */
    private static synchronized void applyBuildDefaultsIfChanged(SharedPreferences p) {
        if (buildDefaultsApplied) return;
        buildDefaultsApplied = true;
        String token = cleanBase(DEFAULT_AUTH_TOKEN);
        if (token.isEmpty()) return; // APK sin credenciales inyectadas: respetar lo configurado a mano
        String fingerprint = Integer.toHexString((token + "|" + cleanBase(DEFAULT_NTFY_TOPIC)).hashCode());
        if (fingerprint.equals(p.getString("build_defaults_fp", ""))) return;
        p.edit()
                .putString("build_defaults_fp", fingerprint)
                .putString("auth_token", token)
                .putString("ntfy_topic", cleanBase(DEFAULT_NTFY_TOPIC))
                .putString("lan_base", cleanBase(DEFAULT_LAN_BASE))
                .putString("tunnel_base", cleanBase(DEFAULT_TUNNEL_BASE))
                .remove("last_active_base")
                .remove("last_good_json")
                .putLong("last_lan_fail_ts", 0L)
                .commit();
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

    /**
     * Solo permitimos https, o http hacia IP privada / localhost (LAN).
     * El network-security-config no puede acotar cleartext por CIDR, así que la restricción vive acá:
     * el token nunca viaja por http a un host público.
     */
    public static boolean isAllowedBase(String url) {
        if (url == null || url.isEmpty()) return false;
        try {
            URL u = new URL(url);
            String proto = u.getProtocol();
            if ("https".equalsIgnoreCase(proto)) return true;
            return "http".equalsIgnoreCase(proto) && isPrivateHost(u.getHost());
        } catch (Exception ignored) {
            return false;
        }
    }

    private static boolean isPrivateHost(String host) {
        if (host == null || host.isEmpty()) return false;
        if ("localhost".equalsIgnoreCase(host)) return true;
        Matcher m = IPV4_RE.matcher(host);
        if (!m.matches()) return false;
        int a = Integer.parseInt(m.group(1));
        int b = Integer.parseInt(m.group(2));
        return a == 10 || a == 127 || (a == 192 && b == 168) || (a == 172 && b >= 16 && b <= 31);
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

    /**
     * URL de la WebView SIN token (el token viaja en header Bearer y en cookie, ver primeWebAuth).
     * Devuelve "" si la base no está permitida.
     */
    public static String buildAppWebUrl(Context ctx, String base, String sessionId) {
        String b = (base != null && !base.isEmpty()) ? cleanBase(base) : getLastActiveBase(ctx);
        if (!isAllowedBase(b)) return "";
        StringBuilder sb = new StringBuilder(b);
        sb.append("/?mode=web&inApp=1");
        if (sessionId != null && !sessionId.isEmpty() && sessionId.length() <= 200) {
            sb.append("&session=").append(encodeParam(sessionId));
        }
        return sb.toString();
    }

    /**
     * Prepara la autenticación de la WebView: cookie ai_pulse_token para el host activo (que el server ya lee)
     * y el header Authorization para la navegación inicial. Así el token no queda en la URL ni en el historial.
     */
    public static Map<String, String> primeWebAuth(Context ctx, String base) {
        Map<String, String> headers = new HashMap<>();
        String tok = getAuthToken(ctx);
        if (tok.isEmpty() || !isAllowedBase(base)) return headers;
        headers.put("Authorization", "Bearer " + tok);
        try {
            CookieManager cm = CookieManager.getInstance();
            cm.setCookie(base, "ai_pulse_token=" + encodeParam(tok) + "; Path=/; Max-Age=31536000; SameSite=Lax");
            cm.flush();
        } catch (Exception ignored) {}
        return headers;
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
                String json = tryGet(lastActive + COMPACT_PATH, tok, timeout, timeout + 400);
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
                String json = tryGet(lan + COMPACT_PATH, tok, 850, 1200);
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
            String json = tryGet(tun + COMPACT_PATH, tok, 2800, 3200);
            if (json != null) {
                saveSuccessState(ctx, tun, json);
                return json;
            }
        }

        // 3. Si el túnel rotó, autodescubrir nuevo link desde el canal ntfy
        String discoveredTun = discoverTunnelFromNtfy(ctx);
        if (discoveredTun != null && !discoveredTun.isEmpty() && !discoveredTun.equals(tun)) {
            prefs(ctx).edit().putString("tunnel_base", discoveredTun).commit();
            String json = tryGet(discoveredTun + COMPACT_PATH, tok, 3000, 3500);
            if (json != null) {
                saveSuccessState(ctx, discoveredTun, json);
                return json;
            }
        }

        return null;
    }

    /**
     * Devuelve el provider de la sesión si está en waiting_approval según la última lectura OK del server.
     * Null = la sesión no está pendiente (o no la conocemos): no se manda nada.
     */
    public static String findWaitingApprovalProvider(Context ctx, String sessionId) {
        if (sessionId == null || sessionId.isEmpty() || sessionId.length() > 200) return null;
        String raw = getLastGoodJson(ctx);
        if (raw == null || raw.isEmpty()) return null;
        try {
            JSONArray sessions = new JSONObject(raw).optJSONArray("sessions");
            if (sessions == null) return null;
            for (int i = 0; i < sessions.length(); i++) {
                JSONObject s = sessions.optJSONObject(i);
                if (s == null) continue;
                if (sessionId.equals(s.optString("id", "")) && "waiting_approval".equals(s.optString("state", ""))) {
                    return s.optString("provider", "claude");
                }
            }
        } catch (Exception ignored) {}
        return null;
    }

    /**
     * Envía la acción rápida. El payload va firmado (HMAC-SHA256 con el token) para que el canal ntfy
     * no acepte comandos forjados. Formato v1 (ver remoteManager.js): sig = hex(HMAC(token,
     * "v1|remote_reply|b64(sessionId)|b64(text)|b64(quickAction)|ts")), b64 estándar con padding.
     */
    public static boolean sendQuickActionWithFallback(Context ctx, String sessionId, String provider, String action) {
        String tok = getAuthToken(ctx);
        String lan = getLanBase(ctx);
        String tun = getTunnelBase(ctx);
        String lastActive = cleanBase(prefs(ctx).getString("last_active_base", ""));
        boolean onWifi = isWifiConnected(ctx);

        long ts = System.currentTimeMillis();
        String sig;
        try {
            sig = hmacHex(tok, "v1|remote_reply|" + b64(sessionId) + "|" + b64("") + "|" + b64(action) + "|" + ts);
        } catch (Exception e) {
            return false;
        }
        String payload = "{\"type\":\"remote_reply\",\"id\":\"" + escapeJson(sessionId) + "\",\"sessionId\":\""
                + escapeJson(sessionId) + "\",\"provider\":\"" + escapeJson(provider) + "\",\"text\":\"\",\"quickAction\":\""
                + escapeJson(action) + "\",\"ts\":" + ts + ",\"sig\":\"" + sig + "\"}";

        if (!lastActive.isEmpty()) {
            boolean isLastLan = lastActive.equals(lan) && !lastActive.contains("trycloudflare");
            if (!isLastLan || onWifi) {
                int timeout = isLastLan ? 1500 : 4000;
                if (tryPostJson(lastActive + REPLY_PATH, payload, tok, timeout, timeout + 1500)) {
                    return true;
                }
            }
        }

        if (onWifi && !lan.isEmpty() && !lan.equals(lastActive)) {
            if (tryPostJson(lan + REPLY_PATH, payload, tok, 1500, 2500)) {
                prefs(ctx).edit().putString("last_active_base", lan).commit();
                return true;
            }
        }

        if (!tun.isEmpty() && !tun.equals(lastActive)) {
            if (tryPostJson(tun + REPLY_PATH, payload, tok, 4000, 5000)) {
                prefs(ctx).edit().putString("last_active_base", tun).commit();
                return true;
            }
        }

        String discoveredTun = discoverTunnelFromNtfy(ctx);
        if (discoveredTun != null && !discoveredTun.isEmpty()) {
            prefs(ctx).edit().putString("tunnel_base", discoveredTun).commit();
            if (tryPostJson(discoveredTun + REPLY_PATH, payload, tok, 4000, 5000)) {
                prefs(ctx).edit().putString("last_active_base", discoveredTun).commit();
                return true;
            }
        }

        // Último recurso: publicar el mismo payload firmado en el tópico ntfy (sin token en el request).
        // El server lo acepta como remote_reply solo si la firma valida.
        String topic = getNtfyTopic(ctx);
        if (!topic.isEmpty() && !topic.startsWith("__DEFAULT_")) {
            return tryPostJson("https://ntfy.sh/" + topic, payload, null, 4000, 5000);
        }

        return false;
    }

    private static String b64(String value) {
        return android.util.Base64.encodeToString(value.getBytes(StandardCharsets.UTF_8), android.util.Base64.NO_WRAP);
    }

    private static String hmacHex(String key, String message) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(key.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        byte[] digest = mac.doFinal(message.getBytes(StandardCharsets.UTF_8));
        StringBuilder sb = new StringBuilder(digest.length * 2);
        for (byte b : digest) {
            sb.append(String.format("%02x", b & 0xff));
        }
        return sb.toString();
    }

    private static String encodeParam(String s) {
        try {
            return URLEncoder.encode(s, "UTF-8").replace("+", "%20");
        } catch (Exception e) {
            return "";
        }
    }

    private static String escapeJson(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\").replace("\"", "\\\"");
    }

    /**
     * POST JSON. Si token != null se envía como Bearer. Rechaza bases no permitidas (ver isAllowedBase).
     */
    private static boolean tryPostJson(String urlStr, String jsonBody, String token, int connTimeout, int readTimeout) {
        if (!isAllowedBase(urlStr)) return false;
        HttpURLConnection conn = null;
        try {
            URL url = new URL(urlStr);
            conn = (HttpURLConnection) url.openConnection();
            conn.setInstanceFollowRedirects(false);
            conn.setRequestMethod("POST");
            conn.setConnectTimeout(connTimeout);
            conn.setReadTimeout(readTimeout);
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            conn.setRequestProperty("Accept", "application/json");
            if (token != null && !token.isEmpty()) {
                conn.setRequestProperty("Authorization", "Bearer " + token);
            }
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
        if (topic == null || topic.isEmpty() || topic.startsWith("__DEFAULT_")) return null;
        // Sin token: el request va a ntfy.sh, nunca lleva credenciales
        String raw = tryGet("https://ntfy.sh/" + topic + "/json?poll=1&since=48h", null, 2500, 3000);
        if (raw == null || raw.isEmpty()) return null;
        Pattern p = Pattern.compile("https://[a-zA-Z0-9-]+\\.trycloudflare\\.com");
        Matcher m = p.matcher(raw);
        String lastMatch = null;
        while (m.find()) {
            lastMatch = m.group(0);
        }
        return lastMatch;
    }

    /**
     * GET. Si token != null se envía como Bearer. Rechaza bases no permitidas y no sigue redirects
     * (un redirect podría llevar el header a otro host).
     */
    private static String tryGet(String urlStr, String token, int connTimeout, int readTimeout) {
        if (!isAllowedBase(urlStr)) return null;
        HttpURLConnection conn = null;
        try {
            URL url = new URL(urlStr);
            conn = (HttpURLConnection) url.openConnection();
            conn.setInstanceFollowRedirects(false);
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(connTimeout);
            conn.setReadTimeout(readTimeout);
            conn.setRequestProperty("Accept", "application/json");
            conn.setRequestProperty("Cache-Control", "no-cache");
            if (token != null && !token.isEmpty()) {
                conn.setRequestProperty("Authorization", "Bearer " + token);
            }
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
