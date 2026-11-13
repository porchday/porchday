package org.porchday.app;

import java.net.URI;
import java.net.URISyntaxException;

/** Untrusted Android intents must never choose another privileged origin. */
public final class LaunchPolicy {
    public static final String HOME = "https://porchday.org/";
    private LaunchPolicy() {}
    public static String destination(String candidate) {
        if (candidate == null || candidate.length() > 8192) return HOME;
        try {
            URI uri = new URI(candidate);
            if (!"https".equals(uri.getScheme()) || !"porchday.org".equals(uri.getHost())
                    || uri.getRawUserInfo() != null || (uri.getPort() != -1 && uri.getPort() != 443)) return HOME;
            return candidate;
        } catch (URISyntaxException e) { return HOME; }
    }
}
