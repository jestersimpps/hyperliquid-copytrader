export const calculateBalanceRatio = (userBalance: number, trackedBalance: number): number => {
  if (trackedBalance === 0) return 0;
  return userBalance / trackedBalance;
};

export const scalePositionSize = (trackedSize: number, balanceRatio: number): number => {
  return trackedSize * balanceRatio;
};

export const scaleChangeAmount = (changeAmount: number, balanceRatio: number): number => {
  return changeAmount * balanceRatio;
};

export const formatScaledSize = (size: number, decimals: number = 4): number => {
  return parseFloat(size.toFixed(decimals));
};
