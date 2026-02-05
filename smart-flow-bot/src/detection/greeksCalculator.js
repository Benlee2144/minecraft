/**
 * Greeks Calculator Module (Newton-Raphson Black-Scholes)
 * Calculates option Greeks for better trade analysis:
 * - Delta: Sensitivity to underlying price
 * - Gamma: Rate of delta change
 * - Theta: Time decay
 * - Vega: Sensitivity to volatility
 * - Implied Volatility: Market's expected volatility
 */

const logger = require('../utils/logger');

class GreeksCalculator {
  constructor() {
    // Risk-free rate (current Fed funds rate estimate)
    this.riskFreeRate = 0.05; // 5%

    // Newton-Raphson parameters
    this.maxIterations = 100;
    this.precision = 0.0001;
  }

  // Standard Normal CDF (Cumulative Distribution Function)
  normalCDF(x) {
    const a1 = 0.254829592;
    const a2 = -0.284496736;
    const a3 = 1.421413741;
    const a4 = -1.453152027;
    const a5 = 1.061405429;
    const p = 0.3275911;

    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x) / Math.sqrt(2);

    const t = 1.0 / (1.0 + p * x);
    const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

    return 0.5 * (1.0 + sign * y);
  }

  // Standard Normal PDF (Probability Density Function)
  normalPDF(x) {
    return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
  }

  // Calculate d1 and d2 for Black-Scholes
  calculateD1D2(S, K, T, r, sigma) {
    const d1 = (Math.log(S / K) + (r + (sigma * sigma) / 2) * T) / (sigma * Math.sqrt(T));
    const d2 = d1 - sigma * Math.sqrt(T);
    return { d1, d2 };
  }

  // Black-Scholes Option Price
  blackScholesPrice(S, K, T, r, sigma, isCall = true) {
    if (T <= 0) return Math.max(0, isCall ? S - K : K - S);

    const { d1, d2 } = this.calculateD1D2(S, K, T, r, sigma);

    if (isCall) {
      return S * this.normalCDF(d1) - K * Math.exp(-r * T) * this.normalCDF(d2);
    } else {
      return K * Math.exp(-r * T) * this.normalCDF(-d2) - S * this.normalCDF(-d1);
    }
  }

  // Calculate Implied Volatility using Newton-Raphson method
  calculateIV(optionPrice, S, K, T, r, isCall = true) {
    if (T <= 0 || optionPrice <= 0) return null;

    // Initial guess based on ATM approximation
    let sigma = Math.sqrt(2 * Math.PI / T) * (optionPrice / S);
    sigma = Math.max(0.01, Math.min(5.0, sigma)); // Bound between 1% and 500%

    for (let i = 0; i < this.maxIterations; i++) {
      const price = this.blackScholesPrice(S, K, T, r, sigma, isCall);
      const vega = this.calculateVega(S, K, T, r, sigma);

      if (Math.abs(vega) < 0.00001) {
        break; // Vega too small, stop iteration
      }

      const diff = optionPrice - price;

      if (Math.abs(diff) < this.precision) {
        return sigma; // Converged
      }

      // Newton-Raphson update
      sigma = sigma + diff / vega;

      // Keep sigma in reasonable bounds
      sigma = Math.max(0.001, Math.min(10.0, sigma));
    }

    return sigma;
  }

  // Calculate Delta
  calculateDelta(S, K, T, r, sigma, isCall = true) {
    if (T <= 0) {
      return isCall ? (S > K ? 1 : 0) : (S < K ? -1 : 0);
    }

    const { d1 } = this.calculateD1D2(S, K, T, r, sigma);

    if (isCall) {
      return this.normalCDF(d1);
    } else {
      return this.normalCDF(d1) - 1;
    }
  }

  // Calculate Gamma
  calculateGamma(S, K, T, r, sigma) {
    if (T <= 0) return 0;

    const { d1 } = this.calculateD1D2(S, K, T, r, sigma);
    return this.normalPDF(d1) / (S * sigma * Math.sqrt(T));
  }

  // Calculate Theta (per day)
  calculateTheta(S, K, T, r, sigma, isCall = true) {
    if (T <= 0) return 0;

    const { d1, d2 } = this.calculateD1D2(S, K, T, r, sigma);

    const term1 = -(S * this.normalPDF(d1) * sigma) / (2 * Math.sqrt(T));

    if (isCall) {
      const term2 = -r * K * Math.exp(-r * T) * this.normalCDF(d2);
      return (term1 + term2) / 365; // Per day
    } else {
      const term2 = r * K * Math.exp(-r * T) * this.normalCDF(-d2);
      return (term1 + term2) / 365; // Per day
    }
  }

  // Calculate Vega (per 1% move in IV)
  calculateVega(S, K, T, r, sigma) {
    if (T <= 0) return 0;

    const { d1 } = this.calculateD1D2(S, K, T, r, sigma);
    return S * Math.sqrt(T) * this.normalPDF(d1) / 100; // Per 1% IV change
  }

  // Calculate Rho
  calculateRho(S, K, T, r, sigma, isCall = true) {
    if (T <= 0) return 0;

    const { d2 } = this.calculateD1D2(S, K, T, r, sigma);

    if (isCall) {
      return K * T * Math.exp(-r * T) * this.normalCDF(d2) / 100;
    } else {
      return -K * T * Math.exp(-r * T) * this.normalCDF(-d2) / 100;
    }
  }

  // Calculate all Greeks at once
  calculateAllGreeks(spotPrice, strikePrice, daysToExpiry, optionPrice, isCall = true) {
    const S = spotPrice;
    const K = strikePrice;
    const T = daysToExpiry / 365; // Convert to years
    const r = this.riskFreeRate;

    // Calculate IV first
    const iv = this.calculateIV(optionPrice, S, K, T, r, isCall);

    if (!iv || iv <= 0) {
      return {
        error: 'Could not calculate implied volatility',
        spotPrice: S,
        strikePrice: K,
        daysToExpiry,
        optionPrice,
        isCall
      };
    }

    // Calculate all Greeks using the IV
    const delta = this.calculateDelta(S, K, T, r, iv, isCall);
    const gamma = this.calculateGamma(S, K, T, r, iv);
    const theta = this.calculateTheta(S, K, T, r, iv, isCall);
    const vega = this.calculateVega(S, K, T, r, iv);
    const rho = this.calculateRho(S, K, T, r, iv, isCall);

    // Calculate theoretical price for validation
    const theoreticalPrice = this.blackScholesPrice(S, K, T, r, iv, isCall);

    // Moneyness
    const moneyness = S / K;
    let moneynessLabel;
    if (moneyness > 1.05) moneynessLabel = isCall ? 'Deep ITM' : 'Deep OTM';
    else if (moneyness > 1.01) moneynessLabel = isCall ? 'ITM' : 'OTM';
    else if (moneyness > 0.99) moneynessLabel = 'ATM';
    else if (moneyness > 0.95) moneynessLabel = isCall ? 'OTM' : 'ITM';
    else moneynessLabel = isCall ? 'Deep OTM' : 'Deep ITM';

    return {
      spotPrice: S,
      strikePrice: K,
      daysToExpiry,
      optionPrice,
      theoreticalPrice: theoreticalPrice.toFixed(2),
      isCall,
      type: isCall ? 'CALL' : 'PUT',

      // Greeks
      delta: delta.toFixed(4),
      deltaPercent: (delta * 100).toFixed(1),
      gamma: gamma.toFixed(6),
      theta: theta.toFixed(4),
      vega: vega.toFixed(4),
      rho: rho.toFixed(4),

      // Volatility
      iv: iv,
      ivPercent: (iv * 100).toFixed(1),

      // Moneyness
      moneyness: moneyness.toFixed(3),
      moneynessLabel,

      // Trading insights
      dollarDelta: (delta * S * 100).toFixed(2), // Dollar delta for 100 shares
      gammaRisk: this.interpretGamma(gamma, S),
      thetaDecay: this.interpretTheta(theta, optionPrice),
      vegaExposure: this.interpretVega(vega, iv)
    };
  }

  // Interpret gamma for trading
  interpretGamma(gamma, S) {
    const gammaRisk = gamma * S * S * 0.01; // 1% move impact
    if (gammaRisk > 0.5) {
      return { level: 'HIGH', message: 'High gamma - delta will change significantly with price moves' };
    } else if (gammaRisk > 0.2) {
      return { level: 'MODERATE', message: 'Moderate gamma exposure' };
    }
    return { level: 'LOW', message: 'Low gamma - delta relatively stable' };
  }

  // Interpret theta for trading
  interpretTheta(theta, optionPrice) {
    if (optionPrice <= 0) return { level: 'N/A', message: 'Invalid option price' };

    const thetaPercent = Math.abs(theta / optionPrice) * 100;
    if (thetaPercent > 2) {
      return { level: 'HIGH', message: `Losing ${thetaPercent.toFixed(1)}% of value per day to time decay` };
    } else if (thetaPercent > 0.5) {
      return { level: 'MODERATE', message: `${thetaPercent.toFixed(1)}% daily time decay` };
    }
    return { level: 'LOW', message: 'Minimal time decay impact' };
  }

  // Interpret vega for trading
  interpretVega(vega, iv) {
    if (iv > 0.50) {
      return { level: 'ELEVATED_IV', message: 'High IV - vega risk if volatility drops' };
    } else if (iv > 0.30) {
      return { level: 'NORMAL_IV', message: 'Normal IV levels' };
    }
    return { level: 'LOW_IV', message: 'Low IV - potential for volatility expansion' };
  }

  // Estimate delta for a stock move
  estimateOptionMove(greeks, priceMovePercent) {
    const spotPrice = greeks.spotPrice;
    const priceMove = spotPrice * (priceMovePercent / 100);
    const newSpot = spotPrice + priceMove;

    // Linear delta approximation with gamma adjustment
    const deltaMove = parseFloat(greeks.delta) * priceMove * 100;
    const gammaAdjustment = 0.5 * parseFloat(greeks.gamma) * priceMove * priceMove * 100;

    const estimatedMove = deltaMove + gammaAdjustment;

    return {
      stockMove: `${priceMovePercent > 0 ? '+' : ''}${priceMovePercent}%`,
      newStockPrice: newSpot.toFixed(2),
      estimatedOptionMove: `$${estimatedMove.toFixed(2)}`,
      estimatedNewPrice: `$${(greeks.optionPrice + estimatedMove).toFixed(2)}`
    };
  }

  // Format Greeks for Discord
  formatGreeksEmbed(greeks) {
    const { EmbedBuilder } = require('discord.js');

    if (greeks.error) {
      return new EmbedBuilder()
        .setTitle('Greeks Calculator')
        .setDescription(`Error: ${greeks.error}`)
        .setColor(0xFF0000);
    }

    const deltaEmoji = parseFloat(greeks.delta) > 0.5 ? '🟢' : parseFloat(greeks.delta) > 0.3 ? '🟡' : '🔴';

    const embed = new EmbedBuilder()
      .setTitle(`📐 Option Greeks Analysis`)
      .setColor(greeks.isCall ? 0x00FF00 : 0xFF0000)
      .setTimestamp();

    let description = `**${greeks.type}** Strike: $${greeks.strikePrice} | DTE: ${greeks.daysToExpiry}\n`;
    description += `Spot: $${greeks.spotPrice} | Option: $${greeks.optionPrice}\n`;
    description += `Moneyness: ${greeks.moneynessLabel} (${greeks.moneyness})\n`;
    description += `\n`;

    embed.setDescription(description);

    // Greeks field
    embed.addFields({
      name: '📊 The Greeks',
      value: `${deltaEmoji} **Delta:** ${greeks.deltaPercent}% (${greeks.delta})\n` +
             `📈 **Gamma:** ${greeks.gamma}\n` +
             `⏰ **Theta:** $${greeks.theta}/day\n` +
             `📊 **Vega:** $${greeks.vega}/1% IV\n` +
             `💵 **Rho:** $${greeks.rho}/1% rate`,
      inline: true
    });

    // IV field
    embed.addFields({
      name: '📈 Implied Volatility',
      value: `**IV:** ${greeks.ivPercent}%\n${greeks.vegaExposure.message}`,
      inline: true
    });

    // Risk assessment
    embed.addFields({
      name: '⚠️ Risk Assessment',
      value: `**Gamma Risk:** ${greeks.gammaRisk.level}\n${greeks.gammaRisk.message}\n\n` +
             `**Time Decay:** ${greeks.thetaDecay.level}\n${greeks.thetaDecay.message}`,
      inline: false
    });

    // Price move estimates
    const moveUp = this.estimateOptionMove(greeks, 2);
    const moveDown = this.estimateOptionMove(greeks, -2);

    embed.addFields({
      name: '🎯 Price Sensitivity',
      value: `If stock +2%: Option ${moveUp.estimatedOptionMove}\n` +
             `If stock -2%: Option ${moveDown.estimatedOptionMove}`,
      inline: false
    });

    return embed;
  }

  // Quick delta lookup for common scenarios
  getQuickDelta(spotPrice, strikePrice, daysToExpiry, iv, isCall = true) {
    const T = daysToExpiry / 365;
    const sigma = iv / 100; // Convert from percentage

    return this.calculateDelta(spotPrice, strikePrice, T, this.riskFreeRate, sigma, isCall);
  }

  // Estimate option leverage
  getOptionLeverage(spotPrice, strikePrice, optionPrice, delta) {
    // Leverage = (Delta × Spot Price) / Option Price
    const leverage = (Math.abs(delta) * spotPrice) / optionPrice;
    return leverage.toFixed(1);
  }
}

module.exports = new GreeksCalculator();
