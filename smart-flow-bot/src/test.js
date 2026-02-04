/**
 * Test file for Smart Stock Scanner
 * Run with: npm run test
 *
 * This tests the detection logic without connecting to Discord
 */

const config = require('../config');
const logger = require('./utils/logger');
const marketHours = require('./utils/marketHours');
const database = require('./database/sqlite');
const stockHeatScore = require('./detection/stockHeatScore');
const stockSignals = require('./detection/stockSignals');

// Test data - Stock trade
const testTrade = {
  type: 'stock_trade',
  ticker: 'NVDA',
  price: 912.45,
  size: 50000,
  timestamp: Date.now() * 1000000, // Nanoseconds
  exchange: 12
};

// Test data - Aggregate (minute bar)
const testAggregate = {
  type: 'minute_agg',
  ticker: 'NVDA',
  open: 910.00,
  high: 915.00,
  low: 908.00,
  close: 912.45,
  volume: 1500000,
  vwap: 911.50,
  trades: 5000,
  avgTradeSize: 300
};

// Test signal for heat score calculation
const testVolumeSignal = {
  type: 'volume_spike',
  ticker: 'NVDA',
  price: 912.45,
  rvol: 4.2,
  currentVolume: 2100000,
  avgVolume: 500000,
  description: '4.2x relative volume spike detected',
  severity: 'high'
};

const testBlockSignal = {
  type: 'block_trade',
  ticker: 'AAPL',
  price: 185.50,
  size: 100000,
  tradeValue: 18550000,
  isLargeBlock: true,
  avgTradeSize: 500,
  description: '$18.55M block trade detected',
  severity: 'high'
};

const testMomentumSignal = {
  type: 'momentum_surge',
  ticker: 'TSLA',
  price: 245.00,
  priceChange: 3.5,
  timeWindowSeconds: 60,
  description: '3.5% price surge in 60 seconds',
  severity: 'medium'
};

