#include "network.h"
#include "config.h"
#include <ESP8266WiFi.h>
#include <ESP8266HTTPClient.h>
#include <WiFiClientSecureBearSSL.h>

unsigned long lastWifiCheckTime = 0;
const unsigned long WIFI_CHECK_INTERVAL_MS = 10000;

void setupNetwork() {
    WiFi.mode(WIFI_STA);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    
    Serial.print(F("Connecting to Wi-Fi"));
    
    // Non-blocking wait for initial connection (timeout after ~10 seconds)
    int attempts = 0;
    while (WiFi.status() != WL_CONNECTED && attempts < 20) {
        delay(500);
        Serial.print(F("."));
        attempts++;
    }
    
    if (WiFi.status() == WL_CONNECTED) {
        Serial.println(F("\nWi-Fi connected successfully."));
        Serial.print(F("IP Address: "));
        Serial.println(WiFi.localIP());
    } else {
        Serial.println(F("\nWi-Fi connection failed. Will retry in background."));
    }
}

void maintainNetwork() {
    if (WiFi.status() != WL_CONNECTED) {
        unsigned long currentMillis = millis();
        // Attempt to reconnect every WIFI_CHECK_INTERVAL_MS
        if (currentMillis - lastWifiCheckTime >= WIFI_CHECK_INTERVAL_MS) {
            lastWifiCheckTime = currentMillis;
            Serial.println(F("Wi-Fi disconnected. Attempting to reconnect..."));
            WiFi.disconnect();
            WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
        }
    }
}

void sendRFIDEvent(const String& tagUid) {
    // If network is unavailable, fail fast.
    // This prevents blocking and preserves RFID scanning.
    if (WiFi.status() != WL_CONNECTED) {
        Serial.println(F("NETWORK ERROR: Wi-Fi unavailable, cannot send RFID event."));
        return;
    }

    BearSSL::WiFiClientSecure client;
    client.setInsecure();
    HTTPClient http;

    String url = String(BACKEND_BASE_URL) + "/api/rfid/events";
    
    // Construct JSON payload
    // Format: {"deviceId":"cart-001","tagUid":"123456789","event":"TAG_DETECTED"}
    String payload = "{\"deviceId\":\"" + String(DEVICE_ID) + "\",\"tagUid\":\"" + tagUid + "\",\"event\":\"TAG_DETECTED\"}";

    Serial.println("--- API REQUEST ---");
    Serial.println("POST " + url);
    Serial.println("Payload: " + payload);

    http.begin(client, url);
    http.addHeader("Content-Type", "application/json");
    
    // Set a reasonable timeout so it doesn't hang forever and block RFID reads
    http.setTimeout(3000); 

    int httpResponseCode = http.POST(payload);

    Serial.println("--- API RESPONSE ---");
    if (httpResponseCode > 0) {
        Serial.print(F("HTTP Response code: "));
        Serial.println(httpResponseCode);
        
        // Output response body (even if malformed, just log it)
        String response = http.getString();
        Serial.println("Response body: " + response);
    } else {
        // Handle timeout, connection refused, or HTTP errors
        Serial.print(F("NETWORK ERROR: HTTP POST failed, error: "));
        Serial.println(http.errorToString(httpResponseCode).c_str());
    }
    Serial.println("--------------------");

    // Free resources
    http.end();
}
