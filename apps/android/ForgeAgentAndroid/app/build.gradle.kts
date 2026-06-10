plugins {
    id("com.android.application")
}

android {
    namespace = "dev.forgeagent.android"
    compileSdk = 35

    defaultConfig {
        applicationId = "dev.forgeagent.android"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
    testImplementation("junit:junit:4.13.2")
}
