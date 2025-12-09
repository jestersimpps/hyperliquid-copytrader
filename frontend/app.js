let accounts = [];
let currentAccountId = null;
let filteredSnapshots = [];
let allTrades = [];
let trackedFills = [];
let dailySummaryData = [];
let balanceHistoryData = [];
let trackedBalanceHistoryData = [];
let allBalanceHistory = {};
let selectedDate = new Date().toISOString().split('T')[0];
let chartInstances = {};
let trackedWs = null;
let userWs = null;
let trackedFillsList = [];
let userFillsList = [];
let trackedPingInterval = null;
let userPingInterval = null;
let summaryWsConnections = [];
let summaryLiveTrades = [];
let summaryPingIntervals = [];
let soundEnabled = false;
let fillSound = null;

const SYMBOL_COLORS = [
  '#667eea', '#17bf63', '#e0245e', '#ffad1f', '#1da1f2', '#f91880',
  '#794bc4', '#00ba7c', '#ff6b6b', '#4ecdc4', '#95e1d3', '#f38181'
];

const ACCOUNT_COLORS = ['#00d4ff', '#667eea', '#17bf63', '#ffad1f', '#f91880', '#794bc4', '#e0245e', '#4ecdc4'];

function getSymbolColor(symbol) {
  let hash = 0;
  for (let i = 0; i < symbol.length; i++) {
    hash = symbol.charCodeAt(i) + ((hash << 5) - hash);
  }
  return SYMBOL_COLORS[Math.abs(hash) % SYMBOL_COLORS.length];
}

function getAccountColor(index) {
  return ACCOUNT_COLORS[index % ACCOUNT_COLORS.length];
}

async function init() {
  try {
    const [accountsRes, summaryRes] = await Promise.all([
      fetch('/api/accounts'),
      fetch('/api/summary')
    ]);

    const accountsData = await accountsRes.json();
    const summaryData = await summaryRes.json();

    accounts = accountsData.accounts || [];

    if (accounts.length === 0) {
      accounts = [{ id: 'default', name: 'Default Account' }];
    }

    for (const acc of accounts) {
      const summary = summaryData.accounts?.find(s => s.accountId === acc.id);
      if (summary) {
        acc.balance = summary.balance;
        acc.positions = summary.positions;
        acc.tradingPaused = summary.tradingPaused;
      }
    }

    document.getElementById('loading').style.display = 'none';
    document.getElementById('dashboard').style.display = 'block';

    renderAccountTabs();
    selectAccount('summary');
  } catch (error) {
    showError(`Error loading accounts: ${error.message}`);
  }
}

