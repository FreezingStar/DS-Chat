package com.dschat.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ContentValues;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.provider.MediaStore;
import android.view.HapticFeedbackConstants;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

public class MainActivity extends Activity {

    private static final String HOST = "app.local";
    private static final int REQ_PICK_FILE = 1001;

    private WebView web;
    private ValueCallback<Uri[]> fileCallback;
    private boolean usedFileFallback = false;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        web = new WebView(this);
        web.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        web.setBackgroundColor(Color.TRANSPARENT);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setTextZoom(100);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (HOST.equals(uri.getHost())) {
                    return serveAsset(uri.getPath());
                }
                return null;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (url == null || url.startsWith("file://") || usedFileFallback) {
                    return;
                }
                // Safety net: if asset interception somehow failed, load from android_asset.
                view.evaluateJavascript("(typeof window.MD !== 'undefined')", value -> {
                    if ("false".equals(value) && !usedFileFallback) {
                        usedFileFallback = true;
                        web.loadUrl("file:///android_asset/index.html");
                    }
                });
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (HOST.equals(uri.getHost())) {
                    return false;
                }
                openExternal(uri);
                return true;
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (fileCallback != null) {
                    fileCallback.onReceiveValue(null);
                }
                fileCallback = callback;
                try {
                    Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    intent.setType("*/*");
                    startActivityForResult(Intent.createChooser(intent, "选择文件"), REQ_PICK_FILE);
                    return true;
                } catch (Exception e) {
                    fileCallback = null;
                    return false;
                }
            }
        });

        web.addJavascriptInterface(new Bridge(), "Native");

        applyBars(true);
        web.loadUrl("https://" + HOST + "/index.html");
    }

    // ------------------------------------------------------------------ assets

    private WebResourceResponse serveAsset(String path) {
        if (path == null || path.isEmpty() || "/".equals(path)) {
            path = "/index.html";
        }
        String name = path.startsWith("/") ? path.substring(1) : path;
        try {
            InputStream in = getAssets().open(name);
            WebResourceResponse res = new WebResourceResponse(mimeOf(name), "utf-8", in);
            Map<String, String> headers = new HashMap<>();
            headers.put("Cache-Control", "no-cache");
            res.setResponseHeaders(headers);
            return res;
        } catch (IOException e) {
            return new WebResourceResponse("text/plain", "utf-8",
                    new ByteArrayInputStream("Not found".getBytes(StandardCharsets.UTF_8)));
        }
    }

    private static String mimeOf(String name) {
        String lower = name.toLowerCase();
        if (lower.endsWith(".html")) return "text/html";
        if (lower.endsWith(".css")) return "text/css";
        if (lower.endsWith(".js")) return "application/javascript";
        if (lower.endsWith(".json")) return "application/json";
        if (lower.endsWith(".svg")) return "image/svg+xml";
        if (lower.endsWith(".png")) return "image/png";
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
        if (lower.endsWith(".webp")) return "image/webp";
        if (lower.endsWith(".woff2")) return "font/woff2";
        if (lower.endsWith(".ico")) return "image/x-icon";
        return "application/octet-stream";
    }

    // ------------------------------------------------------------------ chrome

    private void applyBars(boolean dark) {
        Window w = getWindow();
        int barColor = dark ? 0xFF16181D : 0xFFFFFFFF;
        w.setStatusBarColor(barColor);
        w.setNavigationBarColor(barColor);
        View decor = w.getDecorView();
        int flags = decor.getSystemUiVisibility();
        if (dark) {
            flags &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            flags &= ~View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
        } else {
            flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            flags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
        }
        decor.setSystemUiVisibility(flags);
    }

    private void openExternal(Uri uri) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (Exception e) {
            toast("无法打开链接");
        }
    }

    private void toast(String msg) {
        runOnUiThread(() -> Toast.makeText(this, msg, Toast.LENGTH_SHORT).show());
    }

    @Override
    public void onBackPressed() {
        if (web == null) {
            super.onBackPressed();
            return;
        }
        web.evaluateJavascript(
                "(function(){try{return window.__handleBack?String(window.__handleBack()):'false'}catch(e){return 'false'}})()",
                value -> {
                    if (value == null || !value.contains("true")) {
                        finish();
                    }
                });
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_PICK_FILE) {
            Uri[] result = null;
            if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                result = new Uri[]{data.getData()};
            }
            if (fileCallback != null) {
                fileCallback.onReceiveValue(result);
                fileCallback = null;
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    // ------------------------------------------------------------------ bridge

    private class Bridge {

        @JavascriptInterface
        public void setTheme(final int dark) {
            runOnUiThread(() -> applyBars(dark == 1));
        }

        @JavascriptInterface
        public void tap() {
            runOnUiThread(() -> web.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP));
        }

        @JavascriptInterface
        public void toast(final String msg) {
            MainActivity.this.toast(msg);
        }

        @JavascriptInterface
        public void openUrl(final String url) {
            runOnUiThread(() -> {
                try {
                    openExternal(Uri.parse(url));
                } catch (Exception e) {
                    toast("无法打开链接");
                }
            });
        }

        @JavascriptInterface
        public void saveFile(final String name, final String content) {
            runOnUiThread(() -> {
                try {
                    ContentValues cv = new ContentValues();
                    cv.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                    cv.put(MediaStore.MediaColumns.MIME_TYPE, "application/json");
                    cv.put(MediaStore.MediaColumns.RELATIVE_PATH, "Download/DeepSeek");
                    Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
                    if (uri == null) {
                        throw new IOException("无法创建文件");
                    }
                    OutputStream out = getContentResolver().openOutputStream(uri);
                    if (out == null) {
                        throw new IOException("无法写入文件");
                    }
                    out.write(content.getBytes(StandardCharsets.UTF_8));
                    out.flush();
                    out.close();
                    toast("已保存到 Download/DeepSeek");
                } catch (Exception e) {
                    toast("导出失败：" + e.getMessage());
                }
            });
        }
    }
}
