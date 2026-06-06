package dev.forgeagent.android;

import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.URL;
import java.util.Enumeration;

public final class TailscaleSupport {
    private TailscaleSupport() {}

    public static boolean isTailscaleEndpoint(String endpoint) {
        try {
            String value = new URL(endpoint).getHost();
            if (value == null) return false;
            String host = value.toLowerCase();
            if (host.endsWith(".ts.net")) return true;
            return isTailscaleAddress(host);
        } catch (Exception ignored) {
            return false;
        }
    }

    public static boolean isPhoneUnreachableLocalEndpoint(String endpoint) {
        try {
            String value = new URL(endpoint).getHost();
            if (value == null) return false;
            String host = value.toLowerCase();
            if ("localhost".equals(host) || "127.0.0.1".equals(host) || "::1".equals(host)) return true;
            String[] parts = host.split("\\.");
            if (parts.length == 4) {
                int first = parseByte(parts[0]);
                int second = parseByte(parts[1]);
                if (first == 0 || first == 127 || first >= 224) return true;
                if (first == 169 && second == 254) return true;
                // 198.18.0.0/15 is a benchmarking range often used by Mac proxy
                // fake-IP/TUN software. It is not reachable from an Android phone.
                if (first == 198 && (second == 18 || second == 19)) return true;
            }
        } catch (Exception ignored) {
        }
        return false;
    }

    public static boolean deviceAppearsOnTailscale() {
        try {
            Enumeration<NetworkInterface> interfaces = NetworkInterface.getNetworkInterfaces();
            while (interfaces != null && interfaces.hasMoreElements()) {
                NetworkInterface networkInterface = interfaces.nextElement();
                Enumeration<InetAddress> addresses = networkInterface.getInetAddresses();
                while (addresses.hasMoreElements()) {
                    String hostAddress = addresses.nextElement().getHostAddress();
                    if (hostAddress == null) continue;
                    int zoneIndex = hostAddress.indexOf('%');
                    String normalized = zoneIndex >= 0 ? hostAddress.substring(0, zoneIndex) : hostAddress;
                    if (isTailscaleAddress(normalized.toLowerCase())) return true;
                }
            }
        } catch (Exception ignored) {
        }
        return false;
    }

    public static boolean isTailscaleAddress(String address) {
        if (address == null) return false;
        if (address.startsWith("100.")) {
            String[] parts = address.split("\\.");
            if (parts.length >= 2) {
                try {
                    int second = Integer.parseInt(parts[1]);
                    return second >= 64 && second <= 127;
                } catch (NumberFormatException ignored) {
                    return false;
                }
            }
        }
        return address.toLowerCase().startsWith("fd7a:115c:a1e0:");
    }

    private static int parseByte(String value) {
        try {
            int parsed = Integer.parseInt(value);
            return parsed >= 0 && parsed <= 255 ? parsed : -1;
        } catch (NumberFormatException ignored) {
            return -1;
        }
    }
}
