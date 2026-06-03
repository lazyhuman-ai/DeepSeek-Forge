package dev.forgeagent.android;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.os.Bundle;
import android.view.Gravity;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.TextView;

import com.journeyapps.barcodescanner.BarcodeCallback;
import com.journeyapps.barcodescanner.BarcodeResult;
import com.journeyapps.barcodescanner.DecoratedBarcodeView;

import java.util.List;

public final class QrScanActivity extends Activity {
    public static final String EXTRA_QR_CONTENTS = "dev.forgeagent.android.QR_CONTENTS";
    private static final int CAMERA_REQUEST = 11;

    private DecoratedBarcodeView barcodeView;
    private boolean decoding;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(Color.BLACK);
        getWindow().setNavigationBarColor(Color.BLACK);
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.CAMERA}, CAMERA_REQUEST);
            renderPermissionWaiting();
            return;
        }
        renderScanner();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (barcodeView != null) barcodeView.resume();
    }

    @Override
    protected void onPause() {
        if (barcodeView != null) barcodeView.pause();
        super.onPause();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != CAMERA_REQUEST) return;
        if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            renderScanner();
        } else {
            setResult(RESULT_CANCELED);
            finish();
        }
    }

    private void renderPermissionWaiting() {
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        TextView label = new TextView(this);
        label.setText("Camera permission is needed to scan the ForgeAgent pairing QR.");
        label.setTextColor(Color.WHITE);
        label.setTextSize(16);
        label.setGravity(Gravity.CENTER);
        label.setPadding(dp(24), dp(24), dp(24), dp(24));
        root.addView(label, match());
        setContentView(root);
    }

    private void renderScanner() {
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        barcodeView = new DecoratedBarcodeView(this);
        barcodeView.setStatusText("Scan the Pair Android QR code");
        root.addView(barcodeView, match());

        TextView title = new TextView(this);
        title.setText("Scan ForgeAgent pairing QR");
        title.setTextColor(Color.WHITE);
        title.setTextSize(17);
        title.setGravity(Gravity.CENTER);
        title.setBackgroundColor(0x99000000);
        title.setPadding(dp(16), dp(14), dp(16), dp(14));
        FrameLayout.LayoutParams titleParams = new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
            Gravity.TOP
        );
        root.addView(title, titleParams);

        Button cancel = new Button(this);
        cancel.setText("Cancel");
        cancel.setAllCaps(false);
        cancel.setTextColor(Color.WHITE);
        cancel.setBackgroundColor(0x66000000);
        FrameLayout.LayoutParams cancelParams = new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
            Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL
        );
        cancelParams.setMargins(0, 0, 0, dp(28));
        root.addView(cancel, cancelParams);
        cancel.setOnClickListener(v -> {
            setResult(RESULT_CANCELED);
            finish();
        });

        setContentView(root);
        startDecoding();
    }

    private void startDecoding() {
        if (barcodeView == null || decoding) return;
        decoding = true;
        barcodeView.decodeSingle(new BarcodeCallback() {
            @Override
            public void barcodeResult(BarcodeResult result) {
                if (result == null || result.getText() == null) return;
                Intent data = new Intent();
                data.putExtra(EXTRA_QR_CONTENTS, result.getText());
                setResult(RESULT_OK, data);
                finish();
            }

            @Override
            public void possibleResultPoints(List<com.google.zxing.ResultPoint> resultPoints) {
            }
        });
        barcodeView.resume();
    }

    private FrameLayout.LayoutParams match() {
        return new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
