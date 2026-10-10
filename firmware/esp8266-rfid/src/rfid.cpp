#include "rfid.h"
#include "config.h"

// Define the pins for RC522 on NodeMCU ESP-12E
// SS/SDA is connected to D2 (GPIO4)
// RST is connected to D1 (GPIO5)
#define RST_PIN         5          
#define SS_PIN          4         

MFRC522 mfrc522(SS_PIN, RST_PIN);  // Create MFRC522 instance

// Debouncing variables to handle transient RF dropouts
String lastUID = "";
unsigned long lastReadTime = 0;

void setupRFID() {
    SPI.begin();            // Init SPI bus
    mfrc522.PCD_Init();     // Init MFRC522
    delay(4);               // Optional delay. Some boards do need more time after init to be ready
    
    Serial.println(F("RFID subsystem initialized."));
    mfrc522.PCD_DumpVersionToSerial();  // Show details of PCD - MFRC522 Card Reader details
    Serial.println(F("Waiting for RFID cards..."));
}

String processRFID() {
    // Look for new cards. 
    // Note: If a card was read and placed in HALT state, it won't be detected as "new"
    // until it's physically removed from the field and brought back.
    if ( ! mfrc522.PICC_IsNewCardPresent()) {
        return "";
    }

    // Select one of the cards
    if ( ! mfrc522.PICC_ReadCardSerial()) {
        return "";
    }

    // A card has been read successfully. Extract UID.
    String currentUID = "";
    for (byte i = 0; i < mfrc522.uid.size; i++) {
        if(mfrc522.uid.uidByte[i] < 0x10) {
            currentUID += "0";
        }
        currentUID += String(mfrc522.uid.uidByte[i], HEX);
        if (i < mfrc522.uid.size - 1) {
            currentUID += ":";
        }
    }
    
    currentUID.toUpperCase();
    
    // Debounce check: Prevent duplicate triggers if the RF field drops out briefly
    unsigned long currentTime = millis();
    if (currentUID == lastUID && (currentTime - lastReadTime) < RFID_DEBOUNCE_DELAY_MS) {
        // Same card detected too soon due to bounce. Halt and ignore.
        mfrc522.PICC_HaltA();
        return "";
    }
    
    // Valid detection
    lastUID = currentUID;
    lastReadTime = currentTime;
    
    Serial.print(F("RFID DETECTED | UID: "));
    Serial.println(currentUID);

    // Halt PICC to stop reading this card until it's removed and re-presented
    mfrc522.PICC_HaltA();
    
    return currentUID;
}
