import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val ksProps = Properties().apply {
    val f = rootProject.file("keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

android {
    namespace = "me.doil.drec.eink"
    compileSdk = 35

    defaultConfig {
        applicationId = "me.doil.drec.eink"
        minSdk = 26
        targetSdk = 35
        versionCode = 3
        versionName = "0.1.2"
    }

    signingConfigs {
        create("release") {
            if (ksProps.isNotEmpty()) {
                storeFile = file(ksProps.getProperty("storeFile"))
                storePassword = ksProps.getProperty("storePassword")
                keyAlias = ksProps.getProperty("keyAlias")
                keyPassword = ksProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false   // Onyx SDK 는 리플렉션 사용 — 최소화 끔
            signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }

    packaging {
        jniLibs.pickFirsts += "**/libc++_shared.so" // onyxsdk-pen / pennative / mmkv 가 각각 포함
        resources.excludes += setOf("META-INF/*.version", "META-INF/DEPENDENCIES", "META-INF/LICENSE*", "META-INF/NOTICE*")
    }
}

// Onyx SDK 가 끌어오는 구 support 라이브러리는 androidx.core 와 클래스가 중복된다.
configurations.all { exclude(group = "com.android.support") }

dependencies {
    implementation("com.onyx.android.sdk:onyxsdk-pen:1.5.8")
    implementation("com.onyx.android.sdk:onyxsdk-device:1.3.6")
    implementation("org.lsposed.hiddenapibypass:hiddenapibypass:4.3")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303") // android.jar 의 org.json 은 JVM 테스트에서 스텁
}
