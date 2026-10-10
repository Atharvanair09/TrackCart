#include <Arduino.h>
#include "rfid.h"
#include "network.h"

void setup() {
    Serial.begin(115200);
    // Wait for serial port to connect
    while (!Serial) {
        ; 
    }
    Serial.println(F("\n\n--- Smart Shopping Cart: RFID Node (Phase 2) ---"));
    
    // Initialize the Network subsystem
    setupNetwork();

    // Initialize the RFID subsystem
    setupRFID();
}

void loop() {
    // 1. Maintain Wi-Fi connection (reconnect if lost)
    maintainNetwork();

    // 2. Process RFID card detection
    String tagUid = processRFID();

    // 3. If a new, non-debounced tag was detected, send to backend
    if (tagUid != "") {
        sendRFIDEvent(tagUid);
    }
}
