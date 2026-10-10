#ifndef RFID_H
#define RFID_H

#include <Arduino.h>
#include <SPI.h>
#include <MFRC522.h>

// Initializes the RFID hardware
void setupRFID();

// Checks for a new RFID card and returns its UID if found.
// Returns an empty string if no card is present or if it was debounced.
String processRFID();

#endif // RFID_H
