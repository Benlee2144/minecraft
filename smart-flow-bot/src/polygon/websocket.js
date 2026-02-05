const WebSocket = require('ws');
const EventEmitter = require('events');
const config = require('../../config');
const logger = require('../utils/logger');
const parser = require('./parser');

class PolygonWebSocket extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.isConnected = false;
    this.isAuthenticated = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectDelay = 1000;
    this.subscribedChannels = new Set();
    this.heartbeatInterval = null;
    this.lastMessageTime = Date.now();
  }

  connect() {
    return new Promise((resolve, reject) => {
      try {
        logger.info('Connecting to Polygon WebSocket...');

        // Polygon has different WebSocket URLs for different data types
        // For options, we use the options socket
        this.ws = new WebSocket(config.polygon.wsUrl);

        this.ws.on('open', () => {
          logger.info('WebSocket connection opened');
          this.isConnected = true;
          this.reconnectAttempts = 0;
          this.authenticate();
          this.startHeartbeat();
          resolve();
        });

        this.ws.on('message', (data) => {
          this.lastMessageTime = Date.now();
          this.handleMessage(data);
        });

        this.ws.on('close', (code, reason) => {
          logger.warn('WebSocket connection closed', { code, reason: reason?.toString() });
          this.isConnected = false;
          this.isAuthenticated = false;
          this.stopHeartbeat();
          this.handleReconnect();
        });

        this.ws.on('error', (error) => {
          logger.error('WebSocket error', { error: error.message });
          this.emit('error', error);
          if (!this.isConnected) {
            reject(error);
          }
        });

      } catch (error) {
        logger.error('Failed to create WebSocket connection', { error: error.message });
        reject(error);
      }
    });
  }

  authenticate() {
    const authMessage = {
      action: 'auth',
      params: config.polygon.apiKey
    };

    this.send(authMessage);
    logger.info('Authentication message sent');
  }

  handleMessage(data) {
    try {
      const messages = JSON.parse(data.toString());

      // Polygon sends messages as arrays
      const messageArray = Array.isArray(messages) ? messages : [messages];

      for (const msg of messageArray) {
        switch (msg.ev) {
          case 'status':
            this.handleStatusMessage(msg);
            break;

          case 'A':  // Aggregate (second)
          case 'AM': // Aggregate (minute)
            this.handleAggregateMessage(msg);
            break;

          case 'T':  // Trade
            this.handleTradeMessage(msg);
            break;

          case 'Q':  // Quote
            this.handleQuoteMessage(msg);
            break;

          default:
            logger.debug('Unknown message type', { event: msg.ev, message: msg });
        }
      }
    } catch (error) {
      logger.error('Failed to parse WebSocket message', { error: error.message, data: data.toString() });
    }
  }

  handleStatusMessage(msg) {
    if (msg.status === 'connected') {
      logger.info('WebSocket connected to Polygon');
    } else if (msg.status === 'auth_success') {
      logger.info('WebSocket authentication successful');
      this.isAuthenticated = true;
      this.emit('authenticated');
      this.resubscribe();
    } else if (msg.status === 'auth_failed') {
      logger.error('WebSocket authentication failed', { message: msg.message });
      this.emit('auth_failed', msg.message);
    } else if (msg.status === 'success') {
      logger.debug('Subscription successful', { message: msg.message });
    } else {
      logger.debug('Status message', { status: msg.status, message: msg.message });
    }
  }

  handleAggregateMessage(msg) {
    const parsed = parser.parseAggregate(msg);
    if (parsed) {
      this.emit('aggregate', parsed);
    }
  }

  handleTradeMessage(msg) {
    const parsed = parser.parseTrade(msg);
    if (parsed) {
      this.emit('trade', parsed);
    }
  }

  handleQuoteMessage(msg) {
    const parsed = parser.parseQuote(msg);
    if (parsed) {
      this.emit('quote', parsed);
    }
  }

  send(message) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
      return true;
    }
    logger.warn('Cannot send message, WebSocket not open');
    return false;
  }

  subscribe(channels) {
    if (!Array.isArray(channels)) {
      channels = [channels];
    }

    for (const channel of channels) {
      this.subscribedChannels.add(channel);
    }

    if (this.isAuthenticated) {
      const subscribeMessage = {
        action: 'subscribe',
        params: channels.join(',')
      };

      this.send(subscribeMessage);
      logger.info('Subscribed to channels', { channels });
    }
  }

  unsubscribe(channels) {
    if (!Array.isArray(channels)) {
      channels = [channels];
    }

    for (const channel of channels) {
      this.subscribedChannels.delete(channel);
    }

    const unsubscribeMessage = {
      action: 'unsubscribe',
      params: channels.join(',')
    };

    this.send(unsubscribeMessage);
    logger.info('Unsubscribed from channels', { channels });
  }

  resubscribe() {
    if (this.subscribedChannels.size > 0) {
      // Limit to 20 channels max for Starter plan
      const allChannels = Array.from(this.subscribedChannels);
      const channels = allChannels.slice(0, 20);

      // Clear and re-add only the limited set
      this.subscribedChannels.clear();
      channels.forEach(ch => this.subscribedChannels.add(ch));

      const subscribeMessage = {
        action: 'subscribe',
        params: channels.join(',')
      };

      this.send(subscribeMessage);
      logger.info('Resubscribed to channels', { count: channels.length });
    }
  }

  // Clear all subscriptions
  clearSubscriptions() {
    this.subscribedChannels.clear();
    logger.info('Cleared all WebSocket subscriptions');
  }

  // Subscribe to options trades for specific tickers
  subscribeToOptionsTrades(tickers) {
    // For Polygon options, format is: O:AAPL241220C00200000
    // But we can subscribe to all options for a ticker using: T.O:AAPL*
    const channels = tickers.map(ticker => `T.O:${ticker}`);
    this.subscribe(channels);
  }

  // Subscribe to stock aggregates for volume monitoring
  subscribeToStockAggregates(tickers) {
    const channels = tickers.map(ticker => `AM.${ticker}`);
    this.subscribe(channels);
  }

  // Subscribe to stock trades for real-time price
  subscribeToStockTrades(tickers) {
    const channels = tickers.map(ticker => `T.${ticker}`);
    this.subscribe(channels);
  }

  startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      const timeSinceLastMessage = Date.now() - this.lastMessageTime;

      // If no message in 30 seconds, connection might be dead
      if (timeSinceLastMessage > 30000) {
        logger.warn('No messages received in 30 seconds, reconnecting...');
        this.reconnect();
      }
    }, 10000);
  }

  stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  handleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error('Max reconnection attempts reached');
      this.emit('max_reconnect_reached');
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);

    logger.info(`Attempting to reconnect in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

    setTimeout(() => {
      this.connect().catch(error => {
        logger.error('Reconnection failed', { error: error.message });
      });
    }, delay);
  }

  reconnect() {
    this.close();
    this.handleReconnect();
  }

  close() {
    this.stopHeartbeat();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.isConnected = false;
    this.isAuthenticated = false;
  }

  getStatus() {
    return {
      connected: this.isConnected,
      authenticated: this.isAuthenticated,
      subscribedChannels: Array.from(this.subscribedChannels),
      reconnectAttempts: this.reconnectAttempts
    };
  }
}

// Export singleton instance
module.exports = new PolygonWebSocket();
