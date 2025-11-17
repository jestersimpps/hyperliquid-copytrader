#!/usr/bin/env python3

import numpy as np
import csv
from pathlib import Path
from datetime import datetime
import tensorflow as tf

TESTING_DIR = Path(__file__).parent.parent.parent / 'testing'
MODELS_DIR = TESTING_DIR / 'models'

ACTION_MAP = {
    0: 'no_trade',
    1: 'open_long',
    2: 'open_short',
    3: 'close',
    4: 'add'
}

DIRECTION_MAP = {
    'open_long': 'long',
    'open_short': 'short',
    'close': 'close',
    'add': 'add',
    'no_trade': 'none'
}

def load_model(coin: str):
    model_path = MODELS_DIR / f'{coin.lower()}-strategy.h5'

    if not model_path.exists():
        raise FileNotFoundError(f'Model not found: {model_path}')

    return tf.keras.models.load_model(model_path)

def load_test_data(coin: str):
    filepath = TESTING_DIR / f'training-data-{coin.lower()}.npz'

    if not filepath.exists():
        raise FileNotFoundError(f'Training data not found: {filepath}')

    data = np.load(filepath, allow_pickle=True)
    return data['X'], data['y']

def load_candles(coin: str, timeframe: str = '5m'):
    import json

    filename = f'{coin.lower()}-ohlc-{timeframe}.json'
    filepath = TESTING_DIR / filename

    with open(filepath, 'r') as f:
        return json.load(f)

def generate_predictions(model, X, candles, lookback_window=20):
    predictions = model.predict(X, verbose=0)
    predicted_classes = np.argmax(predictions, axis=1)

    trades = []

    for i, (pred_class, confidence) in enumerate(zip(predicted_classes, predictions)):
        action = ACTION_MAP[pred_class]

        if action == 'no_trade':
            continue

        candle_idx = i + lookback_window

        if candle_idx >= len(candles):
            continue

        candle = candles[candle_idx]

        trades.append({
            'timestamp': candle['timestamp'],
            'datetime': datetime.fromtimestamp(candle['timestamp'] / 1000).isoformat(),
            'action': action,
            'direction': DIRECTION_MAP[action],
            'price': candle['close'],
            'confidence': float(np.max(confidence)),
            'candle_index': candle_idx
        })

    return trades

def save_predictions(coin: str, predictions):
    output_path = TESTING_DIR / f'predicted-trades-{coin.lower()}.csv'

    with open(output_path, 'w', newline='') as f:
        if not predictions:
            f.write('timestamp,datetime,action,direction,price,confidence\n')
            return

        fieldnames = ['timestamp', 'datetime', 'action', 'direction', 'price', 'confidence']
        writer = csv.DictWriter(f, fieldnames=fieldnames)

        writer.writeheader()
        for pred in predictions:
            writer.writerow({
                'timestamp': pred['timestamp'],
                'datetime': pred['datetime'],
                'action': pred['action'],
                'direction': pred['direction'],
                'price': f"{pred['price']:.4f}",
                'confidence': f"{pred['confidence']:.4f}"
            })

    return output_path

def main():
    coins = ['ASTER', 'ZEC', 'STRK', 'MET']

    print('\n🚀 Generating Trade Predictions\n')

    for coin in coins:
        print(f'📊 Predicting trades for {coin}...')

        try:
            model = load_model(coin)
            print(f'   ✓ Loaded model')

            X, y = load_test_data(coin)
            print(f'   ✓ Loaded test data ({len(X)} sequences)')

            candles = load_candles(coin)
            print(f'   ✓ Loaded {len(candles)} candles')

            predictions = generate_predictions(model, X, candles)

            output_path = save_predictions(coin, predictions)

            print(f'   ✓ Generated {len(predictions)} predicted trades')
            print(f'   ✓ Saved to {output_path.name}')

            action_counts = {}
            for pred in predictions:
                action = pred['action']
                action_counts[action] = action_counts.get(action, 0) + 1

            print(f'   ✓ Prediction distribution: {action_counts}')

        except Exception as e:
            print(f'   ✗ Error: {str(e)}')
            continue

    print('\n✅ Prediction generation complete!\n')

if __name__ == '__main__':
    main()