function renderAccountTabs() {
  const container = document.getElementById('account-tabs');
  container.innerHTML = '';

  const summaryTab = document.createElement('div');
  summaryTab.className = 'account-tab';
  summaryTab.id = 'tab-summary';
  summaryTab.innerHTML = `<div>Summary</div><div class="tab-balance">${accounts.length} accounts</div>`;
  summaryTab.addEventListener('click', () => selectAccount('summary'));
  container.appendChild(summaryTab);

  for (const account of accounts) {
    const tab = document.createElement('div');
    tab.className = 'account-tab';
    tab.id = `tab-${account.id}`;
    const balanceStr = account.balance ? `$${account.balance.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : '-';
    tab.innerHTML = `<div>${account.name}</div><div class="tab-balance">${balanceStr}</div>`;
    tab.addEventListener('click', () => selectAccount(account.id));
    container.appendChild(tab);
  }
}

async function selectAccount(accountId) {
  document.querySelectorAll('.account-tab').forEach(tab => tab.classList.remove('active'));
  document.getElementById(accountId === 'summary' ? 'tab-summary' : `tab-${accountId}`).classList.add('active');

  currentAccountId = accountId;
  cleanupFillsWebSockets();
  cleanupSummaryWebSockets();

  if (accountId === 'summary') {
    document.getElementById('summary-view').style.display = 'block';
    document.getElementById('account-view').style.display = 'none';
    await loadSummaryView();
    initSoundToggle();
    subscribeToSummaryFills();
  } else {
    document.getElementById('summary-view').style.display = 'none';
    document.getElementById('account-view').style.display = 'block';
    renderFillsSection(accountId);
    await fetchSnapshots(selectedDate);
  }
}

function renderFillsSection(accountId) {
  const container = document.getElementById('fills-section');
  const account = accounts.find(a => a.id === accountId);

  if (!account || !account.trackedWallet || !account.userWallet) {
    container.innerHTML = '';
    return;
  }

  trackedFillsList = [];
  userFillsList = [];

  container.innerHTML = `
    <div class="fills-container">
      <div class="fills-header">
        <span>Tracked Fills</span>
        <span class="ws-status disconnected" id="tracked-ws-status">Connecting...</span>
        <a class="wallet-link" href="https://hypurrscan.io/address/${account.trackedWallet}" target="_blank">${account.trackedWallet.slice(0, 6)}...${account.trackedWallet.slice(-4)}</a>
      </div>
      <div class="fills-list" id="tracked-fills-list">
        <div class="no-fills">Connecting...</div>
      </div>
    </div>
    <div class="fills-container">
      <div class="fills-header">
        <span>User Fills</span>
        <span class="ws-status disconnected" id="user-ws-status">Connecting...</span>
        <a class="wallet-link" href="https://hypurrscan.io/address/${account.userWallet}" target="_blank">${account.userWallet.slice(0, 6)}...${account.userWallet.slice(-4)}</a>
      </div>
      <div class="fills-list" id="user-fills-list">
        <div class="no-fills">Connecting...</div>
      </div>
    </div>
  `;

  subscribeToFills(account.trackedWallet, 'tracked');
  subscribeToFills(account.userWallet, 'user');
}

function subscribeToFills(wallet, type) {
  const statusId = type === 'tracked' ? 'tracked-ws-status' : 'user-ws-status';

  if (type === 'tracked') {
    if (trackedPingInterval) clearInterval(trackedPingInterval);
    trackedPingInterval = null;
    if (trackedWs) {
      trackedWs.onclose = null;
      trackedWs.close();
    }
    trackedWs = null;
  } else {
    if (userPingInterval) clearInterval(userPingInterval);
    userPingInterval = null;
    if (userWs) {
      userWs.onclose = null;
      userWs.close();
    }
    userWs = null;
  }

  const ws = new WebSocket('wss://api.hyperliquid.xyz/ws');

  ws.onopen = () => {
    ws.send(JSON.stringify({
      method: 'subscribe',
      subscription: { type: 'userFills', user: wallet }
    }));
    const statusEl = document.getElementById(statusId);
    if (statusEl) {
      statusEl.textContent = 'Connected';
      statusEl.className = 'ws-status connected';
    }

    const pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ method: 'ping' }));
      }
    }, 30000);

    if (type === 'tracked') {
      trackedPingInterval = pingInterval;
    } else {
      userPingInterval = pingInterval;
    }
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.channel === 'pong') return;
      if (msg.channel === 'userFills' && msg.data) {
        const isSnapshot = msg.data.isSnapshot;

        if (isSnapshot && Array.isArray(msg.data.fills)) {
          const sortedFills = msg.data.fills.sort((a, b) => new Date(b.time) - new Date(a.time)).slice(0, 50);
          if (type === 'tracked') {
            trackedFillsList = sortedFills;
          } else {
            userFillsList = sortedFills;
          }
        } else if (!isSnapshot) {
          const newFills = Array.isArray(msg.data) ? msg.data : (msg.data.fills || []);
          for (const fill of newFills) {
            if (type === 'tracked') {
              trackedFillsList.unshift(fill);
              if (trackedFillsList.length > 50) trackedFillsList.pop();
            } else {
              userFillsList.unshift(fill);
              if (userFillsList.length > 50) userFillsList.pop();
            }
          }
        }
        renderFillsList(type, true);
      }
    } catch (e) {
      console.error('Failed to parse fills message:', e);
    }
  };

  ws.onerror = (error) => {
    console.error(`WebSocket error (${type}):`, error);
    const statusEl = document.getElementById(statusId);
    if (statusEl) {
      statusEl.textContent = 'Error';
      statusEl.className = 'ws-status disconnected';
    }
  };

  ws.onclose = () => {
    if (type === 'tracked' && trackedPingInterval) {
      clearInterval(trackedPingInterval);
      trackedPingInterval = null;
    }
    if (type === 'user' && userPingInterval) {
      clearInterval(userPingInterval);
      userPingInterval = null;
    }

    const currentWs = type === 'tracked' ? trackedWs : userWs;
    if (currentWs !== ws) return;

    const statusEl = document.getElementById(statusId);
    if (statusEl) {
      statusEl.textContent = 'Reconnecting...';
      statusEl.className = 'ws-status disconnected';
    }
    setTimeout(() => {
      const stillCurrentWs = type === 'tracked' ? trackedWs : userWs;
      if (stillCurrentWs !== ws) return;

      if (currentAccountId && currentAccountId !== 'summary') {
        const account = accounts.find(a => a.id === currentAccountId);
        if (account) {
          const reconnectWallet = type === 'tracked' ? account.trackedWallet : account.userWallet;
          if (reconnectWallet) {
            subscribeToFills(reconnectWallet, type);
          }
        }
      }
    }, 3000);
  };

  if (type === 'tracked') {
    trackedWs = ws;
  } else {
    userWs = ws;
  }
}

function renderFillsList(type, isNew = false) {
  const listId = type === 'tracked' ? 'tracked-fills-list' : 'user-fills-list';
  const fills = type === 'tracked' ? trackedFillsList : userFillsList;
  const listEl = document.getElementById(listId);

  if (!listEl) return;

  if (fills.length === 0) {
    listEl.innerHTML = '<div class="no-fills">No recent fills</div>';
    return;
  }

  listEl.innerHTML = fills.map((fill, index) => {
    const isBuy = fill.side === 'B';
    const sideClass = isBuy ? 'buy' : 'sell';
    const sideText = isBuy ? 'BUY' : 'SELL';
    const time = new Date(fill.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const priceNum = parseFloat(fill.px);
    const sizeNum = parseFloat(fill.sz);
    const price = priceNum.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 });
    const size = sizeNum.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 });
    const usdValue = priceNum * sizeNum;
    const usdText = usdValue >= 1000 ? `$${(usdValue / 1000).toFixed(1)}k` : `$${usdValue.toFixed(0)}`;
    const pnl = fill.closedPnl ? parseFloat(fill.closedPnl) : 0;
    const pnlClass = pnl >= 0 ? 'positive' : 'negative';
    const pnlSign = pnl >= 0 ? '+' : '';
    const pnlText = pnl !== 0 ? `${pnlSign}$${Math.abs(pnl).toFixed(2)}` : '-';
    const newClass = isNew && index === 0 ? 'new' : '';

    return `
      <div class="fill-item ${newClass}">
        <span class="fill-time">${time}</span>
        <span class="fill-coin">${fill.coin}</span>
        <span class="fill-side ${sideClass}">${sideText}</span>
        <span class="fill-size">${size}</span>
        <span class="fill-usd">${usdText}</span>
        <span class="fill-price">$${price}</span>
        <span class="fill-pnl ${pnlClass}">${pnlText}</span>
      </div>
    `;
  }).join('');
}

function cleanupFillsWebSockets() {
  if (trackedPingInterval) {
    clearInterval(trackedPingInterval);
    trackedPingInterval = null;
  }
  if (userPingInterval) {
    clearInterval(userPingInterval);
    userPingInterval = null;
  }
  if (trackedWs) {
    trackedWs.onclose = null;
    trackedWs.close();
    trackedWs = null;
  }
  if (userWs) {
    userWs.onclose = null;
    userWs.close();
    userWs = null;
  }
  trackedFillsList = [];
  userFillsList = [];
}

function cleanupSummaryWebSockets() {
  for (const interval of summaryPingIntervals) {
    clearInterval(interval);
  }
  summaryPingIntervals = [];
  for (const ws of summaryWsConnections) {
    ws.onclose = null;
    ws.close();
  }
  summaryWsConnections = [];
}

function initFillSound() {
  if (!fillSound) {
    fillSound = new Audio('mixkit-modern-technology-select-3124.wav');
    fillSound.volume = 0.3;
  }
}

function playFillSound() {
  if (soundEnabled && fillSound) {
    fillSound.currentTime = 0;
    fillSound.play().catch(() => {});
  }
}

function toggleSound() {
  soundEnabled = !soundEnabled;
  const btn = document.getElementById('sound-toggle');
  const onIcon = btn.querySelector('.sound-on');
  const offIcon = btn.querySelector('.sound-off');

  if (soundEnabled) {
    btn.classList.add('active');
    onIcon.style.display = 'block';
    offIcon.style.display = 'none';
    initFillSound();
  } else {
    btn.classList.remove('active');
    onIcon.style.display = 'none';
    offIcon.style.display = 'block';
  }

  localStorage.setItem('fillSoundEnabled', soundEnabled);
}

function initSoundToggle() {
  const saved = localStorage.getItem('fillSoundEnabled');
  if (saved === 'true') {
    soundEnabled = true;
    initFillSound();
    const btn = document.getElementById('sound-toggle');
    if (btn) {
      btn.classList.add('active');
      btn.querySelector('.sound-on').style.display = 'block';
      btn.querySelector('.sound-off').style.display = 'none';
    }
  }

  const btn = document.getElementById('sound-toggle');
  if (btn) {
    btn.addEventListener('click', toggleSound);
  }

  const reconnectBtn = document.getElementById('reconnect-ws');
  if (reconnectBtn) {
    reconnectBtn.addEventListener('click', () => {
      subscribeToSummaryFills();
    });
  }
}

function updateSummaryWsStatus() {
  const indicator = document.getElementById('summary-ws-status');
  if (!indicator) return;

  const connectedCount = summaryWsConnections.filter(ws => ws.readyState === WebSocket.OPEN).length;
  const totalAccounts = accounts.filter(a => a.userWallet).length;

  if (connectedCount === totalAccounts && totalAccounts > 0) {
    indicator.className = 'ws-indicator connected';
    indicator.title = `Connected (${connectedCount}/${totalAccounts})`;
  } else if (connectedCount > 0) {
    indicator.className = 'ws-indicator connected';
    indicator.title = `Partially connected (${connectedCount}/${totalAccounts})`;
  } else {
    indicator.className = 'ws-indicator disconnected';
    indicator.title = 'Disconnected';
  }
}

function subscribeToSummaryFills() {
  cleanupSummaryWebSockets();
  summaryLiveTrades = [];

  const listEl = document.getElementById('summary-live-trades');
  if (listEl) {
    listEl.innerHTML = '<div class="no-trades">Connecting...</div>';
  }

  updateSummaryWsStatus();

  for (const account of accounts) {
    if (!account.userWallet) continue;

    const ws = new WebSocket('wss://api.hyperliquid.xyz/ws');

    ws.onopen = () => {
      ws.send(JSON.stringify({
        method: 'subscribe',
        subscription: { type: 'userFills', user: account.userWallet }
      }));

      updateSummaryWsStatus();

      const pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ method: 'ping' }));
        }
      }, 30000);
      summaryPingIntervals.push(pingInterval);
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.channel === 'pong') return;

        if (msg.channel === 'userFills' && msg.data) {
          const isSnapshot = msg.data.isSnapshot;

          if (isSnapshot && Array.isArray(msg.data.fills)) {
            const recentFills = msg.data.fills
              .sort((a, b) => b.time - a.time)
              .slice(0, 10)
              .map(f => ({ ...f, accountId: account.id, accountName: account.name }));
            summaryLiveTrades = [...summaryLiveTrades, ...recentFills]
              .sort((a, b) => b.time - a.time)
              .slice(0, 20);
            renderSummaryLiveTrades(false);
          } else if (!isSnapshot) {
            const newFills = Array.isArray(msg.data) ? msg.data : (msg.data.fills || []);
            for (const fill of newFills) {
              summaryLiveTrades.unshift({ ...fill, accountId: account.id, accountName: account.name });
              if (summaryLiveTrades.length > 20) summaryLiveTrades.pop();
              playFillSound();
            }
            renderSummaryLiveTrades(true);
          }
        }
      } catch (e) {
        console.error('Failed to parse summary fills:', e);
      }
    };

    ws.onclose = () => {
      updateSummaryWsStatus();
      if (currentAccountId === 'summary') {
        setTimeout(() => {
          if (currentAccountId === 'summary') {
            const idx = summaryWsConnections.indexOf(ws);
            if (idx > -1) {
              summaryWsConnections.splice(idx, 1);
              subscribeToAccountFills(account);
            }
          }
        }, 3000);
      }
    };

    summaryWsConnections.push(ws);
  }
}

function subscribeToAccountFills(account) {
  if (!account.userWallet || currentAccountId !== 'summary') return;

  const ws = new WebSocket('wss://api.hyperliquid.xyz/ws');

  ws.onopen = () => {
    ws.send(JSON.stringify({
      method: 'subscribe',
      subscription: { type: 'userFills', user: account.userWallet }
    }));

    const pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ method: 'ping' }));
      }
    }, 30000);
    summaryPingIntervals.push(pingInterval);
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.channel === 'pong') return;

      if (msg.channel === 'userFills' && msg.data && !msg.data.isSnapshot) {
        const newFills = Array.isArray(msg.data) ? msg.data : (msg.data.fills || []);
        for (const fill of newFills) {
          summaryLiveTrades.unshift({ ...fill, accountId: account.id, accountName: account.name });
          if (summaryLiveTrades.length > 20) summaryLiveTrades.pop();
          playFillSound();
        }
        renderSummaryLiveTrades(true);
      }
    } catch (e) {}
  };

  ws.onclose = () => {
    if (currentAccountId === 'summary') {
      setTimeout(() => {
        if (currentAccountId === 'summary') {
          subscribeToAccountFills(account);
        }
      }, 3000);
    }
  };

  summaryWsConnections.push(ws);
}

function renderSummaryLiveTrades(isNew = false) {
  const listEl = document.getElementById('summary-live-trades');
  if (!listEl) return;

  if (summaryLiveTrades.length === 0) {
    listEl.innerHTML = '<div class="no-trades">No recent trades</div>';
    return;
  }

  listEl.innerHTML = summaryLiveTrades.map((trade, idx) => {
    const isBuy = trade.side === 'B';
    const hasClosedPnl = trade.closedPnl && parseFloat(trade.closedPnl) !== 0;
    const pnl = hasClosedPnl ? parseFloat(trade.closedPnl) : 0;

    let typeClass, typeText;
    if (hasClosedPnl) {
      typeClass = 'close';
      typeText = 'CLOSE';
    } else if (isBuy) {
      typeClass = 'open-long';
      typeText = 'LONG';
    } else {
      typeClass = 'open-short';
      typeText = 'SHORT';
    }

    const size = parseFloat(trade.sz || 0);
    const price = parseFloat(trade.px || 0);
    const notional = size * price;
    const sizeStr = notional >= 1000 ? `$${(notional / 1000).toFixed(1)}k` : `$${notional.toFixed(0)}`;

    const pnlClass = pnl > 0 ? 'positive' : pnl < 0 ? 'negative' : 'neutral';
    const pnlStr = hasClosedPnl ? (pnl >= 0 ? '+' : '') + '$' + Math.abs(pnl).toFixed(0) : '-';

    const time = new Date(trade.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    const newClass = isNew && idx === 0 ? 'new' : '';

    return `
      <div class="live-trade-row ${newClass}">
        <span class="trade-time">${time}</span>
        <span class="trade-account">${trade.accountName}</span>
        <span class="trade-symbol">${trade.coin}</span>
        <span class="trade-type ${typeClass}">${typeText}</span>
        <span class="trade-size">${sizeStr}</span>
        <span class="trade-pnl ${pnlClass}">${pnlStr}</span>
      </div>
    `;
  }).join('');
}

function renderActivityHeatmap(trades) {
  const container = document.getElementById('activity-heatmap');
  const timeAxis = document.getElementById('heatmap-time-axis');
  if (!container) return;

  container.innerHTML = '';
  timeAxis.innerHTML = '';

  const hourlyBuckets = new Array(24).fill(0);
  const hourlyPnl = new Array(24).fill(0);
  const hourLabels = new Array(24).fill(0);
  const now = new Date();
  const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const currentHour = now.getHours();

  for (let i = 0; i < 24; i++) {
    hourLabels[i] = (currentHour - 23 + i + 24) % 24;
  }

  trades.forEach(trade => {
    const tradeTime = new Date(trade.timestamp);
    if (tradeTime >= twentyFourHoursAgo && tradeTime <= now) {
      const tradeHour = tradeTime.getHours();
      const bucketIndex = hourLabels.indexOf(tradeHour);
      if (bucketIndex !== -1) {
        hourlyBuckets[bucketIndex]++;
        hourlyPnl[bucketIndex] += trade.realizedPnl || 0;
      }
    }
  });

  const maxTrades = Math.max(...hourlyBuckets, 1);

  hourlyBuckets.forEach((count, idx) => {
    const cell = document.createElement('div');
    cell.className = 'heatmap-cell';

    const intensity = count / maxTrades;
    let level = 0;
    if (intensity > 0.8) level = 5;
    else if (intensity > 0.6) level = 4;
    else if (intensity > 0.4) level = 3;
    else if (intensity > 0.2) level = 2;
    else if (intensity > 0) level = 1;

    cell.classList.add(`level-${level}`);
    cell.dataset.hour = hourLabels[idx];
    cell.dataset.count = count;
    cell.dataset.pnl = hourlyPnl[idx].toFixed(2);

    cell.addEventListener('mouseenter', showHeatmapTooltip);
    cell.addEventListener('mouseleave', hideHeatmapTooltip);

    container.appendChild(cell);
  });

  const axisHours = [hourLabels[0], hourLabels[6], hourLabels[12], hourLabels[18], hourLabels[23]];
  axisHours.forEach(h => {
    const label = document.createElement('span');
    label.textContent = `${h}:00`;
    timeAxis.appendChild(label);
  });
}

function showHeatmapTooltip(e) {
  const cell = e.target;
  let tooltip = document.getElementById('heatmap-tooltip');
  if (!tooltip) {
    tooltip = document.createElement('div');
    tooltip.id = 'heatmap-tooltip';
    tooltip.className = 'heatmap-tooltip';
    document.body.appendChild(tooltip);
  }

  const pnl = parseFloat(cell.dataset.pnl);
  const pnlClass = pnl >= 0 ? 'positive' : 'negative';
  const pnlSign = pnl >= 0 ? '+' : '';

  tooltip.innerHTML = `
    <div><strong>${cell.dataset.hour}:00 - ${parseInt(cell.dataset.hour)+1}:00</strong></div>
    <div>Trades: ${cell.dataset.count}</div>
    <div class="${pnlClass}">PnL: ${pnlSign}$${Math.abs(pnl).toFixed(2)}</div>
  `;
  tooltip.style.display = 'block';

  const rect = cell.getBoundingClientRect();
  tooltip.style.left = rect.left + rect.width/2 - tooltip.offsetWidth/2 + 'px';
  tooltip.style.top = rect.top - tooltip.offsetHeight - 8 + 'px';
}

function hideHeatmapTooltip() {
  const tooltip = document.getElementById('heatmap-tooltip');
  if (tooltip) tooltip.style.display = 'none';
}

function calculateEnhancedMetrics(summaryData, trades, balanceHistory) {
  const totalBalance = summaryData.total?.balance || 0;
  const allPositions = summaryData.accounts?.flatMap(a => a.positions || []) || [];

  const totalUnrealizedPnl = allPositions.reduce((sum, p) => sum + (p.unrealizedPnl || 0), 0);
  const todayRealizedPnl = trades.reduce((sum, t) => sum + (t.realizedPnl || 0), 0);

  const totalNotional = allPositions.reduce((sum, p) => sum + Math.abs(p.notionalValue || 0), 0);
  const avgLeverageEst = allPositions.length > 0
    ? allPositions.reduce((sum, p) => sum + (p.leverage || 1), 0) / allPositions.length
    : 1;
  const totalMargin = allPositions.reduce((sum, p) => sum + (p.marginUsed || Math.abs(p.notionalValue || 0) / (p.leverage || 1)), 0);
  const marginUsagePct = totalBalance > 0 ? (totalMargin / totalBalance) * 100 : 0;

  let largestPosition = { coin: '-', pct: 0 };
  allPositions.forEach(p => {
    const pct = totalBalance > 0 ? (Math.abs(p.notionalValue || 0) / totalBalance) * 100 : 0;
    if (pct > largestPosition.pct) largestPosition = { coin: p.coin, pct };
  });

  const balances = balanceHistory.map(h => h.balance || h.accountValue || 0).filter(b => b > 0);
  const peak = balances.length > 0 ? Math.max(...balances, totalBalance) : totalBalance;
  const drawdownPct = peak > 0 && peak > totalBalance ? ((peak - totalBalance) / peak) * 100 : 0;

  const tradesWithPnl = trades.filter(t => t.realizedPnl !== undefined);
  const winningTrades = tradesWithPnl.filter(t => t.realizedPnl > 0);
  const winRate = tradesWithPnl.length > 0 ? (winningTrades.length / tradesWithPnl.length) * 100 : 0;

  const avgTradeSize = trades.length > 0
    ? trades.reduce((sum, t) => sum + Math.abs((t.size || 0) * (t.price || 0)), 0) / trades.length
    : 0;

  const pnlByCoin = {};
  tradesWithPnl.forEach(t => {
    if (!pnlByCoin[t.coin]) pnlByCoin[t.coin] = 0;
    pnlByCoin[t.coin] += t.realizedPnl;
  });
  const sortedCoins = Object.entries(pnlByCoin).sort((a, b) => b[1] - a[1]);

  const avgLeverage = allPositions.length > 0
    ? allPositions.reduce((sum, p) => sum + (p.leverage || 0), 0) / allPositions.length
    : 0;

  const activeCoins = [...new Set(allPositions.map(p => p.coin))].length;

  return {
    totalUnrealizedPnl,
    todayRealizedPnl,
    marginUsagePct,
    largestPosition,
    drawdownPct,
    winRate,
    winningCount: winningTrades.length,
    totalTradesWithPnl: tradesWithPnl.length,
    avgTradeSize,
    bestCoin: sortedCoins[0] || ['-', 0],
    worstCoin: sortedCoins[sortedCoins.length - 1] || ['-', 0],
    avgLeverage,
    activeCoins,
    totalTradesToday: trades.length
  };
}

function updateEnhancedMetricsUI(metrics, balanceChange) {
  const balanceChangeEl = document.getElementById('total-balance-change');
  if (balanceChangeEl) {
    balanceChangeEl.textContent = `${balanceChange >= 0 ? '+' : ''}${balanceChange.toFixed(2)}%`;
    balanceChangeEl.className = `hero-metric-change ${balanceChange >= 0 ? 'positive' : 'negative'}`;
  }

  const avgLeverageEl = document.getElementById('avg-leverage');
  if (avgLeverageEl) {
    avgLeverageEl.textContent = `${metrics.avgLeverage.toFixed(1)}x`;
  }

  const tradesTodayEl = document.getElementById('total-trades-today');
  if (tradesTodayEl) {
    tradesTodayEl.textContent = metrics.totalTradesToday;
  }

  const activeCoinsEl = document.getElementById('active-coins');
  if (activeCoinsEl) {
    activeCoinsEl.textContent = metrics.activeCoins;
  }
}

async function loadSummaryView() {
  try {
    const [summaryRes, historyRes, tradesRes] = await Promise.all([
      fetch('/api/summary'),
      fetch('/api/balance-history/all?days=10'),
      fetch('/api/trades?account=all&days=2')
    ]);

    const summaryData = await summaryRes.json();
    const historyData = await historyRes.json();
    const tradesData = await tradesRes.json();

    allBalanceHistory = historyData.accounts || {};
    const allTrades = tradesData.trades || [];

    const totalBalance = summaryData.total?.balance || 0;
    const totalUnrealizedPnl = summaryData.total?.unrealizedPnl || 0;
    const totalRealizedBalance = totalBalance - totalUnrealizedPnl;
    const totalPositions = summaryData.total?.positions || 0;
    const accountCount = summaryData.total?.accountCount || 0;
    const tradesLast10Min = summaryData.total?.tradesLast10Min || 0;
    const tpm = (tradesLast10Min / 10).toFixed(1);

    document.getElementById('total-balance').textContent =
      `$${totalRealizedBalance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    document.getElementById('total-balance-with-pnl').textContent =
      `$${totalBalance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    document.getElementById('total-tpm').textContent = tpm;

    const allHistoryPoints = Object.values(allBalanceHistory).flat();
    let balanceChange = 0;
    if (allHistoryPoints.length > 0) {
      const sortedHistory = allHistoryPoints.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
      const today = new Date().toISOString().split('T')[0];
      const todayHistory = sortedHistory.filter(h => {
        const ts = typeof h.timestamp === 'string' ? h.timestamp : new Date(h.timestamp).toISOString();
        return ts.startsWith(today);
      });
      const startOfDayBalance = todayHistory.length > 0
        ? (todayHistory[0]?.balance || todayHistory[0]?.accountValue || totalRealizedBalance)
        : (sortedHistory[sortedHistory.length - 1]?.balance || sortedHistory[sortedHistory.length - 1]?.accountValue || totalRealizedBalance);
      balanceChange = startOfDayBalance > 0 ? ((totalRealizedBalance - startOfDayBalance) / startOfDayBalance) * 100 : 0;
    }

    const metrics = calculateEnhancedMetrics(summaryData, allTrades, allHistoryPoints);
    updateEnhancedMetricsUI(metrics, balanceChange);
    renderActivityHeatmap(allTrades);

    renderAccountsSummaryGrid(summaryData.accounts || []);
    renderCombinedBalanceChart();
  } catch (error) {
    console.error('Failed to load summary:', error);
  }
}

function renderAccountsSummaryGrid(accountSummaries) {
  Object.keys(chartInstances).forEach(key => {
    if (key.startsWith('history-mini-') || key.startsWith('allocation-pie-')) {
      chartInstances[key].destroy();
      delete chartInstances[key];
    }
  });

  const container = document.getElementById('accounts-summary-grid');
  container.innerHTML = '';

  for (const summary of accountSummaries) {
    const card = document.createElement('div');
    card.className = 'summary-card';
    card.addEventListener('click', () => selectAccount(summary.accountId));

    const statusClass = summary.tradingPaused ? 'status-paused' : 'status-active';
    const statusText = summary.tradingPaused ? 'Paused' : 'Active';
    const pnl = summary.unrealizedPnl || 0;
    const pnlClass = pnl >= 0 ? 'positive' : 'negative';
    const pnlSign = pnl >= 0 ? '+' : '';
    const positions = summary.positions || [];
    const accountTpm = ((summary.tradesLast10Min || 0) / 10).toFixed(1);
    const trackedPositions = summary.trackedPositions || [];
    const trackedByCoins = {};
    for (const pos of trackedPositions) trackedByCoins[pos.coin] = pos;
    const realizedBalance = summary.balance - pnl;

    const maxNotional = Math.max(...positions.map(p => Math.abs(p.notionalValue || 0)), 1);

    let positionsHtml = '';
    if (positions.length > 0) {
      positionsHtml = '<div class="summary-card-positions-list">';
      for (const pos of positions) {
        const posPnl = pos.unrealizedPnl || 0;
        const posPnlClass = posPnl >= 0 ? 'positive' : 'negative';
        const posPnlSign = posPnl >= 0 ? '+' : '';
        const sideClass = pos.side === 'long' ? 'long' : 'short';
        const notional = Math.abs(pos.notionalValue || 0);
        const barPct = (notional / maxNotional) * 50;
        const barColor = getSymbolColor(pos.coin);
        const barStyle = pos.side === 'long'
          ? `left: 50%; width: ${barPct}%;`
          : `right: 50%; width: ${barPct}%;`;
        const sideLabel = pos.side === 'long' ? 'LONG' : 'SHORT';
        const labelPosition = pos.side === 'long' ? 'left: 51%;' : 'right: 51%;';
        positionsHtml += `
          <div class="summary-position-row">
            <div class="summary-position-coin">${pos.coin}</div>
            <div class="summary-position-bar-container">
              <div class="summary-position-bar" style="background: ${barColor}; ${barStyle}"></div>
              <span class="summary-position-bar-label" style="${labelPosition}">${sideLabel}</span>
            </div>
            <div class="summary-position-details">
              <div class="summary-position-size">$${notional.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</div>
              <div class="summary-position-pnl ${posPnlClass}">${posPnlSign}$${Math.abs(posPnl).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
            </div>
          </div>
        `;
      }
      positionsHtml += '</div>';
    }

    const pieChartId = `allocation-pie-${summary.accountId}`;
    const historyChartId = `history-mini-${summary.accountId}`;

    let contentHtml = '';
    if (positions.length > 0) {
      contentHtml = `
        <div class="summary-card-content">
          <div class="allocation-pie-chart"><canvas id="${pieChartId}"></canvas></div>
          ${positionsHtml}
        </div>
      `;
    }

    card.innerHTML = `
      <div class="summary-card-top">
        <div class="summary-card-mini-chart"><canvas id="${historyChartId}"></canvas></div>
        <div class="summary-card-info">
          <div class="summary-card-header">
            <a class="summary-card-name" href="https://hyperformance.xyz/trade?${summary.trackedWallet}" target="_blank" onclick="event.stopPropagation()">${summary.name}</a>
            <span class="summary-card-status ${statusClass}">${statusText}</span>
          </div>
          <div class="summary-card-balance">$${realizedBalance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
          <div class="summary-card-pnl ${pnlClass}">Unrealized: ${pnlSign}$${Math.abs(pnl).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
          <div class="summary-card-positions">${positions.length} positions · ${accountTpm} tpm</div>
        </div>
      </div>
      ${contentHtml}
    `;

    container.appendChild(card);

    if (positions.length > 0) {
      renderAllocationPieChart(pieChartId, positions, summary.balance);
    }
    renderAccountMiniChart(historyChartId, summary.accountId);
  }
}

function renderAccountMiniChart(chartId, accountId) {
  const ctx = document.getElementById(chartId);
  if (!ctx) return;

  if (chartInstances[chartId]) {
    chartInstances[chartId].destroy();
  }

  const history = allBalanceHistory[accountId] || [];
  if (history.length === 0) return;

  const balances = history.map(h => h.balance);
  const firstBalance = balances[0];
  const lastBalance = balances[balances.length - 1];
  const isPositive = lastBalance >= firstBalance;
  const color = isPositive ? '#17bf63' : '#e0245e';

  chartInstances[chartId] = new Chart(ctx.getContext('2d'), {
    type: 'line',
    data: {
      labels: history.map(h => new Date(h.timestamp)),
      datasets: [{
        data: balances,
        borderColor: color,
        backgroundColor: color + '20',
        borderWidth: 1.5,
        tension: 0.3,
        pointRadius: 0,
        fill: true
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { bottom: 0, top: 0, left: 0, right: 0 } },
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: {
        x: { display: false },
        y: { display: false, grace: 0 }
      }
    }
  });
}

function renderAllocationPieChart(chartId, positions, accountBalance) {
  const ctx = document.getElementById(chartId);
  if (!ctx) return;

  if (chartInstances[chartId]) {
    chartInstances[chartId].destroy();
  }

  const positionData = positions.map(pos => ({
    coin: pos.coin,
    pct: (Math.abs(pos.notionalValue || 0) / accountBalance) * 100
  }));

  const totalPositionPct = positionData.reduce((sum, p) => sum + p.pct, 0);
  const cashPct = Math.max(0, 100 - totalPositionPct);

  const labels = [...positionData.map(p => p.coin), 'Cash'];
  const data = [...positionData.map(p => p.pct), cashPct];
  const colors = [...positionData.map(p => getSymbolColor(p.coin)), '#38444d'];

  chartInstances[chartId] = new Chart(ctx.getContext('2d'), {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data,
        backgroundColor: colors,
        borderColor: '#1a1a2e',
        borderWidth: 2
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#192734',
          titleColor: '#e1e8ed',
          bodyColor: '#8899a6',
          callbacks: {
            label: ctx => `${ctx.label}: ${ctx.parsed.toFixed(1)}%`
          }
        }
      }
    }
  });
}

function renderCombinedBalanceChart() {
  if (chartInstances['combined-balance-chart']) chartInstances['combined-balance-chart'].destroy();

  const accountIds = Object.keys(allBalanceHistory);
  const accountCount = accountIds.length;
  if (accountCount === 0) return;

  const bucketInterval = 5 * 60 * 1000;
  const bucketMap = new Map();

  for (const [accountId, history] of Object.entries(allBalanceHistory)) {
    for (const h of history) {
      const bucketKey = Math.floor(h.timestamp / bucketInterval) * bucketInterval;
      if (!bucketMap.has(bucketKey)) {
        bucketMap.set(bucketKey, { timestamp: bucketKey, balances: {}, lastBalances: {} });
      }
      bucketMap.get(bucketKey).balances[accountId] = h.balance || 0;
    }
  }

  const sortedBuckets = Array.from(bucketMap.values()).sort((a, b) => a.timestamp - b.timestamp);

  const lastKnownBalances = {};
  const aggregatedData = [];

  for (const bucket of sortedBuckets) {
    for (const accId of accountIds) {
      if (bucket.balances[accId] !== undefined) {
        lastKnownBalances[accId] = bucket.balances[accId];
      }
    }

    if (Object.keys(lastKnownBalances).length > 0) {
      const total = Object.values(lastKnownBalances).reduce((sum, b) => sum + b, 0);
      aggregatedData.push({ x: new Date(bucket.timestamp), y: total });
    }
  }

  if (aggregatedData.length === 0) return;

  const datasets = [{
    label: 'Total Balance',
    data: aggregatedData,
    borderColor: '#00d4ff',
    backgroundColor: 'rgba(0, 212, 255, 0.15)',
    borderWidth: 2,
    tension: 0.1,
    pointRadius: 0,
    fill: true
  }];

  chartInstances['combined-balance-chart'] = new Chart(document.getElementById('combined-balance-chart').getContext('2d'), {
    type: 'line',
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#192734',
          titleColor: '#e1e8ed',
          bodyColor: '#8899a6',
          callbacks: {
            label: ctx => `Total: $${ctx.parsed.y.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
          }
        }
      },
      scales: {
        x: {
          type: 'time',
          time: { unit: 'day', displayFormats: { day: 'MMM d' } },
          ticks: { color: '#8899a6' },
          grid: { color: '#38444d' }
        },
        y: {
          ticks: { color: '#8899a6', callback: v => '$' + v.toLocaleString() },
          grid: { color: '#38444d' }
        }
      }
    }
  });
}

async function fetchSnapshots(date = null) {
  try {
    const targetDate = date || selectedDate;
    const accountParam = currentAccountId && currentAccountId !== 'summary' ? `&account=${currentAccountId}` : '';

    const [snapshotsRes, tradesRes, trackedFillsRes, summaryRes, balanceHistoryRes] = await Promise.all([
      fetch(`/api/snapshots?date=${targetDate}${accountParam}`),
      fetch(`/api/trades?date=${targetDate}${accountParam}`),
      fetch(`/api/tracked-fills?date=${targetDate}${accountParam}`),
      fetch(`/api/daily-summary?days=10${accountParam}`),
      fetch(`/api/balance-history?days=10${accountParam}`)
    ]);

    const snapshotsData = await snapshotsRes.json();
    const tradesData = await tradesRes.json();
    const trackedFillsData = await trackedFillsRes.json();
    const summaryData = await summaryRes.json();
    const balanceHistoryDataRes = await balanceHistoryRes.json();

    filteredSnapshots = snapshotsData.snapshots || [];
    allTrades = tradesData.trades || [];
    trackedFills = trackedFillsData.fills || [];
    dailySummaryData = summaryData.days || [];
    balanceHistoryData = balanceHistoryDataRes.history || [];
    trackedBalanceHistoryData = balanceHistoryDataRes.trackedHistory || [];

    if (filteredSnapshots.length === 0) {
      showNoData(targetDate);
      return;
    }

    updateSelectedDateDisplay(targetDate);
    renderDashboard();
  } catch (error) {
    showError(`Error loading data: ${error.message}`);
  }
}

function showNoData(date) {
  document.getElementById('positions-container').innerHTML = '<div class="no-positions">No data available</div>';
  document.getElementById('tracked-positions-container').innerHTML = '<div class="no-positions">No open positions</div>';
  updateSelectedDateDisplay(date);
  renderDailyCards();
  renderBalanceHistoryChart();
}

async function filterByDay(dateStr) {
  selectedDate = dateStr;
  updateSelectedDateDisplay(dateStr);
  await fetchSnapshots(dateStr);
}

function updateSelectedDateDisplay(dateStr) {
  const displayEl = document.getElementById('selected-date-display');
  const today = new Date().toISOString().split('T')[0];
  displayEl.textContent = dateStr === today ? 'Today' : new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function renderDashboard() {
  if (filteredSnapshots.length === 0) return;

  document.getElementById('error').style.display = 'none';

  renderBalanceHistoryChart();
  renderDailyCards();
  updateStats();
  renderPositionsTable();
  renderPositionAllocationChart();
  renderPositionSizeChart();
  renderBalanceChart();
  renderPnlChart();
  renderRealizedPnlChart();
  renderDrawdownChart();
  renderRiskChart();
}

function renderBalanceHistoryChart() {
  if (balanceHistoryData.length === 0) return;

  const timestamps = balanceHistoryData.map(d => new Date(d.timestamp));
  const balances = balanceHistoryData.map(d => d.balance);
  const minBalance = Math.min(...balances);
  const maxBalance = Math.max(...balances);
  const padding = (maxBalance - minBalance) * 0.1 || 100;

  if (chartInstances['balance-history-chart']) chartInstances['balance-history-chart'].destroy();
  chartInstances['balance-history-chart'] = new Chart(document.getElementById('balance-history-chart').getContext('2d'), {
    type: 'line',
    data: {
      labels: timestamps,
      datasets: [{
        label: 'Balance',
        data: balances,
        borderColor: '#00d4ff',
        backgroundColor: 'rgba(0, 212, 255, 0.15)',
        fill: true,
        borderWidth: 2,
        tension: 0.1,
        pointRadius: 0
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#192734',
          callbacks: { label: ctx => `$${ctx.parsed.y.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` }
        }
      },
      scales: {
        x: {
          type: 'time',
          time: { unit: 'day', displayFormats: { day: 'MMM d' } },
          ticks: { color: '#8899a6', maxTicksLimit: 10 },
          grid: { color: '#38444d' }
        },
        y: {
          min: minBalance - padding,
          max: maxBalance + padding,
          ticks: { color: '#8899a6', callback: v => '$' + v.toLocaleString() },
          grid: { color: '#38444d' }
        }
      }
    }
  });

  renderTrackedBalanceHistoryChart();
}

function renderTrackedBalanceHistoryChart() {
  if (trackedBalanceHistoryData.length === 0) return;

  const canvas = document.getElementById('tracked-balance-history-chart');
  if (!canvas) return;

  const timestamps = trackedBalanceHistoryData.map(d => new Date(d.timestamp));
  const balances = trackedBalanceHistoryData.map(d => d.balance);
  const minBalance = Math.min(...balances);
  const maxBalance = Math.max(...balances);
  const padding = (maxBalance - minBalance) * 0.1 || 100;

  if (chartInstances['tracked-balance-history-chart']) chartInstances['tracked-balance-history-chart'].destroy();
  chartInstances['tracked-balance-history-chart'] = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels: timestamps,
      datasets: [{
        label: 'Balance',
        data: balances,
        borderColor: '#f7931a',
        backgroundColor: 'rgba(247, 147, 26, 0.15)',
        fill: true,
        borderWidth: 2,
        tension: 0.1,
        pointRadius: 0
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#192734',
          callbacks: { label: ctx => `$${ctx.parsed.y.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` }
        }
      },
      scales: {
        x: {
          type: 'time',
          time: { unit: 'day', displayFormats: { day: 'MMM d' } },
          ticks: { color: '#8899a6', maxTicksLimit: 10 },
          grid: { color: '#38444d' }
        },
        y: {
          min: minBalance - padding,
          max: maxBalance + padding,
          ticks: { color: '#8899a6', callback: v => '$' + v.toLocaleString() },
          grid: { color: '#38444d' }
        }
      }
    }
  });
}

