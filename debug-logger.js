// Simple debug logger to help track sync issues
const fs = require('fs');
const path = require('path');

const debugLogFile = path.join(__dirname, 'sync-debug.log');

function debugLog(message) {
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] ${message}\n`;
  
  // Write to both console and file
  console.log(message);
  fs.appendFileSync(debugLogFile, logEntry);
}

module.exports = { debugLog };