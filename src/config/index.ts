import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

export interface Config {
  privateKey: string | null;
  userWallet: string | null;
  trackedWallet: string | null;
  isTestnet: boolean;
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

  return {
    privateKey,
    userWallet,
    trackedWallet,
    isTestnet
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
