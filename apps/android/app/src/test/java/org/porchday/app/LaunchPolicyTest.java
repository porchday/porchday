package org.porchday.app;

import org.junit.Test;
import static org.junit.Assert.assertEquals;

public class LaunchPolicyTest {
    @Test public void keepsTrustedDeepLinksAndRecoveryFragments() {
        for (String url : new String[]{"https://porchday.org/", "https://porchday.org/albums/123", "https://porchday.org/join#invite=synthetic", "https://porchday.org:443/reset?token=synthetic"})
            assertEquals(url, LaunchPolicy.destination(url));
    }
    @Test public void rejectsSpoofedOriginsAndLocalSchemes() {
        for (String url : new String[]{null, "", "//porchday.org", "http://porchday.org/", "https://porchday.org.evil.test/", "https://porchday.org@evil.test/", "https://evil@porchday.org/", "https://porchday.org:444/", "https://porchday.org./", "https://staging.porchday.com/", "javascript:alert(1)", "file:///secret", "content://org.porchday.app/secret", "intent://porchday.org/", "https://porchday.org\@evil.test", "https://porchday.org/%zz", "https://porchday.org/\nsecret", "https://porchday.org/" + "x".repeat(8192)})
            assertEquals(LaunchPolicy.HOME, LaunchPolicy.destination(url));
    }
}
