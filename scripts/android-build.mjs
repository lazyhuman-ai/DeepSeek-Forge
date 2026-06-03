#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const projectDir = join(process.cwd(), "apps/android/ForgeAgentAndroid");
const wrapper = join(projectDir, process.platform === "win32" ? "gradlew.bat" : "gradlew");

if (!existsSync(projectDir)) {
  console.error("Android project not found at apps/android/ForgeAgentAndroid.");
  process.exit(1);
}

const env = { ...process.env };
if (!env.JAVA_HOME && existsSync("/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home")) {
  env.JAVA_HOME = "/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home";
}
if (!env.ANDROID_HOME && existsSync("/opt/homebrew/share/android-commandlinetools")) {
  env.ANDROID_HOME = "/opt/homebrew/share/android-commandlinetools";
}
if (!env.ANDROID_SDK_ROOT && env.ANDROID_HOME) {
  env.ANDROID_SDK_ROOT = env.ANDROID_HOME;
}
if (env.JAVA_HOME) {
  env.PATH = `${join(env.JAVA_HOME, "bin")}:${env.PATH ?? ""}`;
}

const java = spawnSync("java", ["-version"], { stdio: "pipe", env });
if (java.status !== 0) {
  console.error("Android build requires a Java runtime. Install Android Studio or JDK 17 first.");
  process.exit(1);
}

if (!existsSync(wrapper)) {
  console.error("Android Gradle wrapper is missing at apps/android/ForgeAgentAndroid/gradlew.");
  process.exit(1);
}

const tasks = process.argv.slice(2);
const gradleTasks = tasks.length > 0 ? tasks : ["assembleDebug"];

const build = spawnSync(wrapper, gradleTasks, {
  cwd: projectDir,
  env,
  stdio: "inherit",
});
process.exit(build.status ?? 1);
