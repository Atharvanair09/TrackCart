#ifndef CONFIG_H
#define CONFIG_H

// Network Configuration
// Copy this file to config.h and fill in your actual values.
// config.h is gitignored and will NOT be committed.
#define WIFI_SSID "Your_SSID_Here"
#define WIFI_PASSWORD "Your_Password_Here"

// Backend Configuration
// Replace with your actual backend URL (e.g., http://192.168.1.100:8080)
#define BACKEND_BASE_URL "http://192.168.1.100:8080"

// Device Configuration
// Unique identifier for this smart cart
#define DEVICE_ID "cart-001"

// RFID Configuration
// Client-side debounce delay in milliseconds to prevent rapid-fire requests
// for the same stationary tag.
#define RFID_DEBOUNCE_DELAY_MS 2000

#endif // CONFIG_H
