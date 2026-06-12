package dev.forgeagent.android;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.Set;

public final class EndpointResolver {
    public static final class Result {
        public final boolean ok;
        public final String endpoint;
        public final String message;

        private Result(boolean ok, String endpoint, String message) {
            this.ok = ok;
            this.endpoint = endpoint;
            this.message = message;
        }

        static Result ok(String endpoint, String message) {
            return new Result(true, endpoint, message);
        }

        static Result error(String message) {
            return new Result(false, "", message);
        }
    }

    private final ConnectionStore store;

    public EndpointResolver(ConnectionStore store) {
        this.store = store;
    }

    public Result resolve(ForgeConnection connection) {
        if (connection == null) return Result.error("No DeepSeek-Forge connection is selected.");
        if (!connection.hasToken()) return Result.error("This connection is missing its device token. Pair it again from the Mac.");
        ArrayList<String> candidates = candidates(connection);
        if (candidates.isEmpty()) return Result.error("This connection has no saved address. Add a remote URL or pair again.");

        String lastError = "";
        int lastErrorPriority = 0;
        for (String endpoint : candidates) {
            try {
                IdentityProbe identity = probeIdentity(endpoint);
                if (!identity.isDeepSeekForge) {
                    String message = host(endpoint) + " does not look like a DeepSeek-Forge gateway. It returned " + identity.message + ".";
                    int priority = endpointErrorPriority(endpoint);
                    if (priority >= lastErrorPriority) {
                        lastError = message;
                        lastErrorPriority = priority;
                    }
                    continue;
                }
                if (
                    connection.coreId != null &&
                    !connection.coreId.isEmpty() &&
                    !identity.coreId.isEmpty() &&
                    !connection.coreId.equals(identity.coreId)
                ) {
                    lastError = host(endpoint) + " is a different DeepSeek-Forge desktop.";
                    lastErrorPriority = Math.max(lastErrorPriority, endpointErrorPriority(endpoint));
                    continue;
                }
                if (connection.coreId != null && !connection.coreId.isEmpty() && identity.coreId.isEmpty()) {
                    lastError = host(endpoint) + " is DeepSeek-Forge, but it does not expose a desktop identity. Restart or update the Mac app, then retry.";
                    lastErrorPriority = Math.max(lastErrorPriority, endpointErrorPriority(endpoint));
                    continue;
                }

                JSONObject deviceState = getJson(endpoint, "/device-state", connection.token);
                if (deviceState.optString("deviceId", "").isEmpty()) {
                    lastError = host(endpoint) + " did not accept this Android device token.";
                    lastErrorPriority = Math.max(lastErrorPriority, endpointErrorPriority(endpoint));
                    continue;
                }

                if (!identity.coreId.isEmpty()) connection.coreId = identity.coreId;
                String desktopName = identity.desktopName;
                if (desktopName.length() > 0 && (connection.name == null || connection.name.isEmpty() || "ForgeAgent Desktop".equals(connection.name) || "DeepSeek-Forge Desktop".equals(connection.name) || connection.name.equals(host(connection.displayEndpoint())))) {
                    connection.name = desktopName;
                }
                connection.markOnline(endpoint);
                persist(connection);
                return Result.ok(endpoint, "Connected to " + connection.name + ".");
            } catch (HttpStatusException ex) {
                if (ex.status == 401 || ex.status == 403) {
                    connection.markOffline("This Android device token was rejected by " + host(endpoint) + ". Pair again from the Mac.");
                    persist(connection);
                    return Result.error(connection.statusMessage);
                }
                String message = httpErrorMessage(endpoint, ex.status);
                int priority = endpointErrorPriority(endpoint);
                if (priority >= lastErrorPriority) {
                    lastError = message;
                    lastErrorPriority = priority;
                }
            } catch (NonJsonResponseException ex) {
                String message = host(endpoint) + " returned a web page instead of the DeepSeek-Forge API. Restart or update the Mac app and retry.";
                int priority = endpointErrorPriority(endpoint);
                if (priority >= lastErrorPriority) {
                    lastError = message;
                    lastErrorPriority = priority;
                }
            } catch (Exception ex) {
                String message = "Cannot reach " + host(endpoint) + ": " + (ex.getMessage() == null ? ex.toString() : ex.getMessage());
                int priority = endpointErrorPriority(endpoint);
                if (priority >= lastErrorPriority) {
                    lastError = message;
                    lastErrorPriority = priority;
                }
            }
        }

        connection.markOffline(lastError.isEmpty()
            ? "DeepSeek-Forge is not reachable. The Mac may be asleep/offline, Tailscale may be disconnected, or every saved remote URL may be unreachable."
            : lastError);
        persist(connection);
        return Result.error(connection.statusMessage);
    }

    ArrayList<String> candidates(ForgeConnection connection) {
        Set<String> values = new LinkedHashSet<>();
        if (connection.lastWorkingEndpoint != null && !connection.lastWorkingEndpoint.isEmpty()) {
            addCandidate(values, connection.lastWorkingEndpoint);
        }
        if (connection.recommendedEndpoint != null && !connection.recommendedEndpoint.isEmpty()) {
            addCandidate(values, connection.recommendedEndpoint);
        }
        for (String endpoint : connection.knownEndpoints) {
            addCandidate(values, endpoint);
        }
        return new ArrayList<>(values);
    }

