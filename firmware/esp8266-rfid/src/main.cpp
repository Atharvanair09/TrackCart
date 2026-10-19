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
  maintainNetwork();

  String tagUid = processRFID();

  if (tagUid != "") {
    Serial.println(F("UID received by main loop"));
    Serial.println(F("Sending RFID event to backend..."));
    sendRFIDEvent(tagUid);
  }
}

