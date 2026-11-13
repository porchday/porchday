plugins { id("com.android.application") }

val signingNames = listOf("PORCHDAY_ANDROID_KEYSTORE", "PORCHDAY_ANDROID_STORE_PASSWORD", "PORCHDAY_ANDROID_KEY_ALIAS", "PORCHDAY_ANDROID_KEY_PASSWORD")
val signingValues = signingNames.map { providers.environmentVariable(it).orNull }
require(signingValues.all { it == null } || signingValues.all { !it.isNullOrBlank() }) {
    "Provide all Android signing variables or none; partial signing configuration is refused."
}
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
    if (signingValues.all { !it.isNullOrBlank() }) {
        signingConfigs.create("upload") {
            storeFile = file(signingValues[0]!!)
            storePassword = signingValues[1]
            keyAlias = signingValues[2]
            keyPassword = signingValues[3]
        }
    }
    buildTypes {
        release {
            isMinifyEnabled = false
            if (signingConfigs.findByName("upload") != null) signingConfig = signingConfigs.getByName("upload")
        }
    }
    lint {
        abortOnError = true
        warningsAsErrors = true
        // Version-availability advisories are not correctness checks. Pin the reviewed
        // AGP/Gradle pair and Play-required API 36; do not silently adopt untested SDKs.
        disable += setOf("OldTargetApi", "AndroidGradlePluginVersion")
    }
}

dependencies {
    implementation("com.google.androidbrowserhelper:androidbrowserhelper:2.7.4")
    testImplementation("junit:junit:4.13.2")
}
// Without explicitly supplied private signing inputs, bundleRelease is unsigned.