    private void addCandidate(Set<String> values, String endpoint) {
        String normalized = ForgeConnection.trimTrailingSlash(endpoint);
        if (normalized.isEmpty()) return;
        if (TailscaleSupport.isPhoneUnreachableLocalEndpoint(normalized)) return;
        values.add(normalized);
    }

    private IdentityProbe probeIdentity(String endpoint) {
        String lastMessage = "an unknown response";
        String[] paths = new String[]{"/identity", "/discovery", "/health"};
        for (String path : paths) {
            try {
                JSONObject json = getJson(endpoint, path, "");
                String app = json.optString("app", "");
                String coreId = json.optString("coreId", "");
                if ("DeepSeek-Forge".equals(app) || "ForgeAgent".equals(app) || coreId.startsWith("forge-core-")) {
                    return new IdentityProbe(
                        true,
                        coreId,
                        json.optString("desktopName", ForgeConnection.hostLabel(endpoint)),
                        path
                    );
                }
                lastMessage = "JSON without a DeepSeek-Forge identity from " + path;
            } catch (NonJsonResponseException ex) {
                lastMessage = ex.message;
            } catch (HttpStatusException ex) {
                lastMessage = "HTTP " + ex.status + " from " + path;
            } catch (Exception ex) {
                lastMessage = ex.getMessage() == null ? ex.toString() : ex.getMessage();
            }
        }
        return new IdentityProbe(false, "", "", lastMessage);
    }

    private JSONObject getJson(String endpoint, String path, String token) throws Exception {
        URL url = new URL(ForgeConnection.trimTrailingSlash(endpoint) + path);
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setRequestMethod("GET");
        connection.setConnectTimeout(8_000);
        connection.setReadTimeout(12_000);
        if (token != null && !token.isEmpty()) {
            connection.setRequestProperty("Authorization", "Bearer " + token);
        }
        int status = connection.getResponseCode();
        InputStream stream = status >= 200 && status < 300 ? connection.getInputStream() : connection.getErrorStream();
        String text = readAll(stream);
        if (status < 200 || status >= 300) throw new HttpStatusException(status, text);
        return parseJsonResponse(text);
    }

    static JSONObject parseJsonResponse(String text) throws Exception {
        if (text == null || text.isEmpty()) return new JSONObject();
        String trimmed = text.trim();
        if (!trimmed.startsWith("{")) {
            throw new NonJsonResponseException("a non-JSON response: " + snippet(trimmed));
        }
        return new JSONObject(trimmed);
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

    private String host(String endpoint) {
        return ForgeConnection.hostLabel(endpoint);
    }

    private String httpErrorMessage(String endpoint, int status) {
        return httpErrorMessage(endpoint, status, TailscaleSupport.deviceAppearsOnTailscale());
    }

    static String httpErrorMessage(String endpoint, int status, boolean phoneAppearsOnTailscale) {
        if ((status == 502 || status == 503 || status == 504) && TailscaleSupport.isTailscaleEndpoint(endpoint)) {
            String phoneState = phoneAppearsOnTailscale
                ? "This phone appears to have a Tailscale interface, so the Mac may be offline, asleep, on a different tailnet, or the remote proxy may be pointing at the wrong port."
                : "This phone does not appear to have an active Tailscale VPN interface.";
            return ForgeConnection.hostLabel(endpoint)
                + " is a Tailscale address, but it returned HTTP " + status + ". "
                + phoneState
                + " Open Tailscale on this phone, confirm it is connected to the same account/tailnet as the Mac, then retry. "
                + "If you are using Tailscale Serve, point it to the DeepSeek-Forge Core port shown in Pair Mobile.";
        }
        if (status == 502 || status == 503 || status == 504) {
            return ForgeConnection.hostLabel(endpoint)
                + " returned HTTP " + status + ". A remote tunnel or proxy reached something, but its backend DeepSeek-Forge Core is not available. "
                + "Check that the Mac is awake, DeepSeek-Forge Core is running, and the remote URL points to the current Core port.";
        }
        return ForgeConnection.hostLabel(endpoint) + " returned HTTP " + status + ".";
    }

    private int endpointErrorPriority(String endpoint) {
        if (TailscaleSupport.isTailscaleEndpoint(endpoint)) return 4;
        String host = host(endpoint).toLowerCase();
        if (host.equals("127.0.0.1") || host.equals("localhost") || host.equals("::1")) return 1;
        return 2;
    }

    private void persist(ForgeConnection connection) {
        if (store != null) store.upsert(connection);
    }

    private static String snippet(String value) {
        String clean = value == null ? "" : value.replaceAll("\\s+", " ").trim();
        if (clean.length() <= 80) return clean;
        return clean.substring(0, 79) + "…";
    }

    private static final class IdentityProbe {
        final boolean isDeepSeekForge;
        final String coreId;
        final String desktopName;
        final String message;

        IdentityProbe(boolean isDeepSeekForge, String coreId, String desktopName, String message) {
            this.isDeepSeekForge = isDeepSeekForge;
            this.coreId = coreId == null ? "" : coreId;
            this.desktopName = desktopName == null ? "" : desktopName;
            this.message = message == null ? "" : message;
        }
    }

    private static final class NonJsonResponseException extends Exception {
        final String message;

        NonJsonResponseException(String message) {
            super(message);
            this.message = message;
        }
    }

    private static final class HttpStatusException extends Exception {
        final int status;

        HttpStatusException(int status, String body) {
            super(body == null || body.isEmpty() ? "HTTP " + status : body);
            this.status = status;
        }
    }
}
