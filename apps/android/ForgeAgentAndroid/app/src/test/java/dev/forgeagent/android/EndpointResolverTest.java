package dev.forgeagent.android;

import org.junit.Test;

import java.util.ArrayList;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

public final class EndpointResolverTest {
    @Test
    public void candidatesPreferLastWorkingThenRecommendedAndSkipPhoneLocalOnlyAddresses() {
        ForgeConnection connection = ForgeConnection.create("forge-core-test", "Desk", "token");
        connection.lastWorkingEndpoint = "http://192.168.1.12:3000/";
        connection.setRecommendedEndpoint("http://100.78.191.46:3000/");
        connection.addEndpoint("http://127.0.0.1:3000");
        connection.addEndpoint("http://localhost:3000");
        connection.addEndpoint("http://198.18.0.1:3000");
        connection.addEndpoint("http://10.0.0.9:3000");

        ArrayList<String> candidates = new EndpointResolver(null).candidates(connection);

        assertEquals(3, candidates.size());
        assertEquals("http://192.168.1.12:3000", candidates.get(0));
        assertEquals("http://100.78.191.46:3000", candidates.get(1));
        assertEquals("http://10.0.0.9:3000", candidates.get(2));
    }

    @Test
    public void nonJsonApiResponsesBecomeReadableConnectionErrors() {
        try {
            EndpointResolver.parseJsonResponse("<!doctype html><title>ForgeAgent</title>");
            fail("Expected non-JSON response to be rejected before JSONObject parsing.");
        } catch (Exception ex) {
            assertTrue(ex.getMessage().contains("non-JSON response"));
            assertTrue(ex.getMessage().contains("<!doctype html>"));
        }
    }

    @Test
    public void tailscaleGatewayErrorsTellUsersHowToRecover() {
        String message = EndpointResolver.httpErrorMessage("http://100.78.191.46:3000", 502, false);

        assertTrue(message.contains("Tailscale address"));
        assertTrue(message.contains("does not appear to have an active Tailscale VPN interface"));
        assertTrue(message.contains("Open Tailscale on this phone"));
        assertTrue(message.contains("same account/tailnet"));
    }

    @Test
    public void remoteGatewayErrorsMentionBackendPortAndAwakeMac() {
        String message = EndpointResolver.httpErrorMessage("https://forgeagent.example.test", 502, true);

        assertTrue(message.contains("remote tunnel or proxy"));
        assertTrue(message.contains("Mac is awake"));
        assertTrue(message.contains("current Core port"));
    }
}
