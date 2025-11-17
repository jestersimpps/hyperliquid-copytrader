#!/usr/bin/env python3

import json
import csv
import numpy as np
from pathlib import Path
from datetime import datetime
from typing import List, Dict, Tuple

TESTING_DIR = Path(__file__).parent.parent.parent / 'testing'
LOOKBACK_WINDOW = 20

LABEL_MAP = {
    'no_trade': 0,
    'open_long': 1,
    'open_short': 2,
    'close': 3,
    'add': 4
}

def load_ohlc_data(coin: str, timeframe: str) -> List[Dict]:
    filename = f'{coin.lower()}-ohlc-{timeframe}.json'
    filepath = TESTING_DIR / filename

    with open(filepath, 'r') as f:
        return json.load(f)

def load_trade_history(coin: str) -> List[Dict]:
    filepath = TESTING_DIR / 'trade_history.csv'
    trades = []

    with open(filepath, 'r') as f:
        reader = csv.DictReader(f)
        for row in reader:
            if row['coin'] == coin:
                time_str = row['time']
                dt = datetime.strptime(time_str, '%m/%d/%Y - %H:%M:%S')
                trades.append({
                    'time': dt.timestamp() * 1000,
                    'coin': row['coin'],
                    'dir': row['dir'],
                    'px': float(row['px']),
                    'sz': float(row['sz']),
                    'closedPnl': float(row['closedPnl']) if row['closedPnl'] else 0
                })

    return trades

def determine_action(current_trade, previous_trades) -> str:
    direction = current_trade['dir'].lower()

    if not previous_trades:
        return 'open_long' if 'long' in direction or 'buy' in direction else 'open_short'

    last_trade = previous_trades[-1]
    last_dir = last_trade['dir'].lower()
    current_dir = direction

    if current_trade['closedPnl'] != 0:
        return 'close'

    if current_dir == last_dir:
        return 'add'

    return 'open_long' if 'long' in current_dir or 'buy' in current_dir else 'open_short'

def label_candles(candles: List[Dict], trades: List[Dict]) -> np.ndarray:
    labels = np.zeros(len(candles), dtype=int)
    trade_idx = 0
    previous_trades = []

    for i, candle in enumerate(candles):
        candle_time = candle['timestamp']
        candle_end = candle_time + (60 * 1000)

        while trade_idx < len(trades) and trades[trade_idx]['time'] < candle_end:
            if trades[trade_idx]['time'] >= candle_time:
                action = determine_action(trades[trade_idx], previous_trades)
                labels[i] = LABEL_MAP[action]
                previous_trades.append(trades[trade_idx])
                break
            trade_idx += 1

    return labels

def normalize_features(features: np.ndarray) -> Tuple[np.ndarray, Dict]:
    means = np.mean(features, axis=0)
    stds = np.std(features, axis=0)
    stds[stds == 0] = 1

    normalized = (features - means) / stds

    return normalized, {'means': means.tolist(), 'stds': stds.tolist()}

def create_sequences(candles: List[Dict], labels: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
    features = []

    for candle in candles:
        features.append([
            candle['open'],
            candle['high'],
            candle['low'],
            candle['close'],
            candle['volume']
        ])

    features = np.array(features)

    if len(features) < LOOKBACK_WINDOW:
        print(f"Warning: Not enough data for lookback window ({len(features)} < {LOOKBACK_WINDOW})")
        return np.array([]), np.array([])

    X = []
    y = []

    for i in range(LOOKBACK_WINDOW, len(features)):
        X.append(features[i-LOOKBACK_WINDOW:i])
        y.append(labels[i])

    return np.array(X), np.array(y)

def main():
    coins = ['ASTER', 'ZEC', 'STRK', 'MET']
    timeframe = '5m'

    print('\n🚀 Preparing Training Data for Neural Network\n')

    for coin in coins:
        print(f'📊 Processing {coin}...')

        try:
            candles = load_ohlc_data(coin, timeframe)
            trades = load_trade_history(coin)

            if not trades:
                print(f'   ⚠️  No trades found for {coin}, skipping...')
                continue

            print(f'   ✓ Loaded {len(candles)} candles')
            print(f'   ✓ Loaded {len(trades)} trades')

            labels = label_candles(candles, trades)

            unique, counts = np.unique(labels, return_counts=True)
            label_dist = dict(zip(unique, counts))
            print(f'   ✓ Label distribution: {label_dist}')

            X, y = create_sequences(candles, labels)

            if len(X) == 0:
                print(f'   ⚠️  Not enough data for {coin}, skipping...')
                continue

            X_normalized, norm_params = normalize_features(X.reshape(-1, 5))
            X_normalized = X_normalized.reshape(X.shape)

            output_file = TESTING_DIR / f'training-data-{coin.lower()}.npz'
            np.savez(
                output_file,
                X=X_normalized,
                y=y,
                norm_params_means=np.array(norm_params['means']),
                norm_params_stds=np.array(norm_params['stds']),
                label_map=np.array(list(LABEL_MAP.values()))
            )

            print(f'   ✓ Saved {len(X)} sequences to {output_file.name}')
            print(f'   ✓ Input shape: {X.shape}')
            print(f'   ✓ Output shape: {y.shape}')

        except Exception as e:
            print(f'   ✗ Error processing {coin}: {str(e)}')
            continue

    print('\n✅ Data preparation complete!\n')

if __name__ == '__main__':
    main()
