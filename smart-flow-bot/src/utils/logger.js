const fs = require('fs');
const path = require('path');
const config = require('../../config');

const LOG_LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};

class Logger {
  constructor() {
    this.level = LOG_LEVELS[config.logging.level] || LOG_LEVELS.info;
    this.logFile = config.logging.file;
    this.ensureLogDirectory();
  }

  ensureLogDirectory() {
    const logDir = path.dirname(this.logFile);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
  }

  formatMessage(level, message, data = null) {
    const timestamp = new Date().toISOString();
    const levelStr = level.toUpperCase().padEnd(5);
    let formatted = `[${timestamp}] [${levelStr}] ${message}`;
    if (data) {
      formatted += ` ${JSON.stringify(data)}`;
    }
    return formatted;
  }

  writeToFile(message) {
    try {
      fs.appendFileSync(this.logFile, message + '\n');
    } catch (err) {
      console.error('Failed to write to log file:', err.message);
    }
  }

  log(level, message, data = null) {
    if (LOG_LEVELS[level] >= this.level) {
      const formatted = this.formatMessage(level, message, data);

      // Console output with colors
      const colors = {
        debug: '\x1b[36m',  // Cyan
        info: '\x1b[32m',   // Green
        warn: '\x1b[33m',   // Yellow
        error: '\x1b[31m'   // Red
      };
      const reset = '\x1b[0m';

      console.log(`${colors[level] || ''}${formatted}${reset}`);

      // Also write to file
      this.writeToFile(formatted);
    }
  }

  debug(message, data = null) {
    this.log('debug', message, data);
  }

  info(message, data = null) {
    this.log('info', message, data);
  }

  warn(message, data = null) {
    this.log('warn', message, data);
  }

  error(message, data = null) {
    this.log('error', message, data);
  }

  // Special method for flow alerts (always log regardless of level)
  flow(ticker, heatScore, details) {
    const message = `FLOW ALERT: ${ticker} - Heat Score: ${heatScore}`;
    const formatted = this.formatMessage('info', message, details);
    console.log(`\x1b[35m${formatted}\x1b[0m`); // Magenta for flow alerts
    this.writeToFile(formatted);
  }
}

// Export singleton instance
module.exports = new Logger();
