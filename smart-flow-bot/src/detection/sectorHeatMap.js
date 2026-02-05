const logger = require('../utils/logger');
const polygonRest = require('../polygon/rest');

class SectorHeatMap {
  constructor() {
    // Sector ETFs and their top holdings
    this.sectors = {
      'XLK': { name: 'Technology', emoji: '💻', tickers: ['AAPL', 'MSFT', 'NVDA', 'AVGO', 'AMD', 'CRM', 'ADBE', 'ORCL', 'CSCO', 'INTC'] },
      'XLF': { name: 'Financials', emoji: '🏦', tickers: ['JPM', 'BAC', 'WFC', 'GS', 'MS', 'C', 'BLK', 'SCHW', 'AXP', 'USB'] },
      'XLE': { name: 'Energy', emoji: '⛽', tickers: ['XOM', 'CVX', 'COP', 'SLB', 'EOG', 'MPC', 'PSX', 'VLO', 'PXD', 'OXY'] },
      'XLV': { name: 'Healthcare', emoji: '🏥', tickers: ['UNH', 'JNJ', 'LLY', 'PFE', 'ABBV', 'MRK', 'TMO', 'ABT', 'DHR', 'BMY'] },
      'XLY': { name: 'Consumer Disc', emoji: '🛍️', tickers: ['AMZN', 'TSLA', 'HD', 'MCD', 'NKE', 'LOW', 'SBUX', 'TJX', 'BKNG', 'CMG'] },
      'XLP': { name: 'Consumer Staples', emoji: '🛒', tickers: ['PG', 'KO', 'PEP', 'COST', 'WMT', 'PM', 'MDLZ', 'MO', 'CL', 'KHC'] },
      'XLI': { name: 'Industrials', emoji: '🏭', tickers: ['RTX', 'HON', 'UPS', 'CAT', 'BA', 'GE', 'DE', 'LMT', 'MMM', 'UNP'] },
      'XLU': { name: 'Utilities', emoji: '⚡', tickers: ['NEE', 'DUK', 'SO', 'D', 'AEP', 'SRE', 'EXC', 'XEL', 'PEG', 'WEC'] },
      'XLRE': { name: 'Real Estate', emoji: '🏠', tickers: ['PLD', 'AMT', 'EQIX', 'CCI', 'SPG', 'PSA', 'O', 'WELL', 'DLR', 'AVB'] },
      'XLB': { name: 'Materials', emoji: '🧱', tickers: ['LIN', 'APD', 'SHW', 'FCX', 'ECL', 'NEM', 'NUE', 'DOW', 'CTVA', 'DD'] },
      'XLC': { name: 'Communications', emoji: '📱', tickers: ['META', 'GOOGL', 'GOOG', 'NFLX', 'DIS', 'CMCSA', 'VZ', 'T', 'TMUS', 'CHTR'] }
    };

    // Current sector data
    this.sectorData = new Map();
    this.lastUpdate = null;
  }

  // Update all sector ETFs
  async updateSectors() {
    const etfs = Object.keys(this.sectors);

    for (const etf of etfs) {
      try {
        const snapshot = await polygonRest.getStockSnapshot(etf);
        if (snapshot) {
          this.sectorData.set(etf, {
            ...this.sectors[etf],
            etf,
            price: snapshot.price,
            change: snapshot.todayChange,
            changePercent: snapshot.todayChangePercent,
            volume: snapshot.todayVolume,
            lastUpdate: Date.now()
          });
        }
      } catch (error) {
        logger.debug(`Failed to fetch ${etf}`, { error: error.message });
      }
    }

    this.lastUpdate = Date.now();
    return this.getRanking();
  }

  // Get sector for a ticker
  getSectorForTicker(ticker) {
    ticker = ticker.toUpperCase();

    for (const [etf, sector] of Object.entries(this.sectors)) {
      if (sector.tickers.includes(ticker)) {
        return {
          etf,
          name: sector.name,
          emoji: sector.emoji,
          data: this.sectorData.get(etf)
        };
      }
    }

    return null;
  }

  // Get ranking of sectors by performance
  getRanking() {
    const sectors = Array.from(this.sectorData.values())
      .filter(s => s.changePercent !== null && s.changePercent !== undefined)
      .sort((a, b) => b.changePercent - a.changePercent);

    return sectors.map((s, i) => ({
      rank: i + 1,
      etf: s.etf,
      name: s.name,
      emoji: s.emoji,
      change: s.changePercent,
      direction: s.changePercent > 0.3 ? 'hot' : (s.changePercent < -0.3 ? 'cold' : 'neutral')
    }));
  }

  // Get hot sectors (top 3)
  getHotSectors() {
    return this.getRanking().filter(s => s.direction === 'hot').slice(0, 3);
  }

  // Get cold sectors (bottom 3)
  getColdSectors() {
    return this.getRanking().filter(s => s.direction === 'cold').slice(-3).reverse();
  }

  // Check if a ticker is in a hot sector
  isInHotSector(ticker) {
    const sector = this.getSectorForTicker(ticker);
    if (!sector || !sector.data) return null;

    const hotSectors = this.getHotSectors().map(s => s.etf);
    const isHot = hotSectors.includes(sector.etf);

    return {
      isHot,
      sector: sector.name,
      sectorChange: sector.data.changePercent?.toFixed(2),
      emoji: sector.emoji
    };
  }

  // Format sector heat map for Discord
  formatHeatMap() {
    const ranking = this.getRanking();
    if (ranking.length === 0) return 'No sector data available';

    const lines = ranking.map(s => {
      const bar = s.change > 0 ? '🟢' : (s.change < 0 ? '🔴' : '⚪');
      const changeStr = `${s.change > 0 ? '+' : ''}${s.change.toFixed(2)}%`;
      return `${bar} ${s.emoji} **${s.name}**: ${changeStr}`;
    });

    return lines.join('\n');
  }

  // Format compact version for alerts
  formatCompact() {
    const hot = this.getHotSectors();
    const cold = this.getColdSectors();

    let text = '';
    if (hot.length > 0) {
      text += `🔥 Hot: ${hot.map(s => `${s.emoji}${s.name}`).join(', ')}`;
    }
    if (cold.length > 0) {
      text += `\n❄️ Cold: ${cold.map(s => `${s.emoji}${s.name}`).join(', ')}`;
    }

    return text || 'Sectors balanced';
  }

  // Get sector context for alert
  getSectorContext(ticker) {
    const sector = this.getSectorForTicker(ticker);
    if (!sector || !sector.data) return null;

    const ranking = this.getRanking();
    const rank = ranking.findIndex(s => s.etf === sector.etf) + 1;

    return {
      name: sector.name,
      emoji: sector.emoji,
      change: sector.data.changePercent?.toFixed(2),
      rank: rank,
      totalSectors: ranking.length,
      isLeader: rank <= 3,
      isLaggard: rank >= ranking.length - 2
    };
  }

  // Check if data is fresh
  isDataFresh() {
    return this.lastUpdate && (Date.now() - this.lastUpdate < 300000); // 5 min
  }
}

// Export singleton
module.exports = new SectorHeatMap();
