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
      const paths = ['/usr/local/bin/claude', '/opt/homebrew/bin/claude', 'claude'];
      for (const path of paths) {
        try {
          const test = await this.runCommand(path, ['--version']);
          if (test.success) {
            this.claudePath = path;
            this.enabled = true;
            logger.info(`Claude Code CLI found at ${path} - chat enabled`);
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

  // Run a shell command and return output
  runCommand(command, args) {
    return new Promise((resolve) => {
      const proc = spawn(command, args, {
        env: { ...process.env },
        shell: true
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
      let prompt = this.buildPrompt(message, context);

      // Use claude CLI with --print flag for non-interactive output
      // Escape the prompt for shell
      const escapedPrompt = prompt.replace(/'/g, "'\\''");

      const result = await this.runClaudeCommand(escapedPrompt);

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

  // Run claude command with timeout
  runClaudeCommand(prompt) {
    return new Promise((resolve) => {
      const timeout = 60000; // 60 second timeout

      // Use claude with -p (print) flag for single response
      const proc = spawn(this.claudePath || 'claude', ['-p', prompt], {
        env: { ...process.env },
        shell: true,
        timeout
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
    let prompt = `You are a trading assistant in a Discord server. Keep responses concise (under 1800 characters for Discord).

Guidelines:
- Help with trading concepts, market mechanics, and signal interpretation
- Never give specific buy/sell advice or price targets
- Always remind users that trading involves risk
- Be educational and clear`;

    // Add market context if available
    if (context.marketStatus) {
      prompt += `\n\nCurrent market status: ${context.marketStatus}`;
    }

    if (context.recentAlerts && context.recentAlerts.length > 0) {
      prompt += `\n\nRecent scanner alerts:`;
      context.recentAlerts.slice(0, 3).forEach(alert => {
        prompt += `\n- ${alert.ticker}: ${alert.signal_type} (Heat: ${alert.heat_score})`;
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
