package com.itsolution.apitracker;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * APItracker phone app: shows the dashboard served by the APItracker server (SERVER_URL,
 * changeable in the app). No API keys live in the APK; the server holds them.
 */
public class MainActivity extends Activity {
    private static final String PREFS = "apitracker";
    private static final String KEY_SERVER = "server_url";
    private static final String CONNECT_PAGE = "file:///android_asset/connect.html";

    private WebView web;
    private SharedPreferences prefs;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);
        // Always start from the server's current dashboard, never a stored copy.
        web.clearCache(true);
        s.setTextZoom(100);
        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if ("file".equals(uri.getScheme()) || isServer(uri)) return false;
                if ("http".equals(uri.getScheme()) || "https".equals(uri.getScheme())) {
                    // Provider dashboards (OpenAI, Razorpay…) open in the browser.
                    try { startActivity(new Intent(Intent.ACTION_VIEW, uri)); } catch (Exception ignored) { }
                    return true;
                }
                return false;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame() && !"file".equals(request.getUrl().getScheme())) {
                    showConnect(String.valueOf(error.getDescription()));
                }
            }
        });
        web.addJavascriptInterface(new Shell(), "APITrackerShell");
        if (savedInstanceState != null) web.restoreState(savedInstanceState);
        else web.loadUrl(serverUrl() + "/");
        setContentView(web);
    }

    /** Tracker server base, without trailing slash. */
    private String serverUrl() {
        String url = prefs.getString(KEY_SERVER, BuildConfig.DEFAULT_SERVER_URL);
        while (url.endsWith("/")) url = url.substring(0, url.length() - 1);
        return url;
    }

    private boolean isServer(Uri uri) {
        Uri server = Uri.parse(serverUrl());
        return server.getHost() != null && server.getHost().equalsIgnoreCase(uri.getHost()) && server.getPort() == uri.getPort();
    }

    private void showConnect(String error) {
        String url = CONNECT_PAGE + "?server=" + Uri.encode(serverUrl()) + (error != null ? "&error=" + Uri.encode(error) : "");
        web.loadUrl(url);
    }

    /** Bridge used by connect.html and by the dashboard's "Server" button. */
    public class Shell {
        @JavascriptInterface
        public String getServerUrl() { return serverUrl(); }

        @JavascriptInterface
        public String getDefaultServerUrl() { return BuildConfig.DEFAULT_SERVER_URL; }

        @JavascriptInterface
        public void connect(String url) {
            String clean = url == null ? "" : url.trim();
            if (clean.isEmpty()) return;
            if (!clean.startsWith("http://") && !clean.startsWith("https://")) clean = "http://" + clean;
            while (clean.endsWith("/")) clean = clean.substring(0, clean.length() - 1);
            prefs.edit().putString(KEY_SERVER, clean).apply();
            String target = clean + "/";
            web.post(() -> { web.clearHistory(); web.loadUrl(target); });
        }

        @JavascriptInterface
        public void openSettings() { web.post(() -> showConnect(null)); }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (web != null) web.destroy();
        super.onDestroy();
    }
}
