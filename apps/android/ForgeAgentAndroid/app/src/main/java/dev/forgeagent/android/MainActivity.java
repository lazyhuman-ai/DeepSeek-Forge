package dev.forgeagent.android;

import android.annotation.SuppressLint;
import android.Manifest;
import android.app.Activity;
import android.app.Dialog;
import android.content.Context;
import android.content.Intent;
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
import android.view.Window;
import android.view.WindowManager;
import android.view.WindowInsets;
import android.webkit.JavascriptInterface;
import android.webkit.ConsoleMessage;
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
import java.util.ArrayList;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class MainActivity extends Activity {
    private static final String TAG = "DeepSeekForgeAndroid";
    static final String PREFS = "forgeagent";
    static final String PREF_BASE_URL = "baseUrl";
    static final String PREF_TOKEN = "token";
    static final String PREF_LAST_NOTIFIED_SEQ = "lastNotifiedSeq";
    static final String PREF_LAST_EVENT_SEQ = "lastEventSeq";
    static final String PREF_ACTIVITY_NOTIFICATIONS = "activityNotifications";
    static final String PREF_CONSOLE_FONT_ZOOM = "consoleFontZoom";
    static final String PREF_CONSOLE_DARK_MODE = "consoleDarkMode";
    static final String EXTRA_SELECT_SESSION_ID = "dev.forgeagent.android.SELECT_SESSION_ID";

    private static final int TEXT = Color.rgb(55, 53, 47);
    private static final int MUTED = Color.rgb(120, 119, 116);
    private static final int BORDER = Color.rgb(220, 218, 214);
    private static final int SURFACE = Color.rgb(247, 247, 245);
    private static final int ORANGE = Color.rgb(191, 116, 25);
    private static final int CONSOLE_FONT_ZOOM_MIN = 90;
    private static final int CONSOLE_FONT_ZOOM_MAX = 116;
    private static final int CONSOLE_FONT_ZOOM_STEP = 5;
    private static final int FILE_CHOOSER_REQUEST = 42;
    private static final int QR_SCAN_REQUEST = 43;

    private final ExecutorService executor = Executors.newSingleThreadExecutor();

    private ConnectionStore connectionStore;
    private EndpointResolver endpointResolver;
    private FrameLayout root;
    private TextView error;
    private WebView webView;
    private ForgeConnection activeConnection;
    private String resolvedBaseUrl;
    private boolean tokenInjected;
    private ValueCallback<Uri[]> filePathCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        connectionStore = new ConnectionStore(this);
        endpointResolver = new EndpointResolver(connectionStore);
        root = new FrameLayout(this);
        applyNativeChrome();
        applySystemBarInsets(root);
        setContentView(root);
        requestNotificationPermissionIfNeeded();
        if (handlePairIntent(getIntent())) return;
        startConnectionMonitorIfNeeded();
        openInitialScreen(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (handlePairIntent(intent)) return;
        startConnectionMonitorIfNeeded();
        openInitialScreen(intent);
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
            showError("This QR code is not a DeepSeek-Forge pairing link.");
            return;
        }
        if (!isPairUri(uri)) {
            showError("This QR code is not a DeepSeek-Forge pairing link. Open Pair Mobile on the Mac and scan that QR code.");
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
        String pairingBaseUrl = trimTrailingSlash(url == null || url.isEmpty() ? "http://127.0.0.1:3000" : url);
        if (code == null || code.isEmpty()) {
            renderSetup();
            showError("Pairing link is missing a code. Generate a fresh QR code from Pair Mobile on the Mac.");
            return;
        }
        if (TailscaleSupport.isTailscaleEndpoint(pairingBaseUrl) && !TailscaleSupport.deviceAppearsOnTailscale()) {
            renderTailscaleRequired(pairingBaseUrl, code);
            return;
        }
        renderPairing("Pairing with " + hostLabel(pairingBaseUrl) + "...");
        pairWithCode(pairingBaseUrl, code);
    }

    private void openInitialScreen(Intent intent) {
        ArrayList<ForgeConnection> connections = connectionStore.list();
        if (connections.isEmpty()) {
            renderSetup();
            return;
        }
        String sessionId = intent == null ? "" : intent.getStringExtra(EXTRA_SELECT_SESSION_ID);
        if (sessionId != null && !sessionId.isEmpty()) {
            ForgeConnection selected = connectionStore.active();
            if (selected != null) {
                openConnection(selected, sessionId);
                return;
            }
        }
        if (connections.size() == 1) {
            openConnection(connections.get(0), "");
            return;
        }
        renderConnectionHome(true);
    }

    private void renderConnectionHome(boolean refreshStatuses) {
        root.removeAllViews();
        webView = null;
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        root.addView(scroll, match());

        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setPadding(dp(22), dp(34), dp(22), dp(26));
        scroll.addView(panel, match());

        TextView brand = text("DeepSeek-Forge", 34, TEXT);
        brand.setGravity(Gravity.CENTER);
        brand.setSingleLine(true);
        brand.setTypeface(Typeface.create("sans-serif", Typeface.BOLD));
        panel.addView(brand, wrap());

        TextView title = text("Choose a desktop connection", 18, TEXT);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        LinearLayout.LayoutParams titleParams = fullWidth();
        titleParams.setMargins(0, dp(18), 0, dp(6));
        panel.addView(title, titleParams);

        TextView hint = text("Android connects to DeepSeek-Forge Core on your Mac. For away-from-home use, set up free Tailscale on both devices; DeepSeek-Forge will save the Tailscale and local addresses from pairing.", 13, MUTED);
        hint.setLineSpacing(dp(3), 1.0f);
        LinearLayout.LayoutParams hintParams = fullWidth();
        hintParams.setMargins(0, 0, 0, dp(18));
        panel.addView(hint, hintParams);

        ArrayList<ForgeConnection> connections = connectionStore.list();
        if (connections.isEmpty()) {
            TextView empty = text("No paired desktops yet.", 15, MUTED);
            empty.setGravity(Gravity.CENTER);
            LinearLayout.LayoutParams emptyParams = fullWidth();
            emptyParams.setMargins(0, dp(36), 0, dp(18));
            panel.addView(empty, emptyParams);
        } else {
            for (ForgeConnection connection : connections) {
                panel.addView(connectionRow(connection), fullWidth());
            }
        }

        Button scan = button("Scan Pair Mobile QR", true);
        scan.setCompoundDrawablesWithIntrinsicBounds(R.drawable.ic_forge_scan, 0, 0, 0);
        scan.setCompoundDrawablePadding(dp(10));
        tintCompoundDrawables(scan, Color.WHITE);
        LinearLayout.LayoutParams scanParams = fullWidth();
        scanParams.setMargins(0, dp(18), 0, 0);
        panel.addView(scan, scanParams);
        scan.setOnClickListener(v -> startQrScan());

        Button manual = button("Pair manually", false);
        LinearLayout.LayoutParams manualParams = fullWidth();
        manualParams.setMargins(0, dp(10), 0, 0);
        panel.addView(manual, manualParams);
        manual.setOnClickListener(v -> renderSetup());

        Button remote = button("Add remote URL to current connection", false);
        LinearLayout.LayoutParams remoteParams = fullWidth();
        remoteParams.setMargins(0, dp(10), 0, 0);
        panel.addView(remote, remoteParams);
        remote.setOnClickListener(v -> showAddEndpointDialog(connectionStore.active()));

        error = text("", 13, ORANGE);
        error.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams errorParams = fullWidth();
        errorParams.setMargins(0, dp(16), 0, 0);
        panel.addView(error, errorParams);

        if (refreshStatuses) refreshConnectionStatuses();
    }

    private View connectionRow(ForgeConnection connection) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.VERTICAL);
        row.setPadding(dp(16), dp(14), dp(16), dp(14));
        row.setBackground(rounded(Color.WHITE, BORDER, 12));

        TextView name = text(connection.name == null || connection.name.isEmpty() ? "DeepSeek-Forge Desktop" : connection.name, 16, TEXT);
        name.setTypeface(Typeface.DEFAULT_BOLD);
        row.addView(name, fullWidth());

        String status = connection.status == null || connection.status.isEmpty() ? "unknown" : connection.status;
        int statusColor = "online".equals(status) ? Color.rgb(52, 125, 72) : ("offline".equals(status) ? ORANGE : MUTED);
        TextView detail = text(statusLabel(connection), 13, statusColor);
        LinearLayout.LayoutParams detailParams = fullWidth();
        detailParams.setMargins(0, dp(6), 0, 0);
        row.addView(detail, detailParams);

        String endpoint = connection.displayEndpoint();
        if (endpoint != null && !endpoint.isEmpty()) {
            TextView endpointView = text(endpoint, 12, MUTED);
            LinearLayout.LayoutParams endpointParams = fullWidth();
            endpointParams.setMargins(0, dp(5), 0, 0);
            row.addView(endpointView, endpointParams);
        }

        LinearLayout actions = new LinearLayout(this);
        actions.setOrientation(LinearLayout.HORIZONTAL);
        LinearLayout.LayoutParams actionsParams = fullWidth();
        actionsParams.setMargins(0, dp(12), 0, 0);
        row.addView(actions, actionsParams);

        Button open = button("Open", true);
        Button endpoints = button("URL", false);
        Button delete = button("Delete", false);
        actions.addView(open, weighted());
        actions.addView(endpoints, weightedWithMargin());
        actions.addView(delete, weightedWithMargin());

        open.setOnClickListener(v -> openConnection(connection, ""));
        endpoints.setOnClickListener(v -> showAddEndpointDialog(connection));
        delete.setOnClickListener(v -> {
            connectionStore.delete(connection.connectionId);
            if (activeConnection != null && connection.connectionId.equals(activeConnection.connectionId)) {
                activeConnection = null;
                resolvedBaseUrl = "";
                stopConnectionMonitor();
            }
            renderConnectionHome(false);
        });

        LinearLayout.LayoutParams params = fullWidth();
        params.setMargins(0, 0, 0, dp(12));
        row.setLayoutParams(params);
        return row;
    }

    private String statusLabel(ForgeConnection connection) {
        String status = connection.status == null || connection.status.isEmpty() ? "unknown" : connection.status;
        String message = connection.statusMessage == null ? "" : connection.statusMessage;
        if ("online".equals(status)) return "Connected" + (connection.lastSeenAt == null || connection.lastSeenAt.isEmpty() ? "" : " · last seen " + connection.lastSeenAt);
        if ("offline".equals(status)) return message.isEmpty() ? "Offline" : message;
        return message.isEmpty() ? "Not checked yet" : message;
    }

    private void refreshConnectionStatuses() {
        executor.execute(() -> {
            for (ForgeConnection connection : connectionStore.list()) {
                endpointResolver.resolve(connection);
            }
            runOnUiThread(() -> renderConnectionHome(false));
        });
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

        TextView brand = text("DeepSeek-Forge", 34, TEXT);
        brand.setGravity(Gravity.CENTER);
        brand.setSingleLine(true);
        brand.setTypeface(Typeface.create("sans-serif", Typeface.BOLD));
        panel.addView(brand, wrap());

        TextView copy = text("Connect this phone to DeepSeek-Forge running on your Mac.", 15, MUTED);
        copy.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams copyParams = fullWidth();
        copyParams.setMargins(0, dp(10), 0, dp(28));
        panel.addView(copy, copyParams);

        Button scan = button("Scan Pair Mobile QR", true);
        scan.setCompoundDrawablesWithIntrinsicBounds(R.drawable.ic_forge_scan, 0, 0, 0);
        scan.setCompoundDrawablePadding(dp(10));
        tintCompoundDrawables(scan, Color.WHITE);
        panel.addView(scan, fullWidth());

        TextView scannerHint = text("Open Pair Mobile in the Mac app or Web Console, then scan the QR code here.", 13, MUTED);
        scannerHint.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams scannerHintParams = fullWidth();
        scannerHintParams.setMargins(0, dp(12), 0, dp(26));
        panel.addView(scannerHint, scannerHintParams);

        TextView manualTitle = text("Manual fallback", 13, MUTED);
        manualTitle.setGravity(Gravity.START);
        panel.addView(manualTitle, fullWidth());

        EditText urlInput = input("Gateway URL");
        urlInput.setText("http://127.0.0.1:3000");
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
            String pairingBaseUrl = trimTrailingSlash(urlInput.getText().toString().trim());
            if (TailscaleSupport.isTailscaleEndpoint(pairingBaseUrl) && !TailscaleSupport.deviceAppearsOnTailscale()) {
                renderTailscaleRequired(pairingBaseUrl, codeInput.getText().toString().trim());
                return;
            }
            renderPairing("Pairing with " + hostLabel(pairingBaseUrl) + "...");
            pairWithCode(pairingBaseUrl, codeInput.getText().toString().trim());
        });
    }

    private void renderTailscaleRequired(String pairingBaseUrl, String code) {
        root.removeAllViews();
        webView = null;
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        root.addView(scroll, match());

        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setGravity(Gravity.CENTER_HORIZONTAL);
        panel.setPadding(dp(24), dp(64), dp(24), dp(28));
        scroll.addView(panel, match());

        TextView brand = text("DeepSeek-Forge", 34, TEXT);
        brand.setGravity(Gravity.CENTER);
        brand.setSingleLine(true);
        brand.setTypeface(Typeface.create("sans-serif", Typeface.BOLD));
        panel.addView(brand, wrap());

        TextView title = text("Tailscale is needed on this phone", 24, TEXT);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams titleParams = fullWidth();
        titleParams.setMargins(0, dp(22), 0, dp(12));
        panel.addView(title, titleParams);

        TextView detail = text(
            "The QR code points to " + hostLabel(pairingBaseUrl) + ", which is a Tailscale address. "
                + "This Android phone is not currently connected to Tailscale, so it cannot reach your Mac from outside the local Wi‑Fi.\n\n"
                + "Install or open Tailscale, sign in to the same account/tailnet as the Mac, wait until it says Connected, then return here and retry.",
            15,
            MUTED
        );
        detail.setGravity(Gravity.CENTER);
        detail.setLineSpacing(dp(4), 1.0f);
        LinearLayout.LayoutParams detailParams = fullWidth();
        detailParams.setMargins(0, 0, 0, dp(24));
        panel.addView(detail, detailParams);

        Button tailscale = button("Install/Open Tailscale", true);
        panel.addView(tailscale, fullWidth());

        Button retry = button("I connected Tailscale, retry", false);
        LinearLayout.LayoutParams retryParams = fullWidth();
        retryParams.setMargins(0, dp(12), 0, 0);
        panel.addView(retry, retryParams);

        Button localWifi = button("Pair on same Wi‑Fi instead", false);
        LinearLayout.LayoutParams localParams = fullWidth();
        localParams.setMargins(0, dp(12), 0, 0);
        panel.addView(localWifi, localParams);

        TextView hint = text("You can also open Pair Mobile on the Mac again after both devices are on the same Wi‑Fi or Tailscale, then scan a fresh QR code.", 13, MUTED);
        hint.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams hintParams = fullWidth();
        hintParams.setMargins(0, dp(20), 0, 0);
        panel.addView(hint, hintParams);

        error = text("", 13, ORANGE);
        error.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams errorParams = fullWidth();
        errorParams.setMargins(0, dp(16), 0, 0);
        panel.addView(error, errorParams);

        tailscale.setOnClickListener(v -> openTailscale());
        retry.setOnClickListener(v -> {
            if (TailscaleSupport.deviceAppearsOnTailscale()) {
                renderPairing("Pairing with " + hostLabel(pairingBaseUrl) + "...");
                pairWithCode(pairingBaseUrl, code);
            } else {
                showError("Tailscale still does not appear to be connected on this phone.");
            }
        });
        localWifi.setOnClickListener(v -> renderSetup());
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

    private void openConnection(ForgeConnection connection, String sessionId) {
        if (connection == null) {
            renderConnectionHome(false);
            return;
        }
        activeConnection = connection;
        connectionStore.setActive(connection.connectionId);
        renderPairing("Connecting to " + connection.name + "...");
        executor.execute(() -> {
            EndpointResolver.Result result = endpointResolver.resolve(connection);
            if (!result.ok) {
                runOnUiThread(() -> renderOffline(connection, result.message));
                return;
            }
            activeConnection = connectionStore.get(connection.connectionId);
            if (activeConnection == null) activeConnection = connection;
            resolvedBaseUrl = result.endpoint;
            if (sessionId != null && !sessionId.isEmpty()) {
                try {
                    JSONObject body = new JSONObject();
                    body.put("selectedSessionId", sessionId);
                    request("PATCH", "/device-state", body);
                } catch (Exception ex) {
                    Log.w(TAG, "Could not select notification session: " + ex.getMessage());
                }
            }
            startConnectionMonitorIfNeeded();
            runOnUiThread(this::renderWebConsole);
        });
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void renderWebConsole() {
        if (activeConnection == null || resolvedBaseUrl == null || resolvedBaseUrl.isEmpty()) {
            renderConnectionHome(false);
            return;
        }
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
        applyConsolePreferencesToWebSettings(settings);
        settings.setUserAgentString(settings.getUserAgentString() + " DeepSeekForgeAndroid/1");
        webView.addJavascriptInterface(new AndroidBridge(), "forgeAndroid");
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                Log.d(TAG, "WebView page started: " + url);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                Log.d(TAG, "WebView page finished: " + url);
                if (!tokenInjected && url != null && url.startsWith(resolvedBaseUrl)) {
                    tokenInjected = true;
                    String script = "localStorage.setItem('forgeagent.web.token'," + JSONObject.quote(activeConnection.token) + ");" +
                        "window.__forgeAndroidTokenInjected = true;";
                    view.evaluateJavascript(script, ignored -> view.postDelayed(() -> view.loadUrl(resolvedBaseUrl), 150));
                    return;
                }
                syncConsolePreferencesToWeb(view);
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
                        : "Cannot reach DeepSeek-Forge.";
                    Log.e(TAG, "WebView main-frame error: " + message);
                    renderOffline(activeConnection, message);
                }
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage message) {
                if (message != null) {
                    Log.d(TAG, "WebView console " + message.messageLevel() + ": " + message.message() + " (" + message.sourceId() + ":" + message.lineNumber() + ")");
                }
                return super.onConsoleMessage(message);
            }

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

    private void renderOffline(ForgeConnection connection, String message) {
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

        boolean tailscaleMissing = connection != null
            && connection.displayEndpoint() != null
            && TailscaleSupport.isTailscaleEndpoint(connection.displayEndpoint())
            && !TailscaleSupport.deviceAppearsOnTailscale();
        String name = connection == null || connection.name == null || connection.name.isEmpty() ? "DeepSeek-Forge Desktop" : connection.name;
        TextView title = text(tailscaleMissing ? "Connect Tailscale on this phone" : name + " is offline", 28, TEXT);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setGravity(Gravity.CENTER);
        panel.addView(title, wrap());

        String tailnetHint = tailscaleMissing
            ? "This saved address is a Tailscale address, but this Android phone is not currently connected to Tailscale. Install/open Tailscale, sign in to the same tailnet as the Mac, then retry."
            : "The Mac may be asleep/offline, Tailscale may be disconnected, or every saved remote URL may be unreachable. Retry, set up free Tailscale remote access, or add a trusted tunnel URL.";
        TextView detail = text(message + "\n\n" + tailnetHint, 14, MUTED);
        detail.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams detailParams = fullWidth();
        detailParams.setMargins(0, dp(18), 0, dp(24));
        panel.addView(detail, detailParams);

        Button retry = button("Retry connection", true);
        panel.addView(retry, fullWidth());

        Button switchConnection = button("Switch connection", false);
        LinearLayout.LayoutParams switchParams = fullWidth();
        switchParams.setMargins(0, dp(12), 0, 0);
        panel.addView(switchConnection, switchParams);

        Button pairNew = button("Pair new Mac", false);
        LinearLayout.LayoutParams pairParams = fullWidth();
        pairParams.setMargins(0, dp(12), 0, 0);
        panel.addView(pairNew, pairParams);

        Button addUrl = button("Add remote URL", false);
        LinearLayout.LayoutParams addUrlParams = fullWidth();
        addUrlParams.setMargins(0, dp(12), 0, 0);
        panel.addView(addUrl, addUrlParams);

        Button tailscale = button("Set up Tailscale", false);
        LinearLayout.LayoutParams tailscaleParams = fullWidth();
        tailscaleParams.setMargins(0, dp(12), 0, 0);
        panel.addView(tailscale, tailscaleParams);

        retry.setOnClickListener(v -> openConnection(connection, ""));
        switchConnection.setOnClickListener(v -> renderConnectionHome(true));
        pairNew.setOnClickListener(v -> startQrScan());
        addUrl.setOnClickListener(v -> showAddEndpointDialog(connection));
        tailscale.setOnClickListener(v -> openTailscale());
    }

    private void loadConsole() {
        tokenInjected = false;
        webView.loadUrl(resolvedBaseUrl);
    }

    private void startQrScan() {
        startActivityForResult(new Intent(this, QrScanActivity.class), QR_SCAN_REQUEST);
    }

    private void pairWithCode(String pairingBaseUrl, String code) {
        if (code == null || code.trim().isEmpty()) {
            renderSetup();
            showError("Missing pairing code.");
            return;
        }
        final String base = trimTrailingSlash(pairingBaseUrl);
        executor.execute(() -> {
            try {
                JSONObject body = new JSONObject();
                body.put("code", code.trim());
                body.put("name", "DeepSeek-Forge Android");
                body.put("kind", "android");
                JSONObject response = parseJsonObject(requestAt(base, "", "POST", "/auth/pair", body), "pairing response");
                ForgeConnection connection = connectionFromPairResponse(base, response);
                connectionStore.upsert(connection);
                connectionStore.setActive(connection.connectionId);
                activeConnection = connection;
                EndpointResolver.Result resolved = endpointResolver.resolve(connection);
                if (!resolved.ok) {
                    runOnUiThread(() -> renderOffline(connection, resolved.message));
                    return;
                }
                activeConnection = connectionStore.get(connection.connectionId);
                if (activeConnection == null) activeConnection = connection;
                resolvedBaseUrl = resolved.endpoint;
                startConnectionMonitorIfNeeded();
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
        openConnection(connectionStore.active(), sessionId == null ? "" : sessionId);
    }

    private String request(String method, String path, JSONObject body) throws Exception {
        if (activeConnection == null || resolvedBaseUrl == null || resolvedBaseUrl.isEmpty()) {
            throw new Exception("No active DeepSeek-Forge connection.");
        }
        return requestAt(resolvedBaseUrl, activeConnection.token, method, path, body);
    }

    private String requestAt(String baseUrl, String bearerToken, String method, String path, JSONObject body) throws Exception {
        URL url = new URL(trimTrailingSlash(baseUrl) + path);
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setRequestMethod(method);
        connection.setConnectTimeout(15000);
        connection.setReadTimeout(60000);
        connection.setRequestProperty("Content-Type", "application/json");
        if (bearerToken != null && !bearerToken.isEmpty()) {
            connection.setRequestProperty("Authorization", "Bearer " + bearerToken);
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

    private ForgeConnection connectionFromPairResponse(String pairingBaseUrl, JSONObject response) {
        String token = response.optString("token", "");
        String coreId = response.optString("coreId", "");
        String desktopName = response.optString("desktopName", "");
        if (desktopName.isEmpty()) desktopName = response.optString("name", "");
        if (desktopName.isEmpty()) desktopName = hostLabel(pairingBaseUrl);
        ForgeConnection connection = ForgeConnection.create(coreId, desktopName, token);
        connection.addEndpoint(pairingBaseUrl);
        addNetworkUrls(connection, response.optJSONObject("networkUrls"));
        if (response.optString("recommendedRemoteUrl", "").length() > 0) connection.setRecommendedEndpoint(response.optString("recommendedRemoteUrl", ""));
        if (response.optString("localUrl", "").length() > 0) connection.addEndpoint(response.optString("localUrl", ""));
        if (response.optString("preferredUrl", "").length() > 0) connection.addEndpoint(response.optString("preferredUrl", ""));
        if (response.optJSONArray("remoteUrls") != null) {
            for (int i = 0; i < response.optJSONArray("remoteUrls").length(); i++) {
                connection.addEndpoint(response.optJSONArray("remoteUrls").optString(i, ""));
            }
        }
        if (response.optJSONArray("tailnetUrls") != null) {
            for (int i = 0; i < response.optJSONArray("tailnetUrls").length(); i++) {
                connection.addEndpoint(response.optJSONArray("tailnetUrls").optString(i, ""));
            }
        }
        if (response.optJSONArray("lanUrls") != null) {
            for (int i = 0; i < response.optJSONArray("lanUrls").length(); i++) {
                connection.addEndpoint(response.optJSONArray("lanUrls").optString(i, ""));
            }
        }
        connection.lastWorkingEndpoint = pairingBaseUrl;
        return connection;
    }

    private JSONObject parseJsonObject(String text, String label) throws Exception {
        String trimmed = text == null ? "" : text.trim();
        if (!trimmed.startsWith("{")) {
            throw new Exception("The " + label + " was not DeepSeek-Forge JSON. Make sure the Mac app is updated and the pairing QR points to the DeepSeek-Forge gateway, then retry.");
        }
        return new JSONObject(trimmed);
    }

    private void addNetworkUrls(ForgeConnection connection, JSONObject networkUrls) {
        if (networkUrls == null) return;
        if (networkUrls.optString("recommendedRemoteUrl", "").length() > 0) {
            connection.setRecommendedEndpoint(networkUrls.optString("recommendedRemoteUrl", ""));
        }
        connection.addEndpoint(networkUrls.optString("preferredUrl", ""));
        connection.addEndpoint(networkUrls.optString("localUrl", ""));
        if (networkUrls.optJSONArray("remoteUrls") != null) {
            for (int i = 0; i < networkUrls.optJSONArray("remoteUrls").length(); i++) {
                connection.addEndpoint(networkUrls.optJSONArray("remoteUrls").optString(i, ""));
            }
        }
        if (networkUrls.optJSONArray("tailnetUrls") != null) {
            for (int i = 0; i < networkUrls.optJSONArray("tailnetUrls").length(); i++) {
                connection.addEndpoint(networkUrls.optJSONArray("tailnetUrls").optString(i, ""));
            }
        }
        if (networkUrls.optJSONArray("lanUrls") != null) {
            for (int i = 0; i < networkUrls.optJSONArray("lanUrls").length(); i++) {
                connection.addEndpoint(networkUrls.optJSONArray("lanUrls").optString(i, ""));
            }
        }
        JSONObject nested = networkUrls.optJSONObject("networkUrls");
        if (nested != null) addNetworkUrls(connection, nested);
    }

    private void showConnectionSwitcher() {
        Dialog dialog = bottomDialog();
        LinearLayout panel = bottomPanel();
        dialog.setContentView(panel);

        TextView title = text("DeepSeek-Forge Connections", 18, TEXT);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        panel.addView(title, fullWidth());

        TextView hint = text("Switch desktops or pair a new Mac. This menu is native, so it still works if the current Web Console is offline.", 13, MUTED);
        LinearLayout.LayoutParams hintParams = fullWidth();
        hintParams.setMargins(0, dp(8), 0, dp(14));
        panel.addView(hint, hintParams);

        Button extensions = button("Open Extensions", false);
        LinearLayout.LayoutParams extensionsParams = fullWidth();
        extensionsParams.setMargins(0, dp(6), 0, 0);
        panel.addView(extensions, extensionsParams);
        extensions.setOnClickListener(v -> {
            dialog.dismiss();
            sendConsoleCommand("openExtensions");
        });

        Button settings = button("Open Settings", false);
        LinearLayout.LayoutParams settingsParams = fullWidth();
        settingsParams.setMargins(0, dp(10), 0, dp(8));
        panel.addView(settings, settingsParams);
        settings.setOnClickListener(v -> {
            dialog.dismiss();
            sendConsoleCommand("openSettings");
        });

        for (ForgeConnection connection : connectionStore.list()) {
            Button item = button(connection.name + "\n" + statusLabel(connection), connection.connectionId.equals(connectionStore.activeId()));
            item.setGravity(Gravity.CENTER_VERTICAL);
            LinearLayout.LayoutParams itemParams = fullWidth();
            itemParams.setMargins(0, dp(8), 0, 0);
            panel.addView(item, itemParams);
            item.setOnClickListener(v -> {
                dialog.dismiss();
                openConnection(connection, "");
            });
        }

        Button scan = button("Scan Pair Mobile QR", true);
        LinearLayout.LayoutParams scanParams = fullWidth();
        scanParams.setMargins(0, dp(16), 0, 0);
        panel.addView(scan, scanParams);
        scan.setOnClickListener(v -> {
            dialog.dismiss();
            startQrScan();
        });

        Button manual = button("Pair manually", false);
        LinearLayout.LayoutParams manualParams = fullWidth();
        manualParams.setMargins(0, dp(10), 0, 0);
        panel.addView(manual, manualParams);
        manual.setOnClickListener(v -> {
            dialog.dismiss();
            renderSetup();
        });

        Button manage = button("Manage connections", false);
        LinearLayout.LayoutParams manageParams = fullWidth();
        manageParams.setMargins(0, dp(10), 0, 0);
        panel.addView(manage, manageParams);
        manage.setOnClickListener(v -> {
            dialog.dismiss();
            renderConnectionHome(true);
        });

        showBottomDialog(dialog);
    }

    private void showAddEndpointDialog(ForgeConnection connection) {
        if (connection == null) {
            renderConnectionHome(false);
            showError("Choose a connection before adding a remote URL.");
            return;
        }
        Dialog dialog = bottomDialog();
        LinearLayout panel = bottomPanel();
        dialog.setContentView(panel);

        TextView title = text("Add remote URL", 18, TEXT);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        panel.addView(title, fullWidth());

        TextView hint = text("Use this for a Tailscale, ZeroTier, LAN, or trusted tunnel address for " + connection.name + ".", 13, MUTED);
        LinearLayout.LayoutParams hintParams = fullWidth();
        hintParams.setMargins(0, dp(8), 0, dp(14));
        panel.addView(hint, hintParams);

        EditText urlInput = input("https://your-mac.example or http://100.x.x.x:3000");
        panel.addView(urlInput, fullWidth());

        TextView feedback = text("", 13, ORANGE);
        LinearLayout.LayoutParams feedbackParams = fullWidth();
        feedbackParams.setMargins(0, dp(10), 0, 0);
        panel.addView(feedback, feedbackParams);

        Button save = button("Save and retry", true);
        LinearLayout.LayoutParams saveParams = fullWidth();
        saveParams.setMargins(0, dp(14), 0, 0);
        panel.addView(save, saveParams);
        save.setOnClickListener(v -> {
            String url = trimTrailingSlash(urlInput.getText().toString().trim());
            if (url.isEmpty()) {
                feedback.setText("Enter a DeepSeek-Forge URL.");
                return;
            }
            connection.addEndpoint(url);
            connectionStore.upsert(connection);
            dialog.dismiss();
            openConnection(connection, "");
        });

        showBottomDialog(dialog);
    }

    private void openExternal(String url) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        } catch (Exception ex) {
            showError("Could not open " + url + ".");
        }
    }

    private void openTailscale() {
        try {
            Intent launchIntent = getPackageManager().getLaunchIntentForPackage("com.tailscale.ipn");
            if (launchIntent != null) {
                startActivity(launchIntent);
                return;
            }
        } catch (Exception ignored) {
        }
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=com.tailscale.ipn")));
            return;
        } catch (Exception ignored) {
        }
        openExternal("https://tailscale.com/download/android");
    }

    private Dialog bottomDialog() {
        return new Dialog(this);
    }

    private void showBottomDialog(Dialog dialog) {
        dialog.show();
        Window window = dialog.getWindow();
        if (window != null) {
            window.setGravity(Gravity.BOTTOM);
            window.setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.WRAP_CONTENT);
        }
    }

    private LinearLayout bottomPanel() {
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setPadding(dp(20), dp(20), dp(20), dp(24));
        panel.setBackgroundColor(Color.WHITE);
        return panel;
    }

    private int consoleFontZoom() {
        int zoom = getSharedPreferences(PREFS, MODE_PRIVATE).getInt(PREF_CONSOLE_FONT_ZOOM, 100);
        return Math.max(CONSOLE_FONT_ZOOM_MIN, Math.min(CONSOLE_FONT_ZOOM_MAX, zoom));
    }

    private void setConsoleFontZoom(int zoom) {
        getSharedPreferences(PREFS, MODE_PRIVATE)
            .edit()
            .putInt(PREF_CONSOLE_FONT_ZOOM, Math.max(CONSOLE_FONT_ZOOM_MIN, Math.min(CONSOLE_FONT_ZOOM_MAX, zoom)))
            .apply();
    }

    private boolean consoleDarkMode() {
        return getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean(PREF_CONSOLE_DARK_MODE, false);
    }

    private void setConsoleDarkMode(boolean enabled) {
        getSharedPreferences(PREFS, MODE_PRIVATE)
            .edit()
            .putBoolean(PREF_CONSOLE_DARK_MODE, enabled)
            .apply();
    }

    private void adjustConsoleFontZoom(int delta) {
        setConsoleFontZoom(consoleFontZoom() + delta);
        applyConsolePreferencesToWeb();
    }

    private void applyNativeChrome() {
        boolean dark = consoleDarkMode();
        getWindow().setStatusBarColor(dark ? Color.rgb(17, 19, 22) : Color.WHITE);
        getWindow().setNavigationBarColor(dark ? Color.rgb(17, 19, 22) : Color.WHITE);
        int flags = getWindow().getDecorView().getSystemUiVisibility();
        if (dark) {
            flags &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                flags &= ~View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            }
        } else {
            flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                flags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            }
        }
        getWindow().getDecorView().setSystemUiVisibility(flags);
    }

    @SuppressWarnings("deprecation")
    private void applyConsolePreferencesToWebSettings(WebSettings settings) {
        settings.setTextZoom(consoleFontZoom());
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            settings.setForceDark(consoleDarkMode() ? WebSettings.FORCE_DARK_ON : WebSettings.FORCE_DARK_OFF);
        }
    }

    private void applyConsolePreferencesToWeb() {
        if (webView == null) return;
        applyConsolePreferencesToWebSettings(webView.getSettings());
        syncConsolePreferencesToWeb(webView);
    }

    private void syncConsolePreferencesToWeb(WebView view) {
        if (view == null) return;
        String theme = consoleDarkMode() ? "dark" : "light";
        String scale = String.format(Locale.US, "%.2f", consoleFontZoom() / 100.0f);
        String script = "(function(){"
            + "localStorage.setItem('forgeagent.web.fontScale'," + JSONObject.quote(scale) + ");"
            + "localStorage.setItem('forgeagent.web.theme'," + JSONObject.quote(theme) + ");"
            + "document.documentElement.dataset.forgeTheme=" + JSONObject.quote(theme) + ";"
            + "document.documentElement.classList.remove('forge-native-shell');"
            + "window.dispatchEvent(new CustomEvent('forge-native-appearance',{detail:{fontScale:" + scale + ",theme:" + JSONObject.quote(theme) + "}}));"
            + "})();";
        view.evaluateJavascript(script, null);
    }

    private void sendConsoleCommand(String action) {
        if (webView == null) return;
        String script = "window.dispatchEvent(new CustomEvent('forge-native-command',{detail:{action:"
            + JSONObject.quote(action)
            + "}}));";
        webView.evaluateJavascript(script, null);
    }

    private final class AndroidBridge {
        @JavascriptInterface
        public void openConnectionSwitcher() {
            runOnUiThread(MainActivity.this::showConnectionSwitcher);
        }

        @JavascriptInterface
        public void openSettings() {
            runOnUiThread(() -> sendConsoleCommand("openSettings"));
        }

        @JavascriptInterface
        public void openExtensions() {
            runOnUiThread(() -> sendConsoleCommand("openExtensions"));
        }
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

    private void startConnectionMonitorIfNeeded() {
        if (connectionStore == null || !connectionStore.hasAnyToken()) return;
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
        view.setIncludeFontPadding(true);
        view.setSingleLine(false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            view.setBreakStrategy(android.graphics.text.LineBreaker.BREAK_STRATEGY_BALANCED);
        }
        view.setHyphenationFrequency(android.text.Layout.HYPHENATION_FREQUENCY_NONE);
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
        button.setSingleLine(false);
        button.setTextColor(primary ? Color.WHITE : TEXT);
        button.setTextSize(15);
        button.setLineSpacing(dp(1), 1.0f);
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

    private LinearLayout.LayoutParams weighted() {
        return new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1);
    }

    private LinearLayout.LayoutParams weightedWithMargin() {
        LinearLayout.LayoutParams params = weighted();
        params.setMargins(dp(8), 0, 0, 0);
        return params;
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
