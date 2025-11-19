import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

export interface Config {
  privateKey: string | null;
  userWallet: string | null;
  trackedWallet: string | null;
  isTestnet: boolean;
  telegramBotToken: string | null;
  telegramChatId: string | null;
  minOrderValue: number;
  alertThresholdPercent: number;
  alertCooldownMs: number;
  dailyLossThresholds: number[];
  marginWarningThreshold: number;
  balanceDropThresholds: number[];
  positionSizeInfoThreshold: number;
  riskAlertCooldownMs: number;
}

const validateWalletAddress = (address: string | undefined, name: string): string | null => {
  if (!address) return null;

  if (!address.startsWith('0x') || address.length !== 42) {
    throw new Error(`Invalid ${name}: must start with 0x and be 42 characters long`);
  }

  return address;
};

const validatePrivateKey = (key: string | undefined): string | null => {
  if (!key) return null;

  if (!key.startsWith('0x') || key.length !== 66) {
    throw new Error('Invalid PRIVATE_KEY: must start with 0x and be 66 characters long');
  }

  return key;
};

export const loadConfig = (): Config => {
  const privateKey = validatePrivateKey(process.env.PRIVATE_KEY);
  const userWallet = validateWalletAddress(process.env.USER_WALLET, 'USER_WALLET');
  const trackedWallet = validateWalletAddress(process.env.TRACKED_WALLET, 'TRACKED_WALLET');
  const isTestnet = process.env.IS_TESTNET === 'true';
  const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN || null;
  const telegramChatId = process.env.TELEGRAM_CHAT_ID || null;
  const minOrderValue = process.env.MIN_ORDER_VALUE ? parseFloat(process.env.MIN_ORDER_VALUE) : 11;
  const alertThresholdPercent = process.env.ALERT_THRESHOLD_PERCENT ? parseFloat(process.env.ALERT_THRESHOLD_PERCENT) : 10;
  const alertCooldownMs = process.env.ALERT_COOLDOWN_MS ? parseInt(process.env.ALERT_COOLDOWN_MS) : 5 * 60 * 1000;

  const dailyLossThresholds = process.env.DAILY_LOSS_THRESHOLDS
    ? process.env.DAILY_LOSS_THRESHOLDS.split(',').map(Number)
    : [5, 10, 15, 20];
  const marginWarningThreshold = process.env.MARGIN_WARNING_THRESHOLD ? parseFloat(process.env.MARGIN_WARNING_THRESHOLD) : 15;
  const balanceDropThresholds = process.env.BALANCE_DROP_THRESHOLDS
    ? process.env.BALANCE_DROP_THRESHOLDS.split(',').map(Number)
    : [5, 10, 15, 20];
  const positionSizeInfoThreshold = process.env.POSITION_SIZE_INFO_THRESHOLD ? parseFloat(process.env.POSITION_SIZE_INFO_THRESHOLD) : 50;
  const riskAlertCooldownMs = process.env.RISK_ALERT_COOLDOWN_MS ? parseInt(process.env.RISK_ALERT_COOLDOWN_MS) : 30 * 60 * 1000;

  return {
    privateKey,
    userWallet,
    trackedWallet,
    isTestnet,
    telegramBotToken,
    telegramChatId,
    minOrderValue,
    alertThresholdPercent,
    alertCooldownMs,
    dailyLossThresholds,
    marginWarningThreshold,
    balanceDropThresholds,
    positionSizeInfoThreshold,
    riskAlertCooldownMs
  };
};

export const hasExecutionConfig = (): boolean => {
  try {
    const config = loadConfig();
    return !!(config.privateKey && config.userWallet);
  } catch {
    return false;
  }
};
