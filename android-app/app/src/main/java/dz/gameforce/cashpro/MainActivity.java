package dz.gameforce.cashpro;

import android.app.Activity;
import android.content.ContentValues;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.text.InputType;
import android.util.Base64;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.widget.FrameLayout;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.FileInputStream;
import java.io.InputStream;
import java.security.MessageDigest;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.json.JSONArray;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * CashPro pour Android : la même interface que le serveur (WebView).
 * Depuis 1.2.0, pas de Tailscale intégré : l'accès à distance passe par l'application Tailscale
 * officielle (ou un autre VPN) installée sur le téléphone ; ici on saisit seulement l'adresse du serveur.
 */
public class MainActivity extends Activity {
    private static final int FILE_CHOOSER = 42;
    private static final int BG = Color.parseColor("#0B1020"), CARD = Color.parseColor("#141B33"),
            TX = Color.parseColor("#E8ECF8"), MU = Color.parseColor("#8A93B3"), BR = Color.parseColor("#E50914"),
            OK = Color.parseColor("#22C55E"), ERR = Color.parseColor("#EF4444");

    private SharedPreferences prefs;
    private WebView web;
    private TextView status;
    private Button connectBtn;
    private volatile String origin;
    private ValueCallback<Uri[]> fileCallback;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        prefs = getSharedPreferences("cashpro", MODE_PRIVATE);
        if (prefs.getString("server", "").isEmpty()) showSetup(null);
        else connect();
    }

    // Android 15 (targetSdk 35) affiche les applications « bord à bord » : sans marge, le contenu passe sous
    // la barre d'état (heure, batterie) et sous la barre de navigation. Chaque écran est donc placé dans un
    // conteneur qui reçoit en marge la taille réelle de ces barres (et du clavier).
    private void show(View content) {
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(BG);
        root.addView(content, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            int l, t, r, b;
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets i = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
                l = i.left; t = i.top; r = i.right; b = i.bottom;
            } else {
                l = insets.getSystemWindowInsetLeft(); t = insets.getSystemWindowInsetTop();
                r = insets.getSystemWindowInsetRight(); b = insets.getSystemWindowInsetBottom();
            }
            v.setPadding(l, t, r, b);
            return insets;
        });
        setContentView(root);
        root.requestApplyInsets();
        if (Build.VERSION.SDK_INT >= 21) {
            getWindow().setStatusBarColor(BG);
            getWindow().setNavigationBarColor(BG);
        }
    }

    // ------------------------------------------------------------------ écran de connexion
    private void showSetup(String message) {
        web = null;
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setLayoutDirection(View.LAYOUT_DIRECTION_RTL);
        box.setPadding(dp(22), dp(36), dp(22), dp(22));
        box.setBackgroundColor(BG);

        TextView title = text("CashPro", 28, TX);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        box.addView(title);
        box.addView(text("الاتصال بالسيرفر — Connexion au serveur", 14, MU));
        space(box, 18);

        final EditText server = field(box, "عنوان السيرفر — Serveur", "192.168.1.10:4600", prefs.getString("server", ""));
        box.addView(text("داخل المحل: عنوان السيرفر في الشبكة المحلية، مثلاً 192.168.1.10:4600\n"
                + "من أي مكان: شغّل تطبيق Tailscale على هذا الهاتف، ثم اكتب عنوان السيرفر في Tailscale، مثلاً palm01:4600 أو 100.x.y.z:4600\n"
                + "(يظهر في CashPro ← الإعدادات ← الوصول عن بُعد)", 12, MU));
        space(box, 14);

        connectBtn = new Button(this);
        connectBtn.setText("اتصال — Se connecter");
        connectBtn.setTextColor(Color.WHITE);
        connectBtn.setBackgroundColor(BR);
        box.addView(connectBtn, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(52)));
        space(box, 14);
        status = text(message == null ? "" : message, 14, message == null ? MU : ERR);
        status.setTextIsSelectable(true);
        box.addView(status);

        connectBtn.setOnClickListener(v -> {
            String s = server.getText().toString().trim();
            if (s.isEmpty()) { setStatus("اكتب عنوان السيرفر", ERR); return; }
            prefs.edit().putString("server", s).remove("tailscale").remove("control").apply();
            connect();
        });
        ScrollView sv = new ScrollView(this);
        sv.setBackgroundColor(BG);
        sv.setFillViewport(true);
        sv.addView(box);
        show(sv);
    }

    private void setStatus(String msg, int color) {
        runOnUiThread(() -> {
            if (status != null) { status.setText(msg); status.setTextColor(color); }
            else Toast.makeText(this, msg, Toast.LENGTH_LONG).show();
        });
    }

    // ------------------------------------------------------------------ connexion
    private void connect() {
        if (status == null) showConnecting();
        if (connectBtn != null) connectBtn.setEnabled(false);
        final String server = prefs.getString("server", "");
        new Thread(() -> {
            try {
                String base = normalize(server);
                setStatus("جارٍ التحقق من السيرفر… — Vérification du serveur…", MU);
                boolean offlineReady = uiCached(base);
                try {
                    waitHealth(base, offlineReady ? 5 : 15);
                } catch (Exception e) {
                    // 1.3.5 : interface déjà gardée sur le téléphone → ouverture hors connexion
                    if (!offlineReady) throw e;
                }
                origin = base;
                runOnUiThread(() -> showWeb(base));
            } catch (Exception e) {
                runOnUiThread(() -> showSetup("تعذّر الاتصال — Connexion impossible : " + e.getMessage()
                        + "\nمن خارج المحل: تأكّد أن تطبيق Tailscale مشغّل على الهاتف."));
            }
        }).start();
    }

    private void showConnecting() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        box.setBackgroundColor(BG);
        box.setPadding(dp(24), dp(24), dp(24), dp(24));
        TextView t = text("CashPro", 30, TX);
        t.setTypeface(Typeface.DEFAULT_BOLD);
        t.setGravity(Gravity.CENTER);
        box.addView(t);
        space(box, 12);
        status = text("…", 14, MU);
        status.setGravity(Gravity.CENTER);
        status.setTextIsSelectable(true);
        box.addView(status);
        space(box, 20);
        Button change = new Button(this);
        change.setText("تغيير السيرفر — Changer de serveur");
        change.setOnClickListener(v -> showSetup(null));
        box.addView(change);
        show(box);
    }

    private static String normalize(String s) {
        s = s.trim().replaceAll("/+$", "");
        if (!s.matches("(?i)^https?://.*")) s = "http://" + s;
        Uri u = Uri.parse(s);
        int port = u.getPort() > 0 ? u.getPort() : 4600;
        return u.getScheme() + "://" + u.getHost() + ":" + port;
    }

    private static void waitHealth(String base, int seconds) throws Exception {
        Exception last = null;
        long end = System.currentTimeMillis() + seconds * 1000L;
        while (System.currentTimeMillis() < end) {
            try {
                HttpURLConnection c = (HttpURLConnection) new URL(base + "/api/health").openConnection();
                c.setConnectTimeout(8000);
                c.setReadTimeout(8000);
                if (c.getResponseCode() == 200) {
                    BufferedReader br = new BufferedReader(new InputStreamReader(c.getInputStream(), "UTF-8"));
                    StringBuilder sb = new StringBuilder();
                    String l;
                    while ((l = br.readLine()) != null) sb.append(l);
                    if ("CashPro".equals(new JSONObject(sb.toString()).optString("app"))) return;
                }
                last = new Exception("réponse inattendue (" + c.getResponseCode() + ")");
            } catch (Exception e) { last = e; }
            Thread.sleep(1500);
        }
        throw new Exception("serveur injoignable : " + (last == null ? "" : last.getMessage()));
    }

    // ------------------------------------------------------------------ interface CashPro (WebView)
    private void showWeb(String base) {
        status = null;
        connectBtn = null;
        web = new WebView(this);
        web.setBackgroundColor(BG);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setUserAgentString(s.getUserAgentString() + " CashProAndroid/" + appVersion());
        web.addJavascriptInterface(new Bridge(), "cashproAndroid");
        web.addJavascriptInterface(new DesktopBridge(), "cashproDesktop");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                String url = req.getUrl().toString();
                if (origin != null && url.startsWith(origin + "/")) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, req.getUrl())); } catch (Exception ignored) { }
                return true;
            }

            // 1.3.5 : fichiers de l'interface servis depuis la copie du téléphone quand le serveur ne répond pas
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest req) {
                return interceptUi(req);
            }

            @Override
            public void onPageFinished(WebView v, String url) {
                if (origin != null && url != null && url.startsWith(origin + "/")) precacheUi(origin);
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = cb;
                try {
                    startActivityForResult(params.createIntent(), FILE_CHOOSER);
                } catch (Exception e) {
                    fileCallback = null;
                    return false;
                }
                return true;
            }
        });
        show(web);
        web.loadUrl(base + "/");
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        if (req == FILE_CHOOSER && fileCallback != null) {
            fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(res, data));
            fileCallback = null;
            return;
        }
        super.onActivityResult(req, res, data);
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
    }

    private String appVersion() {
        try { return getPackageManager().getPackageInfo(getPackageName(), 0).versionName; } catch (Exception e) { return "?"; }
    }

    /** Enregistrement des exports (Excel, PDF, CSV) dans « Téléchargements ». */
    private class Bridge {
        @JavascriptInterface
        public void saveFile(String name, String mime, String base64) {
            try {
                byte[] data = Base64.decode(base64, Base64.DEFAULT);
                String safe = name.replaceAll("[\\\\/:*?\"<>|]", "_");
                Uri uri;
                if (Build.VERSION.SDK_INT >= 29) {
                    ContentValues cv = new ContentValues();
                    cv.put(MediaStore.Downloads.DISPLAY_NAME, safe);
                    cv.put(MediaStore.Downloads.MIME_TYPE, mime);
                    cv.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/CashPro");
                    uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
                    try (OutputStream os = getContentResolver().openOutputStream(uri)) { os.write(data); }
                } else {
                    File dir = new File(getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "CashPro");
                    dir.mkdirs();
                    File f = new File(dir, safe);
                    try (FileOutputStream os = new FileOutputStream(f)) { os.write(data); }
                    uri = null;
                }
                final Uri open = uri;
                runOnUiThread(() -> {
                    Toast.makeText(MainActivity.this, "✓ " + safe + " — Download/CashPro", Toast.LENGTH_LONG).show();
                    if (open != null) {
                        try {
                            Intent i = new Intent(Intent.ACTION_VIEW).setDataAndType(open, mime).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                            startActivity(i);
                        } catch (Exception ignored) { }
                    }
                });
            } catch (Exception e) {
                runOnUiThread(() -> Toast.makeText(MainActivity.this, "Erreur : " + e.getMessage(), Toast.LENGTH_LONG).show());
            }
        }
    }

    /** Même nom que dans l'application Windows : bouton « تغيير السيرفر » des Paramètres. */
    private class DesktopBridge {
        @JavascriptInterface
        public void changeServer() { runOnUiThread(() -> showSetup(null)); }

        @JavascriptInterface
        public String version() { return appVersion(); }
    }


    // ------------------------------------------------------------------ 1.3.5 : mode hors connexion
    // Copie des fichiers de l'interface (HTML, JS, CSS, icônes ; jamais /api) dans la mémoire de l'application.
    // Réseau d'abord : si le serveur répond, sa version est affichée et gardée ; sinon la copie est utilisée.
    // Les opérations saisies hors connexion sont gardées par l'interface elle-même et envoyées au retour du réseau.
    private File uiDir(String base) {
        return new File(getFilesDir(), "ui/" + sha1(base));
    }

    private boolean uiCached(String base) {
        return new File(uiDir(base), "index").isFile();
    }

    private static String sha1(String s) {
        try {
            byte[] d = MessageDigest.getInstance("SHA-1").digest(s.getBytes("UTF-8"));
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < 8; i++) sb.append(String.format("%02x", d[i]));
            return sb.toString();
        } catch (Exception e) { return "default"; }
    }

    /** Nom de fichier de la copie : « index » pour les pages (routes sans extension), sinon le chemin aplati. */
    private static String uiKey(String path) {
        if (path == null || path.isEmpty() || path.equals("/") || path.equals("/index.html")) return "index";
        String last = path.substring(path.lastIndexOf('/') + 1);
        if (!last.contains(".")) return "index";
        return path.replaceAll("[^A-Za-z0-9._-]", "_");
    }

    private static String mimeOf(String key) {
        if (key.equals("index") || key.endsWith(".html")) return "text/html";
        if (key.endsWith(".js")) return "application/javascript";
        if (key.endsWith(".css")) return "text/css";
        if (key.endsWith(".svg")) return "image/svg+xml";
        if (key.endsWith(".png")) return "image/png";
        if (key.endsWith(".json")) return "application/json";
        if (key.endsWith(".ico")) return "image/x-icon";
        return "application/octet-stream";
    }

    private static byte[] readAll(InputStream in) throws Exception {
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        int n;
        while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
        in.close();
        return bo.toByteArray();
    }

    private void saveUi(String base, String key, byte[] data) {
        try {
            File dir = uiDir(base);
            dir.mkdirs();
            File tmp = new File(dir, key + ".tmp");
            try (FileOutputStream os = new FileOutputStream(tmp)) { os.write(data); }
            tmp.renameTo(new File(dir, key));
        } catch (Exception ignored) { }
    }

    private WebResourceResponse interceptUi(WebResourceRequest req) {
        final String base = origin;
        if (base == null || !"GET".equalsIgnoreCase(req.getMethod())) return null;
        String url = req.getUrl().toString();
        if (!url.startsWith(base + "/")) return null;
        String path = req.getUrl().getPath();
        if (path == null) path = "/";
        if (path.startsWith("/api/") || path.equals("/sw.js") || path.equals("/offline-manifest.json")) return null;
        String key = uiKey(path);
        try {
            HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(5000);
            c.setReadTimeout(10000);
            c.setUseCaches(false);
            c.setRequestProperty("Cache-Control", "no-cache");
            int code = c.getResponseCode();
            if (code < 200 || (code >= 300 && code < 400) || code > 599) return null;   // non représentable : la WebView s'en charge
            InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
            byte[] data = in == null ? new byte[0] : readAll(in);
            Map<String, String> headers = new HashMap<>();
            for (Map.Entry<String, List<String>> h : c.getHeaderFields().entrySet()) {
                String k = h.getKey();
                if (k == null || h.getValue() == null || h.getValue().isEmpty()) continue;
                String lk = k.toLowerCase();
                if (lk.equals("content-encoding") || lk.equals("content-length") || lk.equals("transfer-encoding") || lk.equals("connection")) continue;
                headers.put(k, h.getValue().get(0));
            }
            String ct = c.getContentType();
            String mime = ct == null ? mimeOf(key) : ct.split(";")[0].trim();
            String enc = ct != null && ct.toLowerCase().contains("charset=") ? ct.substring(ct.toLowerCase().indexOf("charset=") + 8).trim() : "UTF-8";
            if (code == 200) saveUi(base, key, data);
            String msg = c.getResponseMessage();
            return new WebResourceResponse(mime, enc, code, msg == null || msg.isEmpty() ? "OK" : msg, headers, new ByteArrayInputStream(data));
        } catch (Exception e) {
            File f = new File(uiDir(base), key);
            if (!f.isFile()) return null;
            try {
                Map<String, String> headers = new HashMap<>();
                headers.put("Cache-Control", "no-store");
                return new WebResourceResponse(mimeOf(key), "UTF-8", 200, "OK", headers, new FileInputStream(f));
            } catch (Exception e2) { return null; }
        }
    }

    /** Après un chargement réussi : copie complète de l'interface (liste fournie par le serveur), si elle a changé. */
    private volatile boolean precaching = false;
    private void precacheUi(final String base) {
        if (precaching) return;
        precaching = true;
        new Thread(() -> {
            try {
                HttpURLConnection c = (HttpURLConnection) new URL(base + "/offline-manifest.json").openConnection();
                c.setConnectTimeout(5000);
                c.setReadTimeout(10000);
                if (c.getResponseCode() != 200) return;
                JSONObject m = new JSONObject(new String(readAll(c.getInputStream()), "UTF-8"));
                String version = m.optString("version");
                String prefKey = "ui_version_" + sha1(base);
                if (version.equals(prefs.getString(prefKey, "")) && uiCached(base)) return;
                JSONArray files = m.getJSONArray("files");
                boolean all = true;
                for (int i = -1; i < files.length(); i++) {
                    String p = i < 0 ? "/" : files.getString(i);
                    try {
                        HttpURLConnection f = (HttpURLConnection) new URL(base + p).openConnection();
                        f.setConnectTimeout(5000);
                        f.setReadTimeout(15000);
                        f.setUseCaches(false);
                        if (f.getResponseCode() == 200) saveUi(base, uiKey(p), readAll(f.getInputStream()));
                        else all = false;
                    } catch (Exception e) { all = false; }
                }
                if (all) prefs.edit().putString(prefKey, version).apply();
            } catch (Exception ignored) {
            } finally { precaching = false; }
        }).start();
    }

    // ------------------------------------------------------------------ petits utilitaires d'interface
    private int dp(int v) { return Math.round(v * getResources().getDisplayMetrics().density); }

    private TextView text(String s, int sp, int color) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(sp);
        t.setTextColor(color);
        t.setTextDirection(View.TEXT_DIRECTION_ANY_RTL);
        return t;
    }

    private void space(LinearLayout box, int h) { box.addView(new View(this), new LinearLayout.LayoutParams(1, dp(h))); }

    private EditText field(LinearLayout box, String label, String hint, String value) {
        box.addView(text(label, 13, MU));
        EditText e = new EditText(this);
        e.setHint(hint);
        e.setHintTextColor(MU);
        e.setText(value);
        e.setTextColor(TX);
        e.setSingleLine(true);
        e.setTextDirection(View.TEXT_DIRECTION_LTR);
        e.setBackgroundColor(CARD);
        e.setPadding(dp(12), dp(10), dp(12), dp(10));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.setMargins(0, dp(4), 0, dp(12));
        box.addView(e, lp);
        return e;
    }
}