function runTests() {
  console.log('\n' + '='.repeat(60));
  console.log('Smart Stock Scanner - Test Suite');
  console.log('='.repeat(60) + '\n');

  // Test 1: Market Hours
  console.log('TEST 1: Market Hours');
  console.log('-'.repeat(40));
  console.log(`  Current time (ET): ${marketHours.formatTimeET()}`);
  console.log(`  Is market open: ${marketHours.isMarketOpen()}`);
  console.log(`  Is weekend: ${marketHours.isWeekend()}`);
  console.log(`  Minutes since open: ${marketHours.getMinutesSinceOpen()}`);
  console.log();

  // Test 2: Configuration
  console.log('TEST 2: Configuration');
  console.log('-'.repeat(40));
  console.log(`  WebSocket URL: ${config.polygon.wsUrl}`);
  console.log(`  High conviction threshold: ${config.heatScore.highConvictionThreshold}`);
  console.log(`  Alert threshold: ${config.heatScore.alertThreshold}`);
  console.log(`  Volume spike multiplier: ${config.detection.volumeSpikeMultiplier}x`);
  console.log(`  Min block value: $${config.detection.minBlockValue.toLocaleString()}`);
  console.log(`  Top tickers count: ${config.topTickers.length}`);
  console.log();

  // Test 3: Heat Score - Volume Spike
  console.log('TEST 3: Heat Score - Volume Spike');
  console.log('-'.repeat(40));

  // Initialize database for signal counting
  database.initialize();

  // Add some test signals to database
  database.addHeatSignal('NVDA', 'volume_spike', 500000);
  database.addHeatSignal('NVDA', 'momentum_surge', 800000);

  const volumeResult = stockHeatScore.calculate(testVolumeSignal, {
    hasVolumeSpike: true,
    volumeMultiple: 4.2
  });

  console.log(`  Ticker: ${volumeResult.ticker}`);
  console.log(`  Signal Type: ${volumeResult.signalType}`);
  console.log(`  Heat Score: ${volumeResult.heatScore}/100`);
  console.log(`  Is High Conviction: ${volumeResult.isHighConviction}`);
  console.log(`  Meets Threshold: ${volumeResult.meetsThreshold}`);
  console.log(`  Channel: ${volumeResult.channel}`);
  console.log();
  console.log('  Signal Breakdown:');
  volumeResult.breakdown.forEach(b => {
    console.log(`    - ${b.signal} (+${b.points})`);
  });
  console.log();

  // Test 4: Heat Score - Block Trade
  console.log('TEST 4: Heat Score - Block Trade');
  console.log('-'.repeat(40));

  const blockResult = stockHeatScore.calculate(testBlockSignal, {});

  console.log(`  Ticker: ${blockResult.ticker}`);
  console.log(`  Signal Type: ${blockResult.signalType}`);
  console.log(`  Heat Score: ${blockResult.heatScore}/100`);
  console.log(`  Is High Conviction: ${blockResult.isHighConviction}`);
  console.log();
  console.log('  Signal Breakdown:');
  blockResult.breakdown.forEach(b => {
    console.log(`    - ${b.signal} (+${b.points})`);
  });
  console.log();

  // Test 5: Heat Score - Momentum Surge
  console.log('TEST 5: Heat Score - Momentum Surge');
  console.log('-'.repeat(40));

  const momentumResult = stockHeatScore.calculate(testMomentumSignal, {});

  console.log(`  Ticker: ${momentumResult.ticker}`);
  console.log(`  Signal Type: ${momentumResult.signalType}`);
  console.log(`  Heat Score: ${momentumResult.heatScore}/100`);
  console.log(`  Is High Conviction: ${momentumResult.isHighConviction}`);
  console.log();
  console.log('  Signal Breakdown:');
  momentumResult.breakdown.forEach(b => {
    console.log(`    - ${b.signal} (+${b.points})`);
  });
  console.log();

  // Test 6: Stock Signals Initialization
  console.log('TEST 6: Stock Signals Detector');
  console.log('-'.repeat(40));

  stockSignals.initialize();
  stockSignals.setBaseline('NVDA', 50000000);
  stockSignals.setBaseline('AAPL', 60000000);
  stockSignals.setBaseline('TSLA', 80000000);

  console.log('  Initialized stock signal detector');
  console.log(`  Baselines loaded: ${stockSignals.volumeBaselines.size}`);
  console.log();

  // Test 7: Process Test Trade
  console.log('TEST 7: Process Stock Trade');
  console.log('-'.repeat(40));

  const tradeSignals = stockSignals.processTrade(testTrade);
  console.log(`  Trade: ${testTrade.ticker} - ${testTrade.size} shares @ $${testTrade.price}`);
  console.log(`  Trade Value: $${(testTrade.size * testTrade.price).toLocaleString()}`);
  console.log(`  Signals Generated: ${tradeSignals ? tradeSignals.length : 0}`);

  if (tradeSignals && tradeSignals.length > 0) {
    tradeSignals.forEach(sig => {
      console.log(`    - ${sig.type}: ${sig.description}`);
    });
  }
  console.log();

  // Test 8: Process Test Aggregate
  console.log('TEST 8: Process Aggregate (Minute Bar)');
  console.log('-'.repeat(40));

  const aggSignals = stockSignals.processAggregate(testAggregate);
  console.log(`  Aggregate: ${testAggregate.ticker}`);
  console.log(`  OHLC: $${testAggregate.open} / $${testAggregate.high} / $${testAggregate.low} / $${testAggregate.close}`);
  console.log(`  Volume: ${testAggregate.volume.toLocaleString()}`);
  console.log(`  VWAP: $${testAggregate.vwap}`);
  console.log(`  Signals Generated: ${aggSignals ? aggSignals.length : 0}`);

  if (aggSignals && aggSignals.length > 0) {
    aggSignals.forEach(sig => {
      console.log(`    - ${sig.type}: ${sig.description}`);
    });
  }
  console.log();

  // Test 9: Database Operations
  console.log('TEST 9: Database Operations');
  console.log('-'.repeat(40));

  // Save test alert
  const alertId = database.saveAlert({
    ticker: volumeResult.ticker,
    signalType: 'volume_spike',
    heatScore: volumeResult.heatScore,
    price: testVolumeSignal.price,
    volume: testVolumeSignal.currentVolume,
    signalBreakdown: volumeResult.breakdown,
    channel: volumeResult.channel
  });
  console.log(`  Saved alert with ID: ${alertId}`);

  // Get hot tickers
  const hotTickers = database.getHotTickers(5);
  console.log('  Hot tickers:', hotTickers.map(t => t.ticker).join(', '));

  // Get signal count
  const signalCount = database.getSignalCount('NVDA', 60);
  console.log(`  NVDA signals in last 60 min: ${signalCount}`);
  console.log();

  // Test 10: Heat Ranking
  console.log('TEST 10: Heat Ranking');
  console.log('-'.repeat(40));

  const heatRanking = stockHeatScore.getHeatRanking(5);
  console.log('  Top 5 by heat:');
  heatRanking.forEach((t, i) => {
    console.log(`    ${i + 1}. ${t.ticker} - Heat: ${t.heat}/100, Signals: ${t.signalCount}`);
  });
  console.log();

  // Cleanup
  stockSignals.shutdown();
  database.close();

  console.log('='.repeat(60));
  console.log('All tests completed!');
  console.log('='.repeat(60) + '\n');
}

// Run tests
runTests();
