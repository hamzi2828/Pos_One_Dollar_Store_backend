// The whole app runs on shop time (Pakistan): "today", day and month boundaries,
// bill dates. Set before anything else uses Date (owner 2026-11-06).
process.env.TZ = process.env.SHOP_TZ || 'Asia/Karachi';
require('dotenv').config();
// Data change log: every create / update / delete on every model is recorded
// (helper/changeTracker.js). Must be registered before any model is loaded.
require('mongoose').plugin(require('./src/helper/changeTracker').changeTracker);
const { auditContextMiddleware } = require('./src/helper/auditContext');
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const requestTiming = require('./src/middleware/requestTiming');
const path = require('path');
const { mongoose, ensureConnection } = require('./src/config/mongo');
const app = express();
const port = process.env.PORT || 4000;
const allRoutes = require('./src/routes/allRoutes');
const auditLogger = require('./src/middleware/auditLogger');

const dashboardRoutes = require('./src/routes/dashboardRoutes');

// CORS: allow the admin panel to call the API.
// FRONTEND_ORIGIN may list several sites, comma separated.
const FRONTEND_ORIGINS = (process.env.FRONTEND_ORIGIN || 'http://localhost:3000')
  .split(',')
  .map((o) => o.trim().replace(/\/$/, ''))
  .filter(Boolean);
app.use(cors({
  // employee.dollarandco.org: the Employee Portal on its own address (owner 2026-11-19).
  origin: [...FRONTEND_ORIGINS, 'https://employee.dollarandco.org', 'http://localhost:3000', 'http://localhost:3001'],
  credentials: true,
  // Server-Timing: POS speed logs read the server's own time.
  // ETag: the POS keeps it to ask for the offline catalogue with If-None-Match.
  exposedHeaders: ['Server-Timing', 'ETag'],
}));

// Gzip every API answer (Vercel did this for us; on Coolify the app must).
// Product lists and the offline catalogue are big JSON and the shop's link to
// the server is slow, so this cuts load time a lot.
// Time every request (Server-Timing header + log of slow ones). First, so it
// measures everything the server does.
app.use(requestTiming);
// Request id + who-is-calling context for the data change log.
app.use(auditContextMiddleware);
app.use(compression());

app.use(express.json({ limit: '50mb' }));

// Also add urlencoded parser for form data
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Serve uploaded files statically (must match path in helper/upload.js)
app.use('/uploads', express.static(path.resolve(__dirname, 'uploads')));

// Middleware to ensure MongoDB connection for serverless environments
app.use('/api', async (req, res, next) => {
  try {
    await ensureConnection();
    next();
  } catch (error) {
    console.error('Failed to ensure MongoDB connection:', error);
    res.status(503).json({
      error: 'Database connection failed',
      message: 'Please try again in a moment'
    });
  }
});


// Dashboard routes (authentication required)
app.use('/dashboard', async (req, res, next) => {
  try {
    await ensureConnection();
    next();
  } catch (error) {
    console.error('Failed to ensure MongoDB connection:', error);
    res.status(503).json({
      error: 'Database connection failed',
      message: 'Please try again in a moment'
    });
  }
}, dashboardRoutes);

// Add the same middleware for other routes that need database
app.use('/', async (req, res, next) => {
  // Skip for static routes and non-database routes
  if (req.path.startsWith('/uploads') || req.path === '/' || req.path === '/health') {
    return next();
  }
  try {
    await ensureConnection();
    next();
  } catch (error) {
    console.error('Failed to ensure MongoDB connection:', error);
    res.status(503).json({
      error: 'Database connection failed',
      message: 'Please try again in a moment'
    });
  }
});

// Welcome route
app.get('/', (req, res) => {
  try {
    const mongoose = require('mongoose');

    res.json({
      message: 'DOLLAR & Co POS API',
      status: 'running',
      timestamp: new Date().toISOString(),
      version: '1.0.0',
      database: {
        status: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
        readyState: mongoose.connection.readyState
      },
      environment: process.env.NODE_ENV || 'development'
    });
  } catch (error) {
    console.error('Error in welcome route:', error);
    res.status(500).json({
      message: 'DOLLAR & Co POS API',
      status: 'error',
      error: error.message,
      timestamp: new Date().toISOString(),
      version: '1.0.0'
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  try {
    const mongoose = require('mongoose');
    const isDbConnected = mongoose.connection.readyState === 1;

    res.status(isDbConnected ? 200 : 503).json({
      status: isDbConnected ? 'healthy' : 'unhealthy',
      database: {
        status: isDbConnected ? 'connected' : 'disconnected',
        readyState: mongoose.connection.readyState
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Protected routes (authentication required for most)
app.use('/', async (req, res, next) => {
  try {
    await ensureConnection();
    next();
  } catch (error) {
    console.error('Failed to ensure MongoDB connection:', error);
    res.status(503).json({
      error: 'Database connection failed',
      message: 'Please try again in a moment'
    });
  }
}, auditLogger, allRoutes);

// Global error handler for Multer and other errors
app.use((error, req, res, next) => {
  if (error.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ 
      error: 'File too large', 
      message: `File size exceeds the maximum limit of ${process.env.UPLOAD_MAX_FILE_SIZE_MB || 5}MB` 
    });
  }
  
  if (error.code === 'LIMIT_UNEXPECTED_FILE') {
    return res.status(400).json({
      error: 'Too many files',
      message: `Too many files${error.field ? ` for "${error.field}"` : ''}. Please upload fewer files.`,
    });
  }
  
  if (error.name === 'MulterError') {
    return res.status(400).json({ 
      error: 'Upload error', 
      message: error.message 
    });
  }
  
  // Default error handler
  console.error(error);
  res.status(500).json({ 
    error: 'Internal server error', 
    message: error.message || 'Something went wrong' 
  });
});

// On Vercel the platform runs the exported app; locally we start a server.
if (!process.env.VERCEL) {
  app.listen(port, () => {
    console.log(`Server is running at http://localhost:${port}`);
  });
}

module.exports = app;

