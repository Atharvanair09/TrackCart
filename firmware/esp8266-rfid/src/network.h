#ifndef NETWORK_H
#define NETWORK_H

#include <Arduino.h>

// Initializes Wi-Fi connection
void setupNetwork();

// Maintains Wi-Fi connection, reconnecting if necessary
void maintainNetwork();

// Sends an RFID event to the backend API
void sendRFIDEvent(const String& tagUid);

#endif // NETWORK_H
