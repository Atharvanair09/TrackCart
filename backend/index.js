const express = require('express');
const cors = require('cors');
const { initDb } = require('./db');
const rfidRoutes = require('./routes/rfid');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Routes
app.use('/api/rfid', rfidRoutes);
const sessionRoutes = require('./routes/sessions');
app.use('/api/sessions', sessionRoutes);

// Database initialization
initDb().then(() => {
  if (process.env.NODE_ENV !== 'test') {
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  }
}).catch(console.error);

module.exports = app; // For testing
