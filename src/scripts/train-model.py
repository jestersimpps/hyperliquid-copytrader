#!/usr/bin/env python3

import numpy as np
import json
from pathlib import Path
from sklearn.model_selection import train_test_split
from sklearn.utils.class_weight import compute_class_weight
import tensorflow as tf
from tensorflow import keras
from tensorflow.keras import layers

TESTING_DIR = Path(__file__).parent.parent.parent / 'testing'
MODELS_DIR = TESTING_DIR / 'models'
LOOKBACK_WINDOW = 20
FEATURES = 5

def load_training_data(coin: str):
    filepath = TESTING_DIR / f'training-data-{coin.lower()}.npz'

    if not filepath.exists():
        raise FileNotFoundError(f'Training data not found: {filepath}')

    data = np.load(filepath, allow_pickle=True)
    return data['X'], data['y'], data['norm_params_means'], data['norm_params_stds']

def create_model(input_shape, num_classes):
    model = keras.Sequential([
        layers.Input(shape=input_shape),

        layers.LSTM(128, return_sequences=True),
        layers.Dropout(0.3),

        layers.LSTM(64, return_sequences=True),
        layers.Dropout(0.3),

        layers.LSTM(32),
        layers.Dropout(0.3),

        layers.Dense(64, activation='relu'),
        layers.Dropout(0.2),

        layers.Dense(32, activation='relu'),

        layers.Dense(num_classes, activation='softmax')
    ])

    model.compile(
        optimizer=keras.optimizers.Adam(learning_rate=0.001),
        loss='sparse_categorical_crossentropy',
        metrics=['accuracy']
    )

    return model

def main():
    coins = ['ASTER', 'ZEC', 'STRK', 'MET']

    print('\n🚀 Training Neural Network Models\n')

    MODELS_DIR.mkdir(exist_ok=True)

    all_results = {}

    for coin in coins:
        print(f'\n{"="*60}')
        print(f'📊 Training model for {coin}')
        print("="*60)

        try:
            X, y, means, stds = load_training_data(coin)

            print(f'✓ Loaded training data')
            print(f'  Input shape: {X.shape}')
            print(f'  Output shape: {y.shape}')

            unique_classes = np.unique(y)
            num_classes = len(unique_classes)

            print(f'✓ Number of classes: {num_classes}')
            print(f'  Classes: {unique_classes}')

            class_counts = np.bincount(y)
            print(f'  Class distribution: {class_counts}')

            X_train, X_test, y_train, y_test = train_test_split(
                X, y, test_size=0.2, random_state=42, stratify=y
            )

            print(f'✓ Train/test split')
            print(f'  Train samples: {len(X_train)}')
            print(f'  Test samples: {len(X_test)}')

            class_weights_array = compute_class_weight(
                'balanced',
                classes=unique_classes,
                y=y_train
            )
            class_weights = dict(enumerate(class_weights_array))

            print(f'✓ Class weights: {class_weights}')

            model = create_model((LOOKBACK_WINDOW, FEATURES), num_classes)

            print(f'\n📈 Model architecture:')
            model.summary()

            early_stopping = keras.callbacks.EarlyStopping(
                monitor='val_loss',
                patience=10,
                restore_best_weights=True
            )

            reduce_lr = keras.callbacks.ReduceLROnPlateau(
                monitor='val_loss',
                factor=0.5,
                patience=5,
                min_lr=0.00001
            )

            print(f'\n🏋️  Training model...')

            history = model.fit(
                X_train, y_train,
                validation_data=(X_test, y_test),
                epochs=100,
                batch_size=32,
                class_weight=class_weights,
                callbacks=[early_stopping, reduce_lr],
                verbose=1
            )

            train_loss, train_acc = model.evaluate(X_train, y_train, verbose=0)
            test_loss, test_acc = model.evaluate(X_test, y_test, verbose=0)

            print(f'\n✅ Training complete!')
            print(f'  Train accuracy: {train_acc*100:.2f}%')
            print(f'  Test accuracy: {test_acc*100:.2f}%')
            print(f'  Train loss: {train_loss:.4f}')
            print(f'  Test loss: {test_loss:.4f}')

            model_path = MODELS_DIR / f'{coin.lower()}-strategy.h5'
            model.save(model_path)
            print(f'  💾 Model saved to {model_path.name}')

            y_pred = model.predict(X_test, verbose=0)
            y_pred_classes = np.argmax(y_pred, axis=1)

            from sklearn.metrics import classification_report, confusion_matrix

            print(f'\n📊 Classification Report:')
            print(classification_report(y_test, y_pred_classes))

            print(f'\n📊 Confusion Matrix:')
            print(confusion_matrix(y_test, y_pred_classes))

            all_results[coin] = {
                'train_accuracy': float(train_acc),
                'test_accuracy': float(test_acc),
                'train_loss': float(train_loss),
                'test_loss': float(test_loss),
                'num_classes': int(num_classes),
                'train_samples': int(len(X_train)),
                'test_samples': int(len(X_test)),
                'model_path': str(model_path.name)
            }

        except Exception as e:
            print(f'✗ Error training model for {coin}: {str(e)}')
            import traceback
            traceback.print_exc()
            continue

    results_path = TESTING_DIR / 'model-performance.json'
    with open(results_path, 'w') as f:
        json.dump(all_results, f, indent=2)

    print(f'\n{"="*60}')
    print('📊 SUMMARY')
    print("="*60)

    for coin, results in all_results.items():
        print(f'\n{coin}:')
        print(f'  Test Accuracy: {results["test_accuracy"]*100:.2f}%')
        print(f'  Train/Test samples: {results["train_samples"]}/{results["test_samples"]}')

    print(f'\n✅ Results saved to {results_path.name}\n')

if __name__ == '__main__':
    main()