function updateStats() {
  const latest = filteredSnapshots[filteredSnapshots.length - 1];
  const first = filteredSnapshots[0];
  const user = latest.user;

  const realizedBalance = user.accountValue - (user.totalUnrealizedPnl || 0);
  document.getElementById('realized-balance').textContent = `$${realizedBalance.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
  document.getElementById('balance').textContent = `$${user.accountValue.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;

  const currentPnl = user.totalUnrealizedPnl || 0;
  const currentPnlEl = document.getElementById('current-pnl');
  currentPnlEl.textContent = `$${currentPnl.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
  currentPnlEl.className = `stat-value ${currentPnl >= 0 ? 'positive' : 'negative'}`;

  const dailyPnl = user.accountValue - first.user.accountValue;
  const dailyPnlEl = document.getElementById('daily-pnl');
  dailyPnlEl.textContent = `$${dailyPnl.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
  dailyPnlEl.className = `stat-value ${dailyPnl >= 0 ? 'positive' : 'negative'}`;

  document.getElementById('position-count').textContent = user.positions?.length || 0;
  document.getElementById('margin-used').textContent = `$${(user.totalMarginUsed || 0).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
}

function renderBalanceChart() {
  const dates = filteredSnapshots.map(s => new Date(s.timestamp));
  const firstTracked = filteredSnapshots[0].tracked.accountValue;
  const firstUser = filteredSnapshots[0].user.accountValue;
  const trackedChangePct = filteredSnapshots.map(s => ((s.tracked.accountValue - firstTracked) / firstTracked) * 100);
  const userChangePct = filteredSnapshots.map(s => ((s.user.accountValue - firstUser) / firstUser) * 100);

  if (chartInstances['balance-chart']) chartInstances['balance-chart'].destroy();
  chartInstances['balance-chart'] = new Chart(document.getElementById('balance-chart').getContext('2d'), {
    type: 'line',
    data: {
      labels: dates,
      datasets: [
        { label: 'Tracked Balance', data: trackedChangePct, borderColor: '#667eea', backgroundColor: 'rgba(102, 126, 234, 0.1)', fill: true, borderWidth: 2, tension: 0.1, pointRadius: 0 },
        { label: 'User Balance', data: userChangePct, borderColor: '#17bf63', backgroundColor: 'rgba(23, 191, 99, 0.1)', borderDash: [5, 5], fill: true, borderWidth: 2, tension: 0.1, pointRadius: 0 }
      ]
    },
    options: getChartOptions('Change (%)', v => v.toFixed(2) + '%')
  });
}

function renderPnlChart() {
  const dates = filteredSnapshots.map(s => new Date(s.timestamp));
  const trackedPnlPct = filteredSnapshots.map(s => (s.tracked.totalUnrealizedPnl / s.tracked.accountValue) * 100);
  const userPnlPct = filteredSnapshots.map(s => (s.user.totalUnrealizedPnl / s.user.accountValue) * 100);

  if (chartInstances['pnl-chart']) chartInstances['pnl-chart'].destroy();
  chartInstances['pnl-chart'] = new Chart(document.getElementById('pnl-chart').getContext('2d'), {
    type: 'line',
    data: {
      labels: dates,
      datasets: [
        { label: 'Tracked PNL', data: trackedPnlPct, borderColor: '#667eea', backgroundColor: 'rgba(102, 126, 234, 0.1)', fill: true, borderWidth: 2, tension: 0.1, pointRadius: 0 },
        { label: 'User PNL', data: userPnlPct, borderColor: '#17bf63', backgroundColor: 'rgba(23, 191, 99, 0.1)', borderDash: [5, 5], fill: true, borderWidth: 2, tension: 0.1, pointRadius: 0 }
      ]
    },
    options: getChartOptions('% of Balance', v => v.toFixed(2) + '%')
  });
}

function renderRealizedPnlChart() {
  if (chartInstances['realized-pnl-chart']) chartInstances['realized-pnl-chart'].destroy();
  const ctx = document.getElementById('realized-pnl-chart').getContext('2d');

  if (allTrades.length === 0 && trackedFills.length === 0) {
    chartInstances['realized-pnl-chart'] = new Chart(ctx, {
      type: 'line',
      data: { datasets: [] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { display: false } } },
      plugins: [{
        id: 'noDataMessage',
        afterDraw: (chart) => {
          chart.ctx.save();
          chart.ctx.textAlign = 'center';
          chart.ctx.textBaseline = 'middle';
          chart.ctx.font = '16px sans-serif';
          chart.ctx.fillStyle = '#657786';
          chart.ctx.fillText('No closed trades', chart.width / 2, chart.height / 2);
          chart.ctx.restore();
        }
      }]
    });
    return;
  }

  const trackedBaseBalance = filteredSnapshots[0]?.tracked?.accountValue || 1;
  const userBaseBalance = filteredSnapshots[0]?.user?.accountValue || 1;

  const trackedData = {};
  trackedFills.sort((a, b) => a.timestamp - b.timestamp).forEach(fill => {
    if (!trackedData[fill.coin]) trackedData[fill.coin] = { x: [], y: [], cumulative: 0 };
    trackedData[fill.coin].cumulative += fill.closedPnl;
    trackedData[fill.coin].x.push(new Date(fill.timestamp));
    trackedData[fill.coin].y.push((trackedData[fill.coin].cumulative / trackedBaseBalance) * 100);
  });

  const userData = {};
  allTrades.sort((a, b) => a.timestamp - b.timestamp).forEach(trade => {
    if (!userData[trade.coin]) userData[trade.coin] = { x: [], y: [], cumulative: 0 };
    userData[trade.coin].cumulative += trade.realizedPnl;
    userData[trade.coin].x.push(new Date(trade.timestamp));
    userData[trade.coin].y.push((userData[trade.coin].cumulative / userBaseBalance) * 100);
  });

  const datasets = [];
  Object.entries(trackedData).forEach(([coin, data]) => {
    datasets.push({
      label: `${coin} (Tracked)`,
      data: data.x.map((x, i) => ({ x, y: data.y[i] })),
      borderColor: getSymbolColor(coin),
      borderWidth: 2, tension: 0.1, fill: false, pointRadius: 0
    });
  });
  Object.entries(userData).forEach(([coin, data]) => {
    datasets.push({
      label: `${coin} (User)`,
      data: data.x.map((x, i) => ({ x, y: data.y[i] })),
      borderColor: getSymbolColor(coin),
      borderWidth: 2, borderDash: [5, 5], tension: 0.1, fill: false, pointRadius: 0
    });
  });

  chartInstances['realized-pnl-chart'] = new Chart(ctx, {
    type: 'line',
    data: { datasets },
    options: getChartOptions('Cumulative PNL (% of Balance)', v => v.toFixed(2) + '%')
  });
}

function renderDrawdownChart() {
  const dates = filteredSnapshots.map(s => new Date(s.timestamp));
  const trackedDrawdown = calculateDrawdown(filteredSnapshots.map(s => s.tracked.accountValue));
  const userDrawdown = calculateDrawdown(filteredSnapshots.map(s => s.user.accountValue));

  if (chartInstances['drawdown-chart']) chartInstances['drawdown-chart'].destroy();
  chartInstances['drawdown-chart'] = new Chart(document.getElementById('drawdown-chart').getContext('2d'), {
    type: 'line',
    data: {
      labels: dates,
      datasets: [
        { label: 'Tracked Drawdown', data: trackedDrawdown, borderColor: '#667eea', backgroundColor: 'rgba(102, 126, 234, 0.3)', fill: true, borderWidth: 2, tension: 0.1, pointRadius: 0 },
        { label: 'User Drawdown', data: userDrawdown, borderColor: '#17bf63', backgroundColor: 'rgba(23, 191, 99, 0.3)', fill: true, borderWidth: 2, tension: 0.1, pointRadius: 0 }
      ]
    },
    options: getChartOptions('Drawdown (%)', v => v.toFixed(2) + '%')
  });
}

function calculateDrawdown(values) {
  const drawdowns = [];
  let runningMax = values[0];
  for (const v of values) {
    if (v > runningMax) runningMax = v;
    drawdowns.push(((v - runningMax) / runningMax) * 100);
  }
  return drawdowns;
}

function renderRiskChart() {
  const dates = filteredSnapshots.map(s => new Date(s.timestamp));

  if (chartInstances['risk-chart']) chartInstances['risk-chart'].destroy();
  chartInstances['risk-chart'] = new Chart(document.getElementById('risk-chart').getContext('2d'), {
    type: 'line',
    data: {
      labels: dates,
      datasets: [
        { label: 'Tracked Avg Leverage', data: filteredSnapshots.map(s => s.tracked.averageLeverage), borderColor: '#667eea', borderWidth: 2, yAxisID: 'y', tension: 0.1, pointRadius: 0 },
        { label: 'User Avg Leverage', data: filteredSnapshots.map(s => s.user.averageLeverage), borderColor: '#17bf63', borderWidth: 2, yAxisID: 'y', tension: 0.1, pointRadius: 0 },
        { label: 'Tracked Margin Ratio', data: filteredSnapshots.map(s => s.tracked.crossMarginRatio), borderColor: '#e0245e', borderWidth: 2, borderDash: [5, 5], yAxisID: 'y2', tension: 0.1, pointRadius: 0 },
        { label: 'User Margin Ratio', data: filteredSnapshots.map(s => s.user.crossMarginRatio), borderColor: '#ff6b9d', borderWidth: 2, borderDash: [5, 5], yAxisID: 'y2', tension: 0.1, pointRadius: 0 }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { position: 'bottom', labels: { color: '#e1e8ed' } } },
      scales: {
        x: { type: 'time', time: { tooltipFormat: 'MMM d, HH:mm' }, ticks: { color: '#8899a6' }, grid: { color: '#38444d' } },
        y: { ticks: { color: '#8899a6' }, grid: { color: '#38444d' } },
        y2: { position: 'right', ticks: { color: '#8899a6' }, grid: { display: false } }
      }
    }
  });
}

function renderDailyCards() {
  Object.keys(chartInstances).forEach(key => {
    if (key.startsWith('daily-chart-')) {
      chartInstances[key].destroy();
      delete chartInstances[key];
    }
  });

  const container = document.getElementById('daily-cards-grid');
  container.innerHTML = '';

  for (const day of dailySummaryData) {
    const card = document.createElement('div');
    card.className = day.hasData ? 'daily-card' : 'daily-card no-data';
    if (day.date === selectedDate) card.classList.add('selected');

    const dateLabel = new Date(day.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

    if (day.hasData) {
      const pnlClass = day.totalPnl >= 0 ? 'positive' : 'negative';
      const pnlSign = day.totalPnl >= 0 ? '+' : '';
      const chartId = `daily-chart-${day.date}`;

      card.innerHTML = `
        <div class="daily-card-date">${dateLabel}</div>
        <div class="daily-card-pnl ${pnlClass}">${pnlSign}$${day.totalPnl.toFixed(2)}</div>
        <div class="daily-card-percent">${pnlSign}${day.pnlPercentage.toFixed(2)}%</div>
        <div class="daily-card-balance">$${day.endBalance.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</div>
        <div class="daily-card-chart"><canvas id="${chartId}"></canvas></div>
      `;
      card.addEventListener('click', () => filterByDay(day.date));
      container.appendChild(card);
      renderDailyMiniChart(chartId, day.date, pnlClass === 'positive');
    } else {
      card.innerHTML = `
        <div class="daily-card-date">${dateLabel}</div>
        <div style="text-align: center; color: #657786; font-size: 0.9em; padding: 20px 0;">No Data</div>
      `;
      container.appendChild(card);
    }
  }
}

async function renderDailyMiniChart(chartId, date, isPositive) {
  try {
    const accountParam = currentAccountId && currentAccountId !== 'summary' ? `&account=${currentAccountId}` : '';
    const response = await fetch(`/api/snapshots?date=${date}${accountParam}`);
    const data = await response.json();

    if (!data.snapshots || data.snapshots.length === 0) return;

    const balances = data.snapshots.map(s => s.user.accountValue);
    const color = isPositive ? '#17bf63' : '#e0245e';
    const ctx = document.getElementById(chartId);
    if (!ctx) return;

    if (chartInstances[chartId]) {
      chartInstances[chartId].destroy();
    }

    chartInstances[chartId] = new Chart(ctx.getContext('2d'), {
      type: 'line',
      data: {
        labels: data.snapshots.map(s => new Date(s.timestamp)),
        datasets: [{ data: balances, borderColor: color, backgroundColor: color + '20', borderWidth: 1.5, tension: 0.3, pointRadius: 0, fill: true }]
      },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { enabled: false } }, scales: { x: { display: false }, y: { display: false } } }
    });
  } catch (error) {
    console.error(`Failed to render mini chart for ${date}:`, error);
  }
}

function renderPositionsTable() {
  const container = document.getElementById('positions-container');
  const latest = filteredSnapshots[filteredSnapshots.length - 1];
  const userPositions = latest.user.positions || [];
  const trackedPositions = latest.tracked.positions || [];
  const trackedByCoins = {};
  for (const pos of trackedPositions) trackedByCoins[pos.coin] = pos;

  if (userPositions.length === 0) {
    container.innerHTML = '<div class="no-positions">No open positions</div>';
    renderTrackedPositionsTable(trackedPositions);
    return;
  }

  const maxNotional = Math.max(...userPositions.map(p => Math.abs(p.notionalValue || 0)), 1);

  let tableHtml = `<table class="positions-table"><thead><tr><th>Coin</th><th style="width: 200px;">Size</th><th>User Entry</th><th>Tracked Entry</th><th>PNL</th></tr></thead><tbody>`;
  let mobileHtml = '<div class="positions-mobile">';

  for (const pos of userPositions) {
    const isLong = pos.side === 'long';
    const direction = isLong ? 'LONG' : 'SHORT';
    const directionClass = isLong ? 'direction-long' : 'direction-short';
    const pnl = pos.unrealizedPnl || 0;
    const pnlClass = pnl >= 0 ? 'positive' : 'negative';
    const pnlSign = pnl >= 0 ? '+' : '';
    const trackedPos = trackedByCoins[pos.coin];
    const trackedEntry = trackedPos ? trackedPos.entryPrice : null;
    const notional = Math.abs(pos.notionalValue || 0);
    const sizeFormatted = '$' + notional.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
    const entryFormatted = '$' + (pos.entryPrice || 0).toLocaleString(undefined, {minimumFractionDigits: 4, maximumFractionDigits: 4});
    const trackedEntryFormatted = trackedEntry ? '$' + trackedEntry.toLocaleString(undefined, {minimumFractionDigits: 4, maximumFractionDigits: 4}) : '-';

    const barPct = (notional / maxNotional) * 50;
    const barColor = getSymbolColor(pos.coin);
    const barStyle = isLong
      ? `left: 50%; width: ${barPct}%;`
      : `right: 50%; width: ${barPct}%;`;
    const labelPosition = isLong ? 'left: 51%;' : 'right: 51%;';

    let entryDiffHtml = '';
    let entryDiffMobileHtml = '';
    if (trackedEntry && pos.entryPrice) {
      const diffPct = ((pos.entryPrice - trackedEntry) / trackedEntry) * 100;
      const isFavorable = isLong ? diffPct < 0 : diffPct > 0;
      const diffClass = isFavorable ? 'positive' : 'negative';
      const diffSign = diffPct >= 0 ? '+' : '';
      entryDiffHtml = `<span class="${diffClass}" style="margin-left: 8px; font-size: 0.85em;">(${diffSign}${diffPct.toFixed(2)}%)</span>`;
      entryDiffMobileHtml = `<span class="${diffClass}">(${diffSign}${diffPct.toFixed(2)}%)</span>`;
    }

    const sizeBarHtml = `<div class="position-size-bar-container"><div class="position-size-bar" style="background: ${barColor}; ${barStyle}"></div><span class="position-size-bar-label" style="${labelPosition}">${direction}</span><span class="position-size-bar-value" style="${isLong ? 'right: 51%;' : 'left: 51%;'}">${sizeFormatted}</span></div>`;

    tableHtml += `<tr><td>${pos.coin}</td><td>${sizeBarHtml}</td><td>${entryFormatted}${entryDiffHtml}</td><td>${trackedEntryFormatted}</td><td class="${pnlClass}">${pnlSign}$${Math.abs(pnl).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</td></tr>`;

    mobileHtml += `
      <div class="position-card">
        <div class="position-card-header">
          <div class="position-card-coin">
            <span>${pos.coin}</span>
            <span class="${directionClass}">${direction}</span>
          </div>
          <div class="position-card-pnl ${pnlClass}">${pnlSign}$${Math.abs(pnl).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</div>
        </div>
        <div class="position-card-details">
          <div class="position-card-row">
            <span class="position-card-label">Size</span>
            <span class="position-card-value">${sizeFormatted}</span>
          </div>
          <div class="position-card-row">
            <span class="position-card-label">Entry</span>
            <span class="position-card-value">${entryFormatted}</span>
          </div>
          <div class="position-card-row">
            <span class="position-card-label">Tracked</span>
            <span class="position-card-value">${trackedEntryFormatted}</span>
          </div>
          <div class="position-card-row">
            <span class="position-card-label">Diff</span>
            <span class="position-card-value">${entryDiffMobileHtml || '-'}</span>
          </div>
        </div>
      </div>
    `;
  }

  tableHtml += '</tbody></table>';
  mobileHtml += '</div>';
  container.innerHTML = tableHtml + mobileHtml;

  renderTrackedPositionsTable(trackedPositions);
}

function renderTrackedPositionsTable(trackedPositions) {
  const container = document.getElementById('tracked-positions-container');

  if (trackedPositions.length === 0) {
    container.innerHTML = '<div class="no-positions">No open positions</div>';
    return;
  }

  const maxNotional = Math.max(...trackedPositions.map(p => Math.abs(p.notionalValue || 0)), 1);

  let tableHtml = `<table class="positions-table"><thead><tr><th>Coin</th><th style="width: 200px;">Size</th><th>Entry</th><th>PNL</th></tr></thead><tbody>`;
  let mobileHtml = '<div class="positions-mobile">';

  for (const pos of trackedPositions) {
    const isLong = pos.side === 'long';
    const direction = isLong ? 'LONG' : 'SHORT';
    const directionClass = isLong ? 'direction-long' : 'direction-short';
    const pnl = pos.unrealizedPnl || 0;
    const pnlClass = pnl >= 0 ? 'positive' : 'negative';
    const pnlSign = pnl >= 0 ? '+' : '';
    const notional = Math.abs(pos.notionalValue || 0);
    const sizeFormatted = '$' + notional.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
    const entryFormatted = '$' + (pos.entryPrice || 0).toLocaleString(undefined, {minimumFractionDigits: 4, maximumFractionDigits: 4});

    const barPct = (notional / maxNotional) * 50;
    const barColor = getSymbolColor(pos.coin);
    const barStyle = isLong
      ? `left: 50%; width: ${barPct}%;`
      : `right: 50%; width: ${barPct}%;`;
    const labelPosition = isLong ? 'left: 51%;' : 'right: 51%;';

    const sizeBarHtml = `<div class="position-size-bar-container"><div class="position-size-bar" style="background: ${barColor}; ${barStyle}"></div><span class="position-size-bar-label" style="${labelPosition}">${direction}</span><span class="position-size-bar-value" style="${isLong ? 'right: 51%;' : 'left: 51%;'}">${sizeFormatted}</span></div>`;

    tableHtml += `<tr><td>${pos.coin}</td><td>${sizeBarHtml}</td><td>${entryFormatted}</td><td class="${pnlClass}">${pnlSign}$${Math.abs(pnl).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</td></tr>`;

    mobileHtml += `
      <div class="position-card">
        <div class="position-card-header">
          <div class="position-card-coin">
            <span>${pos.coin}</span>
            <span class="${directionClass}">${direction}</span>
          </div>
          <div class="position-card-pnl ${pnlClass}">${pnlSign}$${Math.abs(pnl).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</div>
        </div>
        <div class="position-card-details">
          <div class="position-card-row">
            <span class="position-card-label">Size</span>
            <span class="position-card-value">${sizeFormatted}</span>
          </div>
          <div class="position-card-row">
            <span class="position-card-label">Entry</span>
            <span class="position-card-value">${entryFormatted}</span>
          </div>
        </div>
      </div>
    `;
  }

  tableHtml += '</tbody></table>';
  mobileHtml += '</div>';
  container.innerHTML = tableHtml + mobileHtml;
}

function renderPositionAllocationChart() {
  const latest = filteredSnapshots[filteredSnapshots.length - 1];
  const trackedPositions = latest.tracked?.positions || [];
  const userPositions = latest.user?.positions || [];
  const trackedAccountValue = latest.tracked?.accountValue || 1;
  const userAccountValue = latest.user?.accountValue || 1;

  const cardsRow = document.getElementById('allocation-cards-row');
  if (trackedPositions.length === 0 && userPositions.length === 0) {
    cardsRow.style.display = 'none';
    return;
  }
  cardsRow.style.display = 'grid';

  renderAllocationPie('tracked-allocation-chart', trackedPositions, trackedAccountValue, 'tracked-allocation-legend');
  renderAllocationPie('user-allocation-chart', userPositions, userAccountValue, 'user-allocation-legend');
}

function renderAllocationPie(canvasId, positions, accountValue, legendId) {
  const positionData = positions.map(pos => ({
    coin: pos.coin,
    pct: (Math.abs(pos.notionalValue || 0) / accountValue) * 100
  }));

  const totalPositionPct = positionData.reduce((sum, p) => sum + p.pct, 0);
  const cashPct = Math.max(0, 100 - totalPositionPct);

  const labels = [...positionData.map(p => p.coin), 'Cash'];
  const data = [...positionData.map(p => p.pct), cashPct];
  const colors = [...positionData.map(p => getSymbolColor(p.coin)), '#38444d'];

  if (chartInstances[canvasId]) chartInstances[canvasId].destroy();
  chartInstances[canvasId] = new Chart(document.getElementById(canvasId).getContext('2d'), {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data,
        backgroundColor: colors,
        borderColor: '#1a1a2e',
        borderWidth: 2
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#192734',
          titleColor: '#e1e8ed',
          bodyColor: '#8899a6',
          callbacks: {
            label: ctx => `${ctx.label}: ${ctx.parsed.toFixed(1)}%`
          }
        }
      }
    }
  });

  const legendContainer = document.getElementById(legendId);
  legendContainer.innerHTML = labels.map((label, i) => `
    <div class="pie-legend-item">
      <div class="pie-legend-color" style="background: ${colors[i]}"></div>
      <span>${label}</span>
    </div>
  `).join('');
}

function renderPositionSizeChart() {
  const sizeContainer = document.getElementById('position-size-chart-container');
  if (filteredSnapshots.length === 0) {
    sizeContainer.style.display = 'none';
    return;
  }

  const allCoins = new Set();
  for (const snapshot of filteredSnapshots) {
    const userPositions = snapshot.user?.positions || [];
    const trackedPositions = snapshot.tracked?.positions || [];
    userPositions.forEach(p => allCoins.add(p.coin));
    trackedPositions.forEach(p => allCoins.add(p.coin));
  }

  if (allCoins.size === 0) {
    sizeContainer.style.display = 'none';
    return;
  }
  sizeContainer.style.display = 'block';

  const dates = filteredSnapshots.map(s => new Date(s.timestamp));
  const datasets = [];

  for (const coin of allCoins) {
    const color = getSymbolColor(coin);

    const trackedSizesPct = filteredSnapshots.map(s => {
      const pos = (s.tracked?.positions || []).find(p => p.coin === coin);
      const balance = s.tracked?.accountValue || 1;
      return pos ? (Math.abs(pos.notionalValue || 0) / balance) * 100 : 0;
    });

    const userSizesPct = filteredSnapshots.map(s => {
      const pos = (s.user?.positions || []).find(p => p.coin === coin);
      const balance = s.user?.accountValue || 1;
      return pos ? (Math.abs(pos.notionalValue || 0) / balance) * 100 : 0;
    });

    const hasTrackedData = trackedSizesPct.some(v => v > 0);
    const hasUserData = userSizesPct.some(v => v > 0);

    if (hasTrackedData) {
      datasets.push({
        label: `${coin} (Tracked)`,
        data: trackedSizesPct,
        borderColor: color,
        backgroundColor: color + '20',
        borderWidth: 2,
        tension: 0.1,
        pointRadius: 0,
        fill: false
      });
    }

    if (hasUserData) {
      datasets.push({
        label: `${coin} (User)`,
        data: userSizesPct,
        borderColor: color,
        backgroundColor: color + '20',
        borderWidth: 2,
        borderDash: [5, 5],
        tension: 0.1,
        pointRadius: 0,
        fill: false
      });
    }
  }

  if (chartInstances['position-size-chart']) chartInstances['position-size-chart'].destroy();
  chartInstances['position-size-chart'] = new Chart(document.getElementById('position-size-chart').getContext('2d'), {
    type: 'line',
    data: {
      labels: dates,
      datasets
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'bottom', labels: { color: '#e1e8ed', font: { size: 10 } } },
        tooltip: {
          backgroundColor: '#192734',
          titleColor: '#e1e8ed',
          bodyColor: '#8899a6',
          callbacks: {
            label: ctx => `${ctx.dataset.label}: ${ctx.parsed.y.toFixed(1)}%`
          }
        }
      },
      scales: {
        x: {
          type: 'time',
          time: { tooltipFormat: 'MMM d, HH:mm' },
          ticks: { color: '#8899a6' },
          grid: { color: '#38444d' }
        },
        y: {
          title: { display: true, text: '% of Balance', color: '#8899a6' },
          ticks: {
            color: '#8899a6',
            callback: v => v.toFixed(0) + '%'
          },
          grid: { color: '#38444d' }
        }
      }
    }
  });
}

function getChartOptions(yLabel, tickCallback) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: { legend: { position: 'bottom', labels: { color: '#e1e8ed' } }, tooltip: { backgroundColor: '#192734', titleColor: '#e1e8ed', bodyColor: '#8899a6' } },
    scales: {
      x: { type: 'time', time: { tooltipFormat: 'MMM d, HH:mm' }, ticks: { color: '#8899a6' }, grid: { color: '#38444d' } },
      y: { title: { display: true, text: yLabel, color: '#8899a6' }, ticks: { color: '#8899a6', callback: tickCallback }, grid: { color: '#38444d' } }
    }
  };
}

function showError(message) {
  document.getElementById('loading').style.display = 'none';
  document.getElementById('dashboard').style.display = 'none';
  document.getElementById('error').style.display = 'block';
  document.getElementById('error').textContent = message;
}

init();
setInterval(() => {
  if (currentAccountId === 'summary') {
    loadSummaryView();
  } else {
    fetchSnapshots();
  }
}, 60000);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then(reg => console.log('Service Worker registered'))
      .catch(err => console.log('Service Worker registration failed:', err));
  });
}
