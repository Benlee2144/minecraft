const { spawn } = require('child_process');
const logger = require('../utils/logger');

class ClaudeChat {
  constructor() {
    this.enabled = false;
    this.claudePath = null;
  }

  async initialize() {
    // Check if claude CLI is available
    try {
      const result = await this.runCommand('which', ['claude']);
      if (result.success && result.output.trim()) {
        this.claudePath = result.output.trim();
        this.enabled = true;
        logger.info('Claude Code CLI found - chat enabled (using Max subscription)');
        return true;
      }
    } catch (error) {
      // Try common paths
      const paths = ['/usr/local/bin/claude', '/opt/homebrew/bin/claude', '/Users/benjaminarp/.local/bin/claude'];
      for (const testPath of paths) {
        try {
          const test = await this.runCommand(testPath, ['--version']);
          if (test.success) {
            this.claudePath = testPath;
            this.enabled = true;
            logger.info(`Claude Code CLI found at ${testPath} - chat enabled`);
            return true;
          }
        } catch (e) {
          // Continue trying
        }
      }
    }

    logger.warn('Claude Code CLI not found - chat disabled. Run: npm install -g @anthropic-ai/claude-code && claude /login');
    return false;
  }

  isEnabled() {
    return this.enabled;
  }

  // Run a command without shell (safer)
  runCommand(command, args) {
    return new Promise((resolve) => {
      const proc = spawn(command, args, {
        env: { ...process.env }
        // No shell: true - this is safer
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        resolve({
          success: code === 0,
          output: stdout,
          error: stderr,
          code
        });
      });

      proc.on('error', (err) => {
        resolve({
          success: false,
          output: '',
          error: err.message,
          code: -1
        });
      });
    });
  }

  // Send a message to Claude via CLI
  async chat(userId, message, context = {}) {
    if (!this.enabled) {
      return {
        success: false,
        error: 'Claude CLI not available. Install with: npm install -g @anthropic-ai/claude-code && claude /login'
      };
    }

    try {
      // Build the prompt with trading context
      const prompt = this.buildPrompt(message, context);

      const result = await this.runClaudeCommand(prompt);

      if (result.success) {
        return {
          success: true,
          response: result.output.trim() || 'No response generated.'
        };
      } else {
        logger.error('Claude CLI error', { error: result.error });
        return {
          success: false,
          error: result.error || 'Claude CLI returned an error'
        };
      }
    } catch (error) {
      logger.error('Claude chat error', { error: error.message, userId });
      return {
        success: false,
        error: `Chat error: ${error.message}`
      };
    }
  }

  // Run claude command with timeout (no shell)
  runClaudeCommand(prompt) {
    return new Promise((resolve) => {
      const timeout = 60000; // 60 second timeout

      // Use claude with -p (print) flag for single response
      // Pass prompt as argument directly - no shell escaping needed
      const proc = spawn(this.claudePath, ['-p', prompt], {
        env: { ...process.env }
        // No shell: true - arguments are passed directly to the process
      });

      let stdout = '';
      let stderr = '';
      let resolved = false;

      const timeoutId = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          proc.kill();
          resolve({
            success: false,
            output: '',
            error: 'Request timed out after 60 seconds'
          });
        }
      }, timeout);

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeoutId);
          resolve({
            success: code === 0,
            output: stdout,
            error: stderr
          });
        }
      });

      proc.on('error', (err) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeoutId);
          resolve({
            success: false,
            output: '',
            error: err.message
          });
        }
      });
    });
  }

  // Build prompt with trading context
  buildPrompt(message, context = {}) {
    let prompt = `You are a trading assistant in a Discord server. Keep responses concise under 1800 characters for Discord.

Guidelines:
- Help with trading concepts, market mechanics, and signal interpretation
- Never give specific buy or sell advice or price targets
- Always remind users that trading involves risk
- Be educational and clear`;

    // Add market context if available
    if (context.marketStatus) {
      prompt += `\n\nCurrent market status: ${context.marketStatus}`;
    }

    if (context.recentAlerts && context.recentAlerts.length > 0) {
      prompt += `\n\nRecent scanner alerts:`;
      context.recentAlerts.slice(0, 3).forEach(alert => {
        prompt += `\n- ${alert.ticker}: ${alert.signal_type} Heat ${alert.heat_score}`;
      });
    }

    prompt += `\n\nUser question: ${message}`;

    return prompt;
  }

  // Quick question (same as chat for CLI version)
  async quickQuestion(question, context = {}) {
    return this.chat('quick', question, context);
  }

  // Clear history (no-op for CLI version - each request is independent)
  clearHistory(userId) {
    // CLI version doesn't maintain history
    return true;
  }
}

// Export singleton
module.exports = new ClaudeChat();
