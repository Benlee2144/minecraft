const Anthropic = require('@anthropic-ai/sdk');
const config = require('../../config');
const logger = require('../utils/logger');

class ClaudeChat {
  constructor() {
    this.client = null;
    this.conversationHistory = new Map(); // userId -> messages[]
    this.maxHistoryLength = 20; // Keep last 20 messages per user
  }

  initialize() {
    if (!config.anthropic?.apiKey) {
      logger.warn('Anthropic API key not configured - Claude chat disabled');
      return false;
    }

    try {
      this.client = new Anthropic({
        apiKey: config.anthropic.apiKey
      });
      logger.info('Claude chat service initialized');
      return true;
    } catch (error) {
      logger.error('Failed to initialize Claude chat', { error: error.message });
      return false;
    }
  }

  isEnabled() {
    return this.client !== null;
  }

  // Get or create conversation history for a user
  getHistory(userId) {
    if (!this.conversationHistory.has(userId)) {
      this.conversationHistory.set(userId, []);
    }
    return this.conversationHistory.get(userId);
  }

  // Add message to history
  addToHistory(userId, role, content) {
    const history = this.getHistory(userId);
    history.push({ role, content });

    // Trim history if too long
    if (history.length > this.maxHistoryLength) {
      history.splice(0, history.length - this.maxHistoryLength);
    }
  }

  // Clear conversation history for a user
  clearHistory(userId) {
    this.conversationHistory.delete(userId);
    return true;
  }

  // Send a message to Claude and get response
  async chat(userId, message, context = {}) {
    if (!this.client) {
      return {
        success: false,
        error: 'Claude chat not configured. Add ANTHROPIC_API_KEY to enable.'
      };
    }

    try {
      // Add user message to history
      this.addToHistory(userId, 'user', message);

      // Build system prompt with trading context
      const systemPrompt = this.buildSystemPrompt(context);

      // Get conversation history
      const history = this.getHistory(userId);

      // Call Claude API
      const response = await this.client.messages.create({
        model: config.anthropic?.model || 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: systemPrompt,
        messages: history
      });

      // Extract response text
      const responseText = response.content[0]?.text || 'No response generated.';

      // Add assistant response to history
      this.addToHistory(userId, 'assistant', responseText);

      return {
        success: true,
        response: responseText,
        usage: {
          inputTokens: response.usage?.input_tokens,
          outputTokens: response.usage?.output_tokens
        }
      };

    } catch (error) {
      logger.error('Claude chat error', { error: error.message, userId });

      // Handle specific errors
      if (error.status === 401) {
        return {
          success: false,
          error: 'Invalid API key. Check your ANTHROPIC_API_KEY.'
        };
      }
      if (error.status === 429) {
        return {
          success: false,
          error: 'Rate limited. Try again in a moment.'
        };
      }
      if (error.status === 529) {
        return {
          success: false,
          error: 'Claude is overloaded. Try again shortly.'
        };
      }

      return {
        success: false,
        error: `Chat error: ${error.message}`
      };
    }
  }

  // Build system prompt with trading context
  buildSystemPrompt(context = {}) {
    let prompt = `You are a helpful trading assistant in a Discord server focused on stock trading and day trading.

Your role:
- Help traders understand market signals, volume patterns, and price action
- Explain trading concepts clearly and concisely
- Provide educational information about trading strategies
- Answer questions about stocks and market mechanics

Important guidelines:
- Keep responses concise (Discord has a 2000 character limit)
- Never give specific buy/sell advice or price targets
- Always remind users that trading involves risk
- Focus on education and analysis, not predictions
- Use trading terminology appropriately`;

    // Add market context if available
    if (context.marketStatus) {
      prompt += `\n\nCurrent market status: ${context.marketStatus}`;
    }

    if (context.recentAlerts && context.recentAlerts.length > 0) {
      prompt += `\n\nRecent scanner alerts (for context):`;
      context.recentAlerts.slice(0, 5).forEach(alert => {
        prompt += `\n- ${alert.ticker}: ${alert.signal_type} (Heat: ${alert.heat_score})`;
      });
    }

    return prompt;
  }

  // Quick one-off question without history
  async quickQuestion(question, context = {}) {
    if (!this.client) {
      return {
        success: false,
        error: 'Claude chat not configured.'
      };
    }

    try {
      const response = await this.client.messages.create({
        model: config.anthropic?.model || 'claude-sonnet-4-20250514',
        max_tokens: 512,
        system: this.buildSystemPrompt(context),
        messages: [{ role: 'user', content: question }]
      });

      return {
        success: true,
        response: response.content[0]?.text || 'No response.'
      };
    } catch (error) {
      logger.error('Claude quick question error', { error: error.message });
      return {
        success: false,
        error: error.message
      };
    }
  }
}

// Export singleton
module.exports = new ClaudeChat();
