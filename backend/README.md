# Smart Shopping Cart - Backend Phase 3

This backend service acts as the authoritative source for product information and handles RFID events from the ESP8266-based Smart Shopping Cart.

## Tech Stack
- **Node.js** & **Express**
- **PostgreSQL** (via `pg`)
- **Jest** & **Supertest** for testing

## Prerequisites
- Node.js (v18+)
- PostgreSQL (or Docker for local DB setup)

## Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Start the database:**
   For local development, you can use the provided Docker Compose file:
   ```bash
   docker-compose up -d
   ```

3. **Configure Environment:**
   Create a `.env` file in the `backend` directory if you need to override default DB credentials:
   ```env
   DB_USER=postgres
   DB_PASSWORD=password
   DB_HOST=localhost
   DB_NAME=smart_cart
   DB_PORT=5432
   PORT=3000
   ```

4. **Seed the database:**
   To create the tables and insert mock products for testing:
   ```bash
   npm run seed
   ```

5. **Start the server:**
   ```bash
   npm start
   # or for development:
   npm run dev
   ```

## API Endpoints

### `POST /api/rfid/events`
Processes RFID tag detections from the cart.

**Request Body:**
```json
{
  "deviceId": "cart-001",
  "tagUid": "12500123456",
  "event": "TAG_DETECTED"
}
```

**Response (Success - 200 OK):**
```json
{
  "message": "Product found",
  "product": {
    "productId": "PROD001",
    "name": "Smart Water Bottle",
    "price": 19.99,
    "category": "Accessories",
    "imageUrl": "https://example.com/bottle.jpg",
    "isActive": true,
    "inventoryQty": 50
  }
}
```

**Errors:**
- `400 Bad Request` if `deviceId` or `tagUid` are missing/invalid.
- `400 Bad Request` if the product is marked as inactive.
- `404 Not Found` if the tag is unregistered.

## Testing
Run the automated test suite:
```bash
npm test
```
