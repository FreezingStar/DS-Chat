#!/usr/bin/env bash
# Build a signed, installable APK without Gradle / the Android SDK manager.
# Requires: openjdk-17 (javac/keytool), aapt, zipalign, apksigner, tools/android.jar, tools/r8.jar
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
TOOLS="$APP_DIR/tools"
ANDROID="$APP_DIR/android"
BUILD="$APP_DIR/build"
SDK_JAR="$TOOLS/android.jar"
R8_JAR="$TOOLS/r8.jar"
KEYSTORE="$APP_DIR/keystore.jks"
KS_PASS="dschat-local"
KS_ALIAS="dschat"

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }

command -v javac >/dev/null || { echo "javac not found"; exit 1; }
[ -f "$SDK_JAR" ] || { echo "missing tools/android.jar"; exit 1; }
[ -f "$R8_JAR" ] || { echo "missing tools/r8.jar"; exit 1; }

rm -rf "$BUILD"
mkdir -p "$BUILD/classes" "$BUILD/dex" "$BUILD/gen"

say "compiling java"
javac -encoding UTF-8 -source 11 -target 11 -Xlint:-options \
  -classpath "$SDK_JAR" \
  -d "$BUILD/classes" \
  $(find "$ANDROID/java" -name '*.java')

say "dexing with d8"
java -cp "$R8_JAR" com.android.tools.r8.D8 \
  --release --min-api 29 --lib "$SDK_JAR" \
  --output "$BUILD/dex" \
  $(find "$BUILD/classes" -name '*.class')

say "packaging resources + assets"
aapt package -f \
  -M "$ANDROID/AndroidManifest.xml" \
  -S "$ANDROID/res" \
  -A "$ANDROID/assets" \
  -I "$SDK_JAR" \
  -F "$BUILD/unsigned.ap_"

say "adding classes.dex"
(cd "$BUILD/dex" && aapt add -f "$BUILD/unsigned.ap_" classes.dex >/dev/null)

say "aligning"
zipalign -f 4 "$BUILD/unsigned.ap_" "$BUILD/aligned.apk"

if [ ! -f "$KEYSTORE" ]; then
  say "creating signing key"
  keytool -genkeypair -keystore "$KEYSTORE" -alias "$KS_ALIAS" \
    -keyalg RSA -keysize 2048 -validity 10950 \
    -storepass "$KS_PASS" -keypass "$KS_PASS" \
    -dname "CN=DS Chat, OU=Mobile, O=Personal, L=Shanghai, C=CN" >/dev/null
fi

say "signing"
apksigner sign --ks "$KEYSTORE" --ks-key-alias "$KS_ALIAS" \
  --ks-pass "pass:$KS_PASS" --key-pass "pass:$KS_PASS" \
  --out "$BUILD/DS-Chat.apk" "$BUILD/aligned.apk"

say "verifying"
apksigner verify --print-certs "$BUILD/DS-Chat.apk" | head -3
aapt dump badging "$BUILD/DS-Chat.apk" | grep -E "^(package|sdkVersion|targetSdkVersion|application-label|launchable-activity)" | head -6

SIZE=$(du -h "$BUILD/DS-Chat.apk" | cut -f1)
say "done: $BUILD/DS-Chat.apk ($SIZE)"
