/**
 * Test file for Smart Flow Scanner
 * Run with: npm run test
 *
 * This tests the detection logic without connecting to Discord
 */

const config = require('../config');
const logger = require('./utils/logger');
const marketHours = require('./utils/marketHours');
const database = require('./database/sqlite');
const heatScore = require('./detection/heatScore');
const parser = require('./polygon/parser');

// Test data
const testSweep = {
  type: 'sweep',
  underlyingTicker: 'NVDA',
  optionTicker: 'O:NVDA250418C00950000',
  optionType: 'call',
  strike: 950,
  expiration: '2025-04-18',
  totalPremium: 1847000, // $1.847M
  totalContracts: 500,
  avgPrice: 36.94,
  exchangeCount: 4,
  exchanges: [14, 16, 17, 18],
  tradeCount: 12,
  tradeSide: 'ask',
  isBullish: true,
  isAtAsk: true,
  timestamp: Date.now()
};

const testContext = {
  spotPrice: 912.45,
  hasVolumeSpike: true,
  volumeMultiple: 4.2,
  ivAnomaly: true,
  ivChange: 12.5
};

function runTests() {
  console.log('\n' + '='.repeat(60));
  console.log('Smart Flow Scanner - Test Suite');
  console.log('='.repeat(60) + '\n');

  // Test 1: Market Hours
  console.log('TEST 1: Market Hours');
  console.log('-'.repeat(40));
  console.log(`  Current time (ET): ${marketHours.formatTimeET()}`);
  console.log(`  Is market open: ${marketHours.isMarketOpen()}`);
  console.log(`  Is weekend: ${marketHours.isWeekend()}`);
  console.log(`  Minutes since open: ${marketHours.getMinutesSinceOpen()}`);
  console.log();

  // Test 2: Option Ticker Parser
  console.log('TEST 2: Option Ticker Parser');
  console.log('-'.repeat(40));
  const parsed = parser.parseOptionTicker('O:NVDA250418C00950000');
  console.log('  Input: O:NVDA250418C00950000');
  console.log('  Parsed:', JSON.stringify(parsed, null, 4));
  console.log();

  // Test 3: Heat Score Calculation
  console.log('TEST 3: Heat Score Calculation');
  console.log('-'.repeat(40));

  // Initialize database for signal counting
  database.initialize();

  // Add some test signals to database
  database.addHeatSignal('NVDA', 'sweep', 500000);
  database.addHeatSignal('NVDA', 'sweep', 800000);

  const result = heatScore.calculate(testSweep, testContext);

  console.log(`  Ticker: ${result.ticker}`);
  console.log(`  Contract: ${result.contract}`);
  console.log(`  Heat Score: ${result.heatScore}/100`);
  console.log(`  Is High Conviction: ${result.isHighConviction}`);
  console.log(`  Meets Threshold: ${result.meetsThreshold}`);
  console.log(`  Channel: ${result.channel}`);
  console.log();
  console.log('  Signal Breakdown:');
  result.breakdown.forEach(b => {
    console.log(`    - ${b.signal} (+${b.points})`);
  });
  console.log();

  // Test 4: DTE Calculation
  console.log('TEST 4: DTE Calculation');
  console.log('-'.repeat(40));
  const testDates = [
    { date: new Date().toISOString().split('T')[0], label: 'Today' },
    { date: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().split('T')[0], label: '3 days out' },
    { date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0], label: '7 days out' },
    { date: '2025-04-18', label: 'April 18, 2025' }
  ];

  testDates.forEach(({ date, label }) => {
    const dte = marketHours.calculateDTE(date);
    console.log(`  ${label} (${date}): ${dte} DTE`);
  });
  console.log();

  // Test 5: Formatted Output
  console.log('TEST 5: Formatted Alert Output');
  console.log('-'.repeat(40));
  const formatters = require('./discord/formatters');
  const textOutput = formatters.formatFlowAlertText(result);
  console.log(textOutput);
  console.log();

  // Test 6: Database Operations
  console.log('TEST 6: Database Operations');
  console.log('-'.repeat(40));

  // Save test alert
  const alertId = database.saveAlert({
    ticker: result.ticker,
    contract: result.contract,
    heatScore: result.heatScore,
    premium: result.premium,
    strike: result.strike,
    spotPrice: result.spotPrice,
    expiration: testSweep.expiration,
    optionType: testSweep.optionType,
    signalBreakdown: result.breakdown,
    channel: result.channel
  });
  console.log(`  Saved alert with ID: ${alertId}`);

  // Get hot tickers
  const hotTickers = database.getHotTickers(5);
  console.log('  Hot tickers:', hotTickers);

  // Get signal count
  const signalCount = database.getSignalCount('NVDA', 60);
  console.log(`  NVDA signals in last 60 min: ${signalCount}`);
  console.log();

  // Test 7: Config Values
  console.log('TEST 7: Configuration');
  console.log('-'.repeat(40));
  console.log(`  High conviction threshold: ${config.heatScore.highConvictionThreshold}`);
  console.log(`  Alert threshold: ${config.heatScore.alertThreshold}`);
  console.log(`  Min premium: $${config.detection.minPremiumForAlert.toLocaleString()}`);
  console.log(`  Volume spike multiplier: ${config.detection.volumeSpikeMultiplier}x`);
  console.log(`  Top tickers count: ${config.topTickers.length}`);
  console.log();

  // Cleanup
  database.close();

  console.log('='.repeat(60));
  console.log('All tests completed!');
  console.log('='.repeat(60) + '\n');
}

// Run tests
runTests();
