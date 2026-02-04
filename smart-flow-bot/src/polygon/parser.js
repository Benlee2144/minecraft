const logger = require('../utils/logger');

class PolygonParser {

  // Parse option ticker symbol
  // Format: O:AAPL241220C00200000
  // O:TICKER + YYMMDD + C/P + 8-digit strike (strike * 1000)
  parseOptionTicker(optionTicker) {
    try {
      // Remove O: prefix if present
      const ticker = optionTicker.replace('O:', '');

      // Find where the date starts (first digit after letters)
      const match = ticker.match(/^([A-Z]+)(\d{6})([CP])(\d{8})$/);

      if (!match) {
        logger.debug('Failed to parse option ticker', { optionTicker });
        return null;
      }

      const [, underlyingTicker, dateStr, optionType, strikeStr] = match;

      // Parse date (YYMMDD)
      const year = 2000 + parseInt(dateStr.substring(0, 2));
      const month = parseInt(dateStr.substring(2, 4));
      const day = parseInt(dateStr.substring(4, 6));
      const expiration = `${year}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;

      // Parse strike (8 digits, last 3 are decimals)
      const strike = parseInt(strikeStr) / 1000;

      return {
        optionTicker: 'O:' + ticker,
        underlyingTicker,
        expiration,
        optionType: optionType === 'C' ? 'call' : 'put',
        strike
      };
    } catch (error) {
      logger.error('Error parsing option ticker', { optionTicker, error: error.message });
      return null;
    }
  }

  // Parse trade message from WebSocket
  parseTrade(msg) {
    try {
      // Stock trade format
      if (!msg.sym?.startsWith('O:')) {
        return {
          type: 'stock_trade',
          ticker: msg.sym,
          price: msg.p,
          size: msg.s,
          timestamp: msg.t,
          conditions: msg.c,
          exchange: msg.x,
          tradeId: msg.i
        };
      }

      // Options trade format
      const optionDetails = this.parseOptionTicker(msg.sym);
      if (!optionDetails) return null;

      return {
        type: 'option_trade',
        ...optionDetails,
        price: msg.p,           // Option price per contract
        size: msg.s,            // Number of contracts
        timestamp: msg.t,       // Unix timestamp (nanoseconds)
        conditions: msg.c,      // Trade conditions
        exchange: msg.x,        // Exchange ID
        premium: msg.p * msg.s * 100, // Total premium (price * contracts * 100)
        sequenceNumber: msg.q   // Sequence number for ordering
      };
    } catch (error) {
      logger.error('Error parsing trade message', { msg, error: error.message });
      return null;
    }
  }

  // Parse quote message from WebSocket
  parseQuote(msg) {
    try {
      // Stock quote
      if (!msg.sym?.startsWith('O:')) {
        return {
          type: 'stock_quote',
          ticker: msg.sym,
          bidPrice: msg.bp,
          bidSize: msg.bs,
          askPrice: msg.ap,
          askSize: msg.as,
          timestamp: msg.t
        };
      }

      // Options quote
      const optionDetails = this.parseOptionTicker(msg.sym);
      if (!optionDetails) return null;

      return {
        type: 'option_quote',
        ...optionDetails,
        bidPrice: msg.bp,
        bidSize: msg.bs,
        askPrice: msg.ap,
        askSize: msg.as,
        timestamp: msg.t
      };
    } catch (error) {
      logger.error('Error parsing quote message', { msg, error: error.message });
      return null;
    }
  }

  // Parse aggregate message from WebSocket
  parseAggregate(msg) {
    try {
      return {
        type: msg.ev === 'AM' ? 'minute_agg' : 'second_agg',
        ticker: msg.sym,
        open: msg.o,
        high: msg.h,
        low: msg.l,
        close: msg.c,
        volume: msg.v,
        vwap: msg.vw,
        trades: msg.z,          // Number of trades in aggregate
        startTimestamp: msg.s,  // Start of aggregate window
        endTimestamp: msg.e,    // End of aggregate window
        avgTradeSize: msg.z > 0 ? msg.v / msg.z : 0
      };
    } catch (error) {
      logger.error('Error parsing aggregate message', { msg, error: error.message });
      return null;
    }
  }

  // Determine if trade was at bid, ask, or between
  determineTradeSide(trade, lastQuote) {
    if (!lastQuote) return 'unknown';

    const price = trade.price;
    const bid = lastQuote.bidPrice;
    const ask = lastQuote.askPrice;

    if (!bid || !ask) return 'unknown';

    const mid = (bid + ask) / 2;
    const spreadPercent = (ask - bid) / mid;

    // If price is at or above ask, it's bought at ask (bullish)
    if (price >= ask) return 'ask';

    // If price is at or below bid, it's sold at bid (bearish)
    if (price <= bid) return 'bid';

    // If between, determine based on which side it's closer to
    if (price > mid) return 'above_mid';
    if (price < mid) return 'below_mid';

    return 'mid';
  }

  // Detect if trades are part of a sweep (multiple exchanges hit quickly)
  detectSweepPattern(trades, timeWindowMs = 500) {
    if (trades.length < 2) return null;

    // Sort by timestamp
    const sorted = [...trades].sort((a, b) => a.timestamp - b.timestamp);

    // Group trades within time window
    const sweepGroups = [];
    let currentGroup = [sorted[0]];

    for (let i = 1; i < sorted.length; i++) {
      const timeDiff = (sorted[i].timestamp - currentGroup[0].timestamp) / 1000000; // Convert ns to ms

      if (timeDiff <= timeWindowMs) {
        currentGroup.push(sorted[i]);
      } else {
        if (currentGroup.length >= 2) {
          sweepGroups.push(currentGroup);
        }
        currentGroup = [sorted[i]];
      }
    }

    if (currentGroup.length >= 2) {
      sweepGroups.push(currentGroup);
    }

    // Analyze sweep groups
    const sweeps = sweepGroups.map(group => {
      const exchanges = new Set(group.map(t => t.exchange));
      const totalPremium = group.reduce((sum, t) => sum + t.premium, 0);
      const totalContracts = group.reduce((sum, t) => sum + t.size, 0);

      return {
        trades: group,
        exchangeCount: exchanges.size,
        totalPremium,
        totalContracts,
        startTime: group[0].timestamp,
        endTime: group[group.length - 1].timestamp,
        isSweep: exchanges.size >= 2 // Hit at least 2 exchanges
      };
    });

    return sweeps.filter(s => s.isSweep);
  }

  // Calculate OTM percentage
  calculateOTMPercent(strike, spotPrice, optionType) {
    if (!spotPrice || spotPrice === 0) return 0;

    if (optionType === 'call') {
      return ((strike - spotPrice) / spotPrice) * 100;
    } else {
      return ((spotPrice - strike) / spotPrice) * 100;
    }
  }

  // Check if option is OTM
  isOTM(strike, spotPrice, optionType) {
    if (optionType === 'call') {
      return strike > spotPrice;
    } else {
      return strike < spotPrice;
    }
  }

  // Format contract name for display
  formatContractName(optionDetails) {
    const { underlyingTicker, expiration, optionType, strike } = optionDetails;
    const date = new Date(expiration);
    const monthDay = date.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' });

    return `${underlyingTicker} ${monthDay} $${strike} ${optionType === 'call' ? 'Call' : 'Put'}`;
  }

  // Parse exchange ID to name
  getExchangeName(exchangeId) {
    const exchanges = {
      0: 'Unknown',
      1: 'NYSE American',
      2: 'NASDAQ BX',
      3: 'NYSE National',
      4: 'FINRA ADF',
      5: 'Market Independent',
      6: 'ISE',
      7: 'CBOE EDGA',
      8: 'CBOE EDGX',
      9: 'NYSE Chicago',
      10: 'NYSE',
      11: 'NYSE Arca',
      12: 'NASDAQ',
      13: 'CBOE C2',
      14: 'CBOE',
      15: 'NASDAQ BX Options',
      16: 'NASDAQ PHLX',
      17: 'MIAX',
      18: 'MIAX PEARL',
      19: 'MIAX EMERALD',
      20: 'MEMX'
    };

    return exchanges[exchangeId] || `Exchange ${exchangeId}`;
  }
}

// Export singleton instance
module.exports = new PolygonParser();
