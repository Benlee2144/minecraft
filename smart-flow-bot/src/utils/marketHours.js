const config = require('../../config');

class MarketHours {
  constructor() {
    this.holidays2024 = [
      '2024-01-01', // New Year's Day
      '2024-01-15', // MLK Day
      '2024-02-19', // Presidents Day
      '2024-03-29', // Good Friday
      '2024-05-27', // Memorial Day
      '2024-06-19', // Juneteenth
      '2024-07-04', // Independence Day
      '2024-09-02', // Labor Day
      '2024-11-28', // Thanksgiving
      '2024-12-25'  // Christmas
    ];

    this.holidays2025 = [
      '2025-01-01', // New Year's Day
      '2025-01-20', // MLK Day
      '2025-02-17', // Presidents Day
      '2025-04-18', // Good Friday
      '2025-05-26', // Memorial Day
      '2025-06-19', // Juneteenth
      '2025-07-04', // Independence Day
      '2025-09-01', // Labor Day
      '2025-11-27', // Thanksgiving
      '2025-12-25'  // Christmas
    ];

    this.holidays2026 = [
      '2026-01-01', // New Year's Day
      '2026-01-19', // MLK Day
      '2026-02-16', // Presidents Day
      '2026-04-03', // Good Friday
      '2026-05-25', // Memorial Day
      '2026-06-19', // Juneteenth
      '2026-07-03', // Independence Day (observed)
      '2026-09-07', // Labor Day
      '2026-11-26', // Thanksgiving
      '2026-12-25'  // Christmas
    ];

    this.allHolidays = [...this.holidays2024, ...this.holidays2025, ...this.holidays2026];
  }

  // Get current time in Eastern timezone
  getEasternTime() {
    const now = new Date();
    const eastern = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    return eastern;
  }

  // Get today's date string in YYYY-MM-DD format (Eastern time)
  getTodayString() {
    const eastern = this.getEasternTime();
    return eastern.toISOString().split('T')[0];
  }

  // Check if today is a market holiday
  isHoliday(dateStr = null) {
    const date = dateStr || this.getTodayString();
    return this.allHolidays.includes(date);
  }

  // Check if today is a weekend
  isWeekend() {
    const eastern = this.getEasternTime();
    const day = eastern.getDay();
    return day === 0 || day === 6; // Sunday = 0, Saturday = 6
  }

  // Check if market is currently open
  isMarketOpen() {
    if (this.isWeekend() || this.isHoliday()) {
      return false;
    }

    const eastern = this.getEasternTime();
    const hours = eastern.getHours();
    const minutes = eastern.getMinutes();
    const currentTime = hours * 60 + minutes;

    const { marketOpen, marketClose } = config.filters;
    const openTime = marketOpen.hour * 60 + marketOpen.minute;
    const closeTime = marketClose.hour * 60 + marketClose.minute;

    return currentTime >= openTime && currentTime < closeTime;
  }

  // Get minutes since market open (useful for volume spike detection)
  getMinutesSinceOpen() {
    if (!this.isMarketOpen()) {
      return -1;
    }

    const eastern = this.getEasternTime();
    const hours = eastern.getHours();
    const minutes = eastern.getMinutes();
    const currentTime = hours * 60 + minutes;

    const { marketOpen } = config.filters;
    const openTime = marketOpen.hour * 60 + marketOpen.minute;

    return currentTime - openTime;
  }

  // Check if we're in the first N minutes of trading
  isInOpeningWindow(windowMinutes = 60) {
    const minutesSinceOpen = this.getMinutesSinceOpen();
    return minutesSinceOpen >= 0 && minutesSinceOpen <= windowMinutes;
  }

  // Format time for display (Eastern)
  formatTimeET() {
    const eastern = this.getEasternTime();
    return eastern.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: 'America/New_York'
    }) + ' ET';
  }

  // Get time until market open (in milliseconds)
  getTimeUntilOpen() {
    if (this.isMarketOpen()) {
      return 0;
    }

    const eastern = this.getEasternTime();
    const { marketOpen } = config.filters;

    // Set target to today's market open
    const target = new Date(eastern);
    target.setHours(marketOpen.hour, marketOpen.minute, 0, 0);

    // If market open has passed today, set to next trading day
    if (eastern >= target) {
      target.setDate(target.getDate() + 1);
    }

    // Skip weekends
    while (target.getDay() === 0 || target.getDay() === 6) {
      target.setDate(target.getDate() + 1);
    }

    // Skip holidays
    let targetStr = target.toISOString().split('T')[0];
    while (this.isHoliday(targetStr)) {
      target.setDate(target.getDate() + 1);
      targetStr = target.toISOString().split('T')[0];
    }

    return target.getTime() - eastern.getTime();
  }

  // Get time until market close (in milliseconds)
  getTimeUntilClose() {
    if (!this.isMarketOpen()) {
      return -1;
    }

    const eastern = this.getEasternTime();
    const { marketClose } = config.filters;

    const target = new Date(eastern);
    target.setHours(marketClose.hour, marketClose.minute, 0, 0);

    return target.getTime() - eastern.getTime();
  }

  // Calculate DTE (days to expiration) from expiration date string (YYYY-MM-DD)
  calculateDTE(expirationDate) {
    const today = new Date(this.getTodayString());
    const expiry = new Date(expirationDate);
    const diffTime = expiry.getTime() - today.getTime();
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    return Math.max(0, diffDays);
  }

  // Check if a date is within N trading days
  isWithinTradingDays(dateStr, days) {
    const dte = this.calculateDTE(dateStr);
    return dte <= days;
  }
}

// Export singleton instance
module.exports = new MarketHours();
