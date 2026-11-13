plugins { id("com.android.application") }

android {
    namespace = "org.porchday.app"
    compileSdk = 36
    defaultConfig {
        applicationId = "org.porchday.app"
        minSdk = 28
        targetSdk = 36
        versionCode = providers.gradleProperty("versionCode").orElse("1").get().toInt()
        versionName = "0.1.0"
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildTypes {
        release { isMinifyEnabled = false }
    }
    lint { abortOnError = true; warningsAsErrors = true }
}

dependencies {
    implementation("com.google.androidbrowserhelper:androidbrowserhelper:2.7.4")
    testImplementation("junit:junit:4.13.2")
}
// Signing is intentionally absent until the owner's Play account/upload key is configured.
// A successful bundleRelease alone is not a publishable or uploaded release.
