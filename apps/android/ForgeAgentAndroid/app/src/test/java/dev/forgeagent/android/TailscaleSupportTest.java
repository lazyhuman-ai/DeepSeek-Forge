package dev.forgeagent.android;

import org.junit.Test;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public final class TailscaleSupportTest {
    @Test
    public void detectsTailscaleIpv4Ipv6AndMagicDnsEndpoints() {
        assertTrue(TailscaleSupport.isTailscaleAddress("100.64.0.1"));
        assertTrue(TailscaleSupport.isTailscaleAddress("100.127.255.254"));
        assertFalse(TailscaleSupport.isTailscaleAddress("100.128.0.1"));
        assertTrue(TailscaleSupport.isTailscaleAddress("fd7a:115c:a1e0::1"));

        assertTrue(TailscaleSupport.isTailscaleEndpoint("http://100.78.191.46:3000"));
        assertTrue(TailscaleSupport.isTailscaleEndpoint("https://my-mac.tailnet.ts.net"));
        assertFalse(TailscaleSupport.isTailscaleEndpoint("http://192.168.1.20:3000"));
    }

    @Test
    public void filtersAddressesThatCannotRepresentTheMacFromThePhone() {
        assertTrue(TailscaleSupport.isPhoneUnreachableLocalEndpoint("http://127.0.0.1:3000"));
        assertTrue(TailscaleSupport.isPhoneUnreachableLocalEndpoint("http://localhost:3000"));
        assertTrue(TailscaleSupport.isPhoneUnreachableLocalEndpoint("http://198.18.0.1:3000"));
        assertTrue(TailscaleSupport.isPhoneUnreachableLocalEndpoint("http://169.254.10.20:3000"));

        assertFalse(TailscaleSupport.isPhoneUnreachableLocalEndpoint("http://100.78.191.46:3000"));
        assertFalse(TailscaleSupport.isPhoneUnreachableLocalEndpoint("http://192.168.1.20:3000"));
    }
}
