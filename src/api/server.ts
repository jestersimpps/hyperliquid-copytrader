import express, { Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;
const HOST = '0.0.0.0';
const DATA_DIR = path.join(__dirname, '../../data');
const FRONTEND_DIR = path.join(__dirname, '../../frontend');

app.use(express.static(FRONTEND_DIR));

app.get('/copy-trading', (req: Request, res: Response) => {
  res.sendFile(path.join(FRONTEND_DIR, 'copy-trading-dashboard.html'));
});

app.get('/api/snapshots', (req: Request, res: Response) => {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      return res.json({ snapshots: [], message: 'No snapshot data available yet' });
    }

    const dateParam = req.query.date as string;
    const targetDate = dateParam || new Date().toISOString().split('T')[0];

    const fileName = `snapshots-${targetDate}.jsonl`;
    const filePath = path.join(DATA_DIR, fileName);

    if (!fs.existsSync(filePath)) {
      return res.json({
        snapshots: [],
        count: 0,
        date: targetDate,
        message: `No snapshot data available for ${targetDate}`
      });
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n').filter(line => line.length > 0);
    const allSnapshots: any[] = [];

    lines.forEach(line => {
      try {
        const snapshot = JSON.parse(line);
        allSnapshots.push(snapshot);
      } catch (err) {
        console.error(`Error parsing line in ${fileName}:`, err);
      }
    });

    allSnapshots.sort((a, b) => a.timestamp - b.timestamp);

    res.json({
      snapshots: allSnapshots,
      count: allSnapshots.length,
      date: targetDate
    });
  } catch (error) {
    console.error('Error reading snapshots:', error);
    res.status(500).json({ error: 'Failed to read snapshot data' });
  }
});

app.get('/api/user-snapshots', (req: Request, res: Response) => {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      return res.json({ snapshots: [], message: 'No snapshot data available yet' });
    }

    const dateParam = req.query.date as string;
    const targetDate = dateParam || new Date().toISOString().split('T')[0];

    const fileName = `snapshots-${targetDate}.jsonl`;
    const filePath = path.join(DATA_DIR, fileName);

    if (!fs.existsSync(filePath)) {
      return res.json({
        snapshots: [],
        count: 0,
        date: targetDate,
        message: `No snapshot data available for ${targetDate}`
      });
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n').filter(line => line.length > 0);
    const allSnapshots: any[] = [];

    lines.forEach(line => {
      try {
        const snapshot = JSON.parse(line);
        if (snapshot.user) {
          allSnapshots.push({
            timestamp: snapshot.timestamp,
            date: snapshot.date,
            wallet: snapshot.user
          });
        }
      } catch (err) {
        console.error(`Error parsing line in ${fileName}:`, err);
      }
    });

    allSnapshots.sort((a, b) => a.timestamp - b.timestamp);

    res.json({
      snapshots: allSnapshots,
      count: allSnapshots.length,
      date: targetDate
    });
  } catch (error) {
    console.error('Error reading user snapshots:', error);
    res.status(500).json({ error: 'Failed to read snapshot data' });
  }
});

app.get('/api/trades', (req: Request, res: Response) => {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      return res.json({ trades: [], message: 'No trade data available yet' });
    }

    const dateParam = req.query.date as string;
    const targetDate = dateParam || new Date().toISOString().split('T')[0];

    const fileName = `trades-${targetDate}.jsonl`;
    const filePath = path.join(DATA_DIR, fileName);

    if (!fs.existsSync(filePath)) {
      return res.json({
        trades: [],
        count: 0,
        date: targetDate,
        message: `No trade data available for ${targetDate}`
      });
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n').filter(line => line.length > 0);
    const allTrades: any[] = [];

    lines.forEach(line => {
      try {
        const trade = JSON.parse(line);
        allTrades.push(trade);
      } catch (err) {
        console.error(`Error parsing line in ${fileName}:`, err);
      }
    });

    allTrades.sort((a, b) => a.timestamp - b.timestamp);

    res.json({
      trades: allTrades,
      count: allTrades.length,
      date: targetDate
    });
  } catch (error) {
    console.error('Error reading trades:', error);
    res.status(500).json({ error: 'Failed to read trade data' });
  }
});

app.get('/api/daily-summary', (req: Request, res: Response) => {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      return res.json({ days: [], message: 'No snapshot data available yet' });
    }

    const daysParam = req.query.days as string;
    const numDays = daysParam ? parseInt(daysParam) : 7;

    const dailySummary: any[] = [];
    const today = new Date();

    for (let i = 0; i < numDays; i++) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];

      const snapshotFile = `snapshots-${dateStr}.jsonl`;
      const snapshotPath = path.join(DATA_DIR, snapshotFile);
      const tradesFile = `trades-${dateStr}.jsonl`;
      const tradesPath = path.join(DATA_DIR, tradesFile);

      let hasData = false;
      let startBalance = 0;
      let endBalance = 0;
      let totalPnl = 0;
      let pnlPercentage = 0;
      let snapshotCount = 0;

      if (fs.existsSync(snapshotPath)) {
        const content = fs.readFileSync(snapshotPath, 'utf-8');
        const lines = content.trim().split('\n').filter(line => line.length > 0);

        if (lines.length > 0) {
          hasData = true;
          snapshotCount = lines.length;

          try {
            const firstSnapshot = JSON.parse(lines[0]);
            const lastSnapshot = JSON.parse(lines[lines.length - 1]);

            if (firstSnapshot.user) {
              startBalance = parseFloat(firstSnapshot.user.accountValue || '0');
              endBalance = parseFloat(lastSnapshot.user.accountValue || '0');
              totalPnl = endBalance - startBalance;
              pnlPercentage = startBalance > 0 ? (totalPnl / startBalance) * 100 : 0;
            }
          } catch (err) {
            console.error(`Error parsing snapshots for ${dateStr}:`, err);
          }
        }
      }

      let tradeCount = 0;
      if (fs.existsSync(tradesPath)) {
        const content = fs.readFileSync(tradesPath, 'utf-8');
        const lines = content.trim().split('\n').filter(line => line.length > 0);
        tradeCount = lines.length;
      }

      dailySummary.push({
        date: dateStr,
        hasData,
        startBalance,
        endBalance,
        totalPnl,
        pnlPercentage,
        snapshotCount,
        tradeCount
      });
    }

    res.json({
      days: dailySummary,
      count: dailySummary.length
    });
  } catch (error) {
    console.error('Error reading daily summary:', error);
    res.status(500).json({ error: 'Failed to read daily summary' });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`📊 Dashboard server running on ${HOST}:${PORT}`);
  console.log(`📁 Serving snapshots from: ${DATA_DIR}`);
  console.log(`🌐 Access the dashboard at http://YOUR_SERVER_IP:${PORT}`);
});
