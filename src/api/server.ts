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

    const files = fs.readdirSync(DATA_DIR)
      .filter(file => file.startsWith('snapshots-') && file.endsWith('.jsonl'))
      .sort();

    const allSnapshots: any[] = [];

    files.forEach(file => {
      const filePath = path.join(DATA_DIR, file);
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.trim().split('\n').filter(line => line.length > 0);

      lines.forEach(line => {
        try {
          const snapshot = JSON.parse(line);
          allSnapshots.push(snapshot);
        } catch (err) {
          console.error(`Error parsing line in ${file}:`, err);
        }
      });
    });

    allSnapshots.sort((a, b) => a.timestamp - b.timestamp);

    res.json({
      snapshots: allSnapshots,
      count: allSnapshots.length,
      dateRange: allSnapshots.length > 0 ? {
        start: allSnapshots[0].date,
        end: allSnapshots[allSnapshots.length - 1].date
      } : null
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

    const files = fs.readdirSync(DATA_DIR)
      .filter(file => file.startsWith('snapshots-') && file.endsWith('.jsonl'))
      .sort();

    const allSnapshots: any[] = [];

    files.forEach(file => {
      const filePath = path.join(DATA_DIR, file);
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.trim().split('\n').filter(line => line.length > 0);

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
          console.error(`Error parsing line in ${file}:`, err);
        }
      });
    });

    allSnapshots.sort((a, b) => a.timestamp - b.timestamp);

    res.json({
      snapshots: allSnapshots,
      count: allSnapshots.length,
      dateRange: allSnapshots.length > 0 ? {
        start: allSnapshots[0].date,
        end: allSnapshots[allSnapshots.length - 1].date
      } : null
    });
  } catch (error) {
    console.error('Error reading user snapshots:', error);
    res.status(500).json({ error: 'Failed to read snapshot data' });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`📊 Dashboard server running on ${HOST}:${PORT}`);
  console.log(`📁 Serving snapshots from: ${DATA_DIR}`);
  console.log(`🌐 Access the dashboard at http://YOUR_SERVER_IP:${PORT}`);
});
