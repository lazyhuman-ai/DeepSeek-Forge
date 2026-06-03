package dev.forgeagent.android;

import android.annotation.SuppressLint;
import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class MainActivity extends Activity {
    private static final String TAG = "ForgeAgentAndroid";
    static final String PREFS = "forgeagent";
    static final String PREF_BASE_URL = "baseUrl";
    static final String PREF_TOKEN = "token";
    static final String PREF_LAST_NOTIFIED_SEQ = "lastNotifiedSeq";
    static final String PREF_LAST_EVENT_SEQ = "lastEventSeq";
    static final String PREF_ACTIVITY_NOTIFICATIONS = "activityNotifications";
    static final String EXTRA_SELECT_SESSION_ID = "dev.forgeagent.android.SELECT_SESSION_ID";

    private static final int TEXT = Color.rgb(55, 53, 47);
    private static final int MUTED = Color.rgb(120, 119, 116);
    private static final int BORDER = Color.rgb(220, 218, 214);
    private static final int SURFACE = Color.rgb(247, 247, 245);
    private static final int ORANGE = Color.rgb(191, 116, 25);
    private static final int FILE_CHOOSER_REQUEST = 42;
    private static final int QR_SCAN_REQUEST = 43;

    private final ExecutorService executor = Executors.newSingleThreadExecutor();

    private SharedPreferences prefs;
    private FrameLayout root;
    private TextView error;
    private WebView webView;
    private String baseUrl;
    private String token;
    private boolean tokenInjected;
    private ValueCallback<Uri[]> filePathCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(Color.WHITE);
        getWindow().setNavigationBarColor(Color.WHITE);
        prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        baseUrl = prefs.getString(PREF_BASE_URL, "http://127.0.0.1:3000");
        token = prefs.getString(PREF_TOKEN, "");
        root = new FrameLayout(this);
        applySystemBarInsets(root);
        setContentView(root);
        requestNotificationPermissionIfNeeded();
        if (!handlePairIntent(getIntent()) && hasToken()) {
            startConnectionMonitor();
            openConsoleForRequestedSession(getIntent());
        } else if (!hasToken()) {
            renderSetup();
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (!handlePairIntent(intent) && hasToken()) {
            startConnectionMonitor();
            openConsoleForRequestedSession(intent);
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == QR_SCAN_REQUEST) {
            if (resultCode == RESULT_OK && data != null) {
                String contents = data.getStringExtra(QrScanActivity.EXTRA_QR_CONTENTS);
                if (contents != null) handleScannedText(contents);
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != FILE_CHOOSER_REQUEST || filePathCallback == null) return;
        Uri[] result = resultCode == RESULT_OK && data != null
            ? WebChromeClient.FileChooserParams.parseResult(resultCode, data)
            : null;
        filePathCallback.onReceiveValue(result);
        filePathCallback = null;
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.stopLoading();
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    private boolean handlePairIntent(Intent intent) {
        Uri uri = intent == null ? null : intent.getData();
        if (!isPairUri(uri)) return false;
        pairFromUri(uri);
        return true;
    }

    private void handleScannedText(String contents) {
        Uri uri;
        try {
            uri = Uri.parse(contents);
        } catch (Exception ex) {
            showError("This QR code is not a ForgeAgent pairing link.");
            return;
        }
        if (!isPairUri(uri)) {
            showError("This QR code is not a ForgeAgent pairing link. Open Pair Android on the Mac and scan that QR code.");
            return;
        }
        pairFromUri(uri);
    }

    private boolean isPairUri(Uri uri) {
        return uri != null && "forgeagent".equals(uri.getScheme()) && "pair".equals(uri.getHost());
    }

    private void pairFromUri(Uri uri) {
        String url = uri.getQueryParameter("baseUrl");
        String code = uri.getQueryParameter("code");
        if (url != null && !url.isEmpty()) baseUrl = trimTrailingSlash(url);
        prefs.edit().putString(PREF_BASE_URL, baseUrl).apply();
        if (code == null || code.isEmpty()) {
            renderSetup();
            showError("Pairing link is missing a code. Generate a fresh QR code from Pair Android on the Mac.");
            return;
        }
        renderPairing("Pairing with " + hostLabel(baseUrl) + "...");
        pairWithCode(code);
    }

    private boolean hasToken() {
        return token != null && !token.isEmpty();
    }

    private void renderSetup() {
        root.removeAllViews();
        webView = null;
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        root.addView(scroll, match());

        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setGravity(Gravity.CENTER_HORIZONTAL);
        panel.setPadding(dp(24), dp(44), dp(24), dp(28));
        scroll.addView(panel, match());

        TextView brand = text("ForgeAgent", 46, TEXT);
        brand.setTypeface(Typeface.create("serif", Typeface.BOLD));
        panel.addView(brand, wrap());

        TextView copy = text("Connect this phone to ForgeAgent running on your Mac.", 15, MUTED);
        copy.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams copyParams = fullWidth();
        copyParams.setMargins(0, dp(10), 0, dp(28));
        panel.addView(copy, copyParams);

        Button scan = button("Scan Pair Android QR", true);
        scan.setCompoundDrawablesWithIntrinsicBounds(R.drawable.ic_forge_scan, 0, 0, 0);
        scan.setCompoundDrawablePadding(dp(10));
        tintCompoundDrawables(scan, Color.WHITE);
        panel.addView(scan, fullWidth());

        TextView scannerHint = text("Open Pair Android in the Mac app or Web Console, then scan the QR code here.", 13, MUTED);
        scannerHint.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams scannerHintParams = fullWidth();
        scannerHintParams.setMargins(0, dp(12), 0, dp(26));
        panel.addView(scannerHint, scannerHintParams);

        TextView manualTitle = text("Manual fallback", 13, MUTED);
        manualTitle.setGravity(Gravity.START);
        panel.addView(manualTitle, fullWidth());

        EditText urlInput = input("Gateway URL");
        urlInput.setText(baseUrl);
        LinearLayout.LayoutParams urlParams = fullWidth();
        urlParams.setMargins(0, dp(8), 0, 0);
        panel.addView(urlInput, urlParams);

        EditText codeInput = input("Pairing code");
        LinearLayout.LayoutParams codeParams = fullWidth();
        codeParams.setMargins(0, dp(12), 0, 0);
        panel.addView(codeInput, codeParams);

        Button pair = button("Pair and open console", false);
        LinearLayout.LayoutParams pairParams = fullWidth();
        pairParams.setMargins(0, dp(14), 0, 0);
        panel.addView(pair, pairParams);

        TextView note = text("After pairing, Android loads the same Web Console as desktop: rich text, HTML previews, uploads, permissions, branches, usage, MCP, skills, memory, and Webridge status all stay in one UI.", 13, MUTED);
        note.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams noteParams = fullWidth();
        noteParams.setMargins(0, dp(22), 0, 0);
        panel.addView(note, noteParams);

        error = text("", 13, ORANGE);
        error.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams errorParams = fullWidth();
        errorParams.setMargins(0, dp(18), 0, 0);
        panel.addView(error, errorParams);

        scan.setOnClickListener(v -> startQrScan());
        pair.setOnClickListener(v -> {
            baseUrl = trimTrailingSlash(urlInput.getText().toString().trim());
            prefs.edit().putString(PREF_BASE_URL, baseUrl).apply();
            renderPairing("Pairing with " + hostLabel(baseUrl) + "...");
            pairWithCode(codeInput.getText().toString().trim());
        });
    }

    private void renderPairing(String labelText) {
        root.removeAllViews();
        webView = null;
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setGravity(Gravity.CENTER);
        panel.setPadding(dp(24), dp(24), dp(24), dp(24));
        root.addView(panel, match());
        ProgressBar progress = new ProgressBar(this);
        progress.setIndeterminate(true);
        panel.addView(progress, wrap());
        TextView label = text(labelText, 15, MUTED);
        label.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams labelParams = wrap();
        labelParams.setMargins(0, dp(16), 0, 0);
        panel.addView(label, labelParams);
        error = text("", 13, ORANGE);
        error.setGravity(Gravity.CENTER);
        panel.addView(error, labelParams);
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void renderWebConsole() {
        root.removeAllViews();
        WebView.setWebContentsDebuggingEnabled((getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0);
        webView = new WebView(this);
        root.addView(webView, match());
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setUserAgentString(settings.getUserAgentString() + " ForgeAgentAndroid/1");
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                Log.d(TAG, "WebView page started: " + url);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                Log.d(TAG, "WebView page finished: " + url);
                if (!tokenInjected && url != null && url.startsWith(baseUrl)) {
                    tokenInjected = true;
                    String script = "localStorage.setItem('forgeagent.web.token'," + JSONObject.quote(token) + ");" +
                        "window.__forgeAndroidTokenInjected = true;";
                    view.evaluateJavascript(script, ignored -> view.postDelayed(() -> view.loadUrl(baseUrl), 150));
                    return;
                }
            }

            @Override
            public void onReceivedHttpError(WebView view, WebResourceRequest request, android.webkit.WebResourceResponse errorResponse) {
                if (request != null && request.getUrl() != null) {
                    Log.e(TAG, "WebView HTTP error " + errorResponse.getStatusCode() + " for " + request.getUrl());
                }
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if ("forgeagent".equals(uri.getScheme())) {
                    handlePairIntent(new Intent(Intent.ACTION_VIEW, uri));
                    return true;
                }
                return false;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError resourceError) {
                if (request.isForMainFrame()) {
                    String message = resourceError != null
                        ? resourceError.getDescription().toString()
                        : "Cannot reach ForgeAgent.";
                    Log.e(TAG, "WebView main-frame error: " + message);
                    renderOffline(message);
                }
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (filePathCallback != null) filePathCallback.onReceiveValue(null);
                filePathCallback = callback;
                Intent intent = params.createIntent();
                try {
                    startActivityForResult(intent, FILE_CHOOSER_REQUEST);
                } catch (Exception ex) {
                    filePathCallback = null;
                    return false;
                }
                return true;
            }
        });
        loadConsole();
    }

    private void renderOffline(String message) {
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        root.removeAllViews();
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setGravity(Gravity.CENTER_HORIZONTAL);
        panel.setPadding(dp(24), dp(72), dp(24), dp(24));
        root.addView(panel, match());

        TextView title = text("ForgeAgent is offline", 28, TEXT);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        panel.addView(title, wrap());

        TextView detail = text(message + "\n\nMake sure the Mac app is open or the local service is running, then retry.", 14, MUTED);
        detail.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams detailParams = fullWidth();
        detailParams.setMargins(0, dp(18), 0, dp(24));
        panel.addView(detail, detailParams);

        Button retry = button("Retry connection", true);
        panel.addView(retry, fullWidth());

        Button reset = button("Pair a different Mac", false);
        LinearLayout.LayoutParams resetParams = fullWidth();
        resetParams.setMargins(0, dp(12), 0, 0);
        panel.addView(reset, resetParams);

        retry.setOnClickListener(v -> renderWebConsole());
        reset.setOnClickListener(v -> {
            prefs.edit().remove(PREF_TOKEN).apply();
            token = "";
            stopConnectionMonitor();
            renderSetup();
        });
    }

    private void loadConsole() {
        tokenInjected = false;
        webView.loadUrl(baseUrl);
    }

    private void startQrScan() {
        startActivityForResult(new Intent(this, QrScanActivity.class), QR_SCAN_REQUEST);
    }

    private void pairWithCode(String code) {
        if (code == null || code.trim().isEmpty()) {
            renderSetup();
            showError("Missing pairing code.");
            return;
        }
        executor.execute(() -> {
            try {
                JSONObject body = new JSONObject();
                body.put("code", code.trim());
                body.put("name", "ForgeAgent Android");
                body.put("kind", "android");
                JSONObject response = new JSONObject(request("POST", "/auth/pair", body));
                token = response.getString("token");
                prefs.edit()
                    .putString(PREF_BASE_URL, baseUrl)
                    .putString(PREF_TOKEN, token)
                    .apply();
                startConnectionMonitor();
                runOnUiThread(this::renderWebConsole);
            } catch (Exception ex) {
                runOnUiThread(() -> {
                    renderSetup();
                    showError(ex.getMessage() == null ? ex.toString() : ex.getMessage());
                });
            }
        });
    }

    private void openConsoleForRequestedSession(Intent intent) {
        String sessionId = intent == null ? "" : intent.getStringExtra(EXTRA_SELECT_SESSION_ID);
        if (sessionId == null || sessionId.isEmpty()) {
            renderWebConsole();
            return;
        }
        renderPairing("Opening ForgeAgent session...");
        executor.execute(() -> {
            try {
                JSONObject body = new JSONObject();
                body.put("selectedSessionId", sessionId);
                request("PATCH", "/device-state", body);
            } catch (Exception ex) {
                Log.w(TAG, "Could not select notification session: " + ex.getMessage());
            }
            runOnUiThread(this::renderWebConsole);
        });
    }

    private String request(String method, String path, JSONObject body) throws Exception {
        URL url = new URL(baseUrl + path);
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setRequestMethod(method);
        connection.setConnectTimeout(15000);
        connection.setReadTimeout(60000);
        connection.setRequestProperty("Content-Type", "application/json");
        if (hasToken()) {
            connection.setRequestProperty("Authorization", "Bearer " + token);
        }
        if (body != null) {
            connection.setDoOutput(true);
            try (OutputStream out = connection.getOutputStream()) {
                out.write(body.toString().getBytes(StandardCharsets.UTF_8));
            }
        }
        int status = connection.getResponseCode();
        InputStream stream = status >= 200 && status < 300 ? connection.getInputStream() : connection.getErrorStream();
        String text = readAll(stream);
        if (status < 200 || status >= 300) {
            String message = text;
            try {
                message = new JSONObject(text).optString("error", text);
            } catch (Exception ignored) {
            }
            throw new Exception(status + ": " + message);
        }
        return text == null || text.isEmpty() ? "{}" : text;
    }

    private String readAll(InputStream stream) throws Exception {
        if (stream == null) return "";
        StringBuilder builder = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) builder.append(line);
        }
        return builder.toString();
    }

    private void requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 17);
        }
    }

    private void startConnectionMonitor() {
        Intent intent = new Intent(this, ConnectionMonitorService.class);
        startForegroundService(intent);
    }

    private void stopConnectionMonitor() {
        stopService(new Intent(this, ConnectionMonitorService.class));
    }

    private void showError(String message) {
        runOnUiThread(() -> {
            if (error != null) error.setText(message == null ? "" : message);
        });
    }

    private TextView text(String value, int sp, int color) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(sp);
        view.setTextColor(color);
        view.setLineSpacing(dp(2), 1.0f);
        return view;
    }

    private EditText input(String hint) {
        EditText input = new EditText(this);
        input.setHint(hint);
        input.setTextColor(TEXT);
        input.setHintTextColor(MUTED);
        input.setTextSize(15);
        input.setSingleLine(true);
        input.setPadding(dp(14), dp(10), dp(14), dp(10));
        input.setBackground(rounded(SURFACE, BORDER, 10));
        return input;
    }

    private Button button(String label, boolean primary) {
        Button button = new Button(this);
        button.setText(label);
        button.setAllCaps(false);
        button.setTextColor(primary ? Color.WHITE : TEXT);
        button.setTextSize(15);
        button.setGravity(Gravity.CENTER);
        button.setPadding(dp(12), dp(10), dp(12), dp(10));
        button.setBackground(rounded(primary ? TEXT : SURFACE, primary ? TEXT : BORDER, 10));
        return button;
    }

    private GradientDrawable rounded(int fill, int stroke, int radiusDp) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(fill);
        drawable.setCornerRadius(dp(radiusDp));
        drawable.setStroke(dp(1), stroke);
        return drawable;
    }

    private void tintCompoundDrawables(Button button, int color) {
        for (Drawable drawable : button.getCompoundDrawables()) {
            if (drawable != null) drawable.setTint(color);
        }
    }

    private LinearLayout.LayoutParams wrap() {
        return new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    }

    private LinearLayout.LayoutParams fullWidth() {
        return new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    }

    private FrameLayout.LayoutParams match() {
        return new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private String trimTrailingSlash(String value) {
        if (value == null) return "";
        while (value.endsWith("/")) value = value.substring(0, value.length() - 1);
        return value;
    }

    private String hostLabel(String value) {
        try {
            return Uri.parse(value).getHost();
        } catch (Exception ignored) {
            return value;
        }
    }

    @SuppressWarnings("deprecation")
    private void applySystemBarInsets(View view) {
        view.setOnApplyWindowInsetsListener((target, insets) -> {
            target.setPadding(
                insets.getSystemWindowInsetLeft(),
                insets.getSystemWindowInsetTop(),
                insets.getSystemWindowInsetRight(),
                insets.getSystemWindowInsetBottom()
            );
            return insets;
        });
    }
}
