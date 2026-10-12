const express = require('express');
const cors = require('cors');
const { initDb } = require('./db');
const rfidRoutes = require('./routes/rfid');

const app = express();
const PORT = process.env.PORT || 3000;

// CORS configuration.
// In production, set CORS_ORIGIN to the deployed frontend URL.
// In local development, all origins are allowed by default.
const corsOptions = process.env.CORS_ORIGIN
  ? { origin: process.env.CORS_ORIGIN }
  : {};
app.use(cors(corsOptions));
app.use(express.json());

// Routes
app.use('/api/rfid', rfidRoutes);
const sessionRoutes = require('./routes/sessions');
app.use('/api/sessions', sessionRoutes);

// Database initialization
initDb().then(() => {
  if (process.env.NODE_ENV !== 'test') {
    // Bind to 0.0.0.0 so Render's reverse proxy can reach the server.
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Server running on port ${PORT}`);
    });
  }
}).catch(console.error);

module.exports = app; // For testing
