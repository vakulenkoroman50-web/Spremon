const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const WebSocket = require('ws');

/**
 * КОНФИГУРАЦИЯ
 */
const CONFIG = {
    PORT: process.env.PORT || 3000,
    SECRET_TOKEN: process.env.SECRET_TOKEN || '',
    MEXC: {
        KEY: process.env.MEXC_API_KEY || '',
        SECRET: process.env.MEXC_API_SECRET || '',
        BASE_URL: 'https://api.mexc.com',
        FUTURES_URL: 'https://contract.mexc.com'
    }
};

const EXCHANGES_ORDER = ["Binance", "Bybit", "Gate", "Bitget", "BingX", "OKX", "Kucoin"];
// MEXC теперь просто один из списка для итераций
const ALL_SOURCES = ["MEXC", ...EXCHANGES_ORDER];

/**
 * GLOBAL DATA CACHE
 */
const GLOBAL_PRICES = {};
const GLOBAL_FAIR = {};
let MEXC_CONFIG_CACHE = null;

const HISTORY_OHLC = {}; 
const CURRENT_CANDLES = {};

// --- НОРМАЛИЗАЦИЯ ---
const normalizeSymbol = (s) => {
    if (!s) return null;
    let sym = s.toUpperCase();
    if (sym.startsWith('XBT')) sym = sym.replace('XBT', 'BTC');
    sym = sym.replace(/[-_]/g, '');
    sym = sym.replace(/SWAP$/, '');
    sym = sym.replace(/USDTM?$/, ''); 
    sym = sym.replace(/USD$/, '');
    return sym;
};

// --- ОБНОВЛЕНИЕ ДАННЫХ ---
const updateData = (rawSymbol, exchange, price, fairPrice = null) => {
    const s = normalizeSymbol(rawSymbol);
    if (!s) return;

    if (price) {
        if (!GLOBAL_PRICES[s]) GLOBAL_PRICES[s] = {};
        GLOBAL_PRICES[s][exchange] = parseFloat(price);
    }

    if (fairPrice) {
        if (!GLOBAL_FAIR[s]) GLOBAL_FAIR[s] = {};
        GLOBAL_FAIR[s][exchange] = parseFloat(fairPrice);
    }
};

// --- ИСТОРИЯ (OHLC) ---
setInterval(() => {
    const now = new Date();
    const currentMinute = Math.floor(now.getTime() / 60000); 

    Object.keys(GLOBAL_PRICES).forEach(symbol => {
        const prices = GLOBAL_PRICES[symbol];
        
        ALL_SOURCES.forEach(source => {
            const price = prices[source];
            if (!price) return; 

            if (!CURRENT_CANDLES[symbol]) CURRENT_CANDLES[symbol] = {};
            if (!HISTORY_OHLC[symbol]) HISTORY_OHLC[symbol] = {};

            if (!CURRENT_CANDLES[symbol][source] || CURRENT_CANDLES[symbol][source].lastMinute !== currentMinute) {
                if (CURRENT_CANDLES[symbol][source]) {
                    if (!HISTORY_OHLC[symbol][source]) HISTORY_OHLC[symbol][source] = [];
                    HISTORY_OHLC[symbol][source].push({ ...CURRENT_CANDLES[symbol][source] });
                    if (HISTORY_OHLC[symbol][source].length > 25) HISTORY_OHLC[symbol][source].shift();
                }
                CURRENT_CANDLES[symbol][source] = {
                    o: price, h: price, l: price, c: price,
                    lastMinute: currentMinute
                };
            } else {
                const c = CURRENT_CANDLES[symbol][source];
                if (price > c.h) c.h = price;
                if (price < c.l) c.l = price;
                c.c = price; 
            }
        });
    });
}, 1000);

const safeJson = (data) => {
    try { return JSON.parse(data); } catch (e) { return null; }
};

/**
 * --- MONITORS ---
 */
// MEXC
const initMexcGlobal = () => {
    let ws = null;
    const connect = () => {
        try {
            ws = new WebSocket('wss://contract.mexc.com/edge');
            ws.on('open', () => ws.send(JSON.stringify({ "method": "sub.tickers", "param": {} })));
            ws.on('message', (data) => {
                const d = safeJson(data);
                if (!d) return;
                if (d.method === 'ping') { ws.send(JSON.stringify({ "method": "pong" })); return; }
                if (d.channel === 'push.tickers' && d.data) {
                    const items = Array.isArray(d.data) ? d.data : [d.data];
                    items.forEach(i => updateData(i.symbol, 'MEXC', i.lastPrice, i.fairPrice));
                }
            });
            ws.on('close', () => setTimeout(connect, 3000));
        } catch (e) { setTimeout(connect, 5000); }
    };
    connect();
};

// BINANCE
const initBinanceGlobal = () => {
    let ws = null;
    const connect = () => {
        try {
            ws = new WebSocket('wss://fstream.binance.com/ws/!ticker@arr'); 
            ws.on('message', (data) => {
                const arr = safeJson(data);
                if (Array.isArray(arr)) arr.forEach(i => updateData(i.s, 'Binance', i.c));
            });
            ws.on('close', () => setTimeout(connect, 3000));
        } catch (e) { setTimeout(connect, 5000); }
    };
    connect();
    setInterval(async () => {
        try { if(!fetch) return; const res = await fetch('https://fapi.binance.com/fapi/v1/premiumIndex'); const data = await res.json();
            if(Array.isArray(data)) data.forEach(i => updateData(i.symbol, 'Binance', null, i.markPrice));
        } catch(e) {}
    }, 3000);
};

// POLLERS
const initBybitGlobal = () => { setInterval(async () => { try { if (!fetch) return; const res = await fetch('https://api.bybit.com/v5/market/tickers?category=linear'); const d = await res.json(); if (d.result && d.result.list) d.result.list.forEach(i => updateData(i.symbol, 'Bybit', i.lastPrice, i.markPrice)); } catch(e) {} }, 1500); };
const initGateGlobal = () => { setInterval(async () => { try { if (!fetch) return; const res = await fetch('https://api.gateio.ws/api/v4/futures/usdt/tickers'); const data = await res.json(); if (Array.isArray(data)) data.forEach(i => updateData(i.contract, 'Gate', i.last, i.mark_price)); } catch(e) {} }, 2000); };
const initBitgetGlobal = () => { setInterval(async () => { try { if (!fetch) return; const res = await fetch('https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES'); const d = await res.json(); if (d.data) d.data.forEach(i => updateData(i.symbol, 'Bitget', i.lastPr, i.markPr)); } catch(e) {} }, 2000); };
const initOkxGlobal = () => { 
    setInterval(async () => { try { if (!fetch) return; const res = await fetch('https://www.okx.com/api/v5/market/tickers?instType=SWAP'); const d = await res.json(); if (d.data) d.data.forEach(i => { if (i.instId.endsWith('USDT-SWAP')) updateData(i.instId, 'OKX', i.last); }); } catch(e) {} }, 2000); 
    setInterval(async () => { try { if (!fetch) return; const res = await fetch('https://www.okx.com/api/v5/public/mark-price?instType=SWAP'); const d = await res.json(); if (d.data) d.data.forEach(i => { if (i.instId.endsWith('USDT-SWAP')) updateData(i.instId, 'OKX', null, i.markPx); }); } catch(e) {} }, 4000);
};
const initBingxGlobal = () => { setInterval(async () => { try { if (!fetch) return; const res = await fetch('https://open-api.bingx.com/openApi/swap/v2/quote/ticker'); const d = await res.json(); if (d.data) d.data.forEach(i => updateData(i.symbol, 'BingX', i.lastPrice, i.markPrice)); } catch(e) {} }, 2000); };
const initKucoinGlobal = () => { 
    setInterval(async () => { try { if (!fetch) return; const res = await fetch('https://api-futures.kucoin.com/api/v1/allTickers'); const d = await res.json(); if (d.data && Array.isArray(d.data)) d.data.forEach(i => updateData(i.symbol, 'Kucoin', i.price)); } catch(e) {} }, 2000);
    setInterval(async () => { try { if (!fetch) return; const res = await fetch('https://api-futures.kucoin.com/api/v1/contracts/active'); const d = await res.json(); if (d.data && Array.isArray(d.data)) d.data.forEach(i => updateData(i.symbol, 'Kucoin', null, i.markPrice)); } catch(e) {} }, 5000);
};

initMexcGlobal(); initBinanceGlobal(); initBybitGlobal(); initGateGlobal();
initBitgetGlobal(); initOkxGlobal(); initBingxGlobal(); initKucoinGlobal();

// --- SERVER ---
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

let fetch;
(async () => {
    fetch = (await import('node-fetch')).default;
    updateMexcConfigCache();
})();

const authMiddleware = (req, res, next) => {
    if (req.query.token !== CONFIG.SECRET_TOKEN) return res.status(403).json({ ok: false, msg: "AUTH_ERR" });
    next();
};

const signMexc = (params) => {
    const queryString = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
    return crypto.createHmac('sha256', CONFIG.MEXC.SECRET).update(queryString).digest('hex');
};

async function mexcPrivateRequest(path, params = {}) {
    if (!CONFIG.MEXC.KEY || !CONFIG.MEXC.SECRET) return null;
    try {
        params.timestamp = Date.now();
        params.signature = signMexc(params);
        const query = new URLSearchParams(params).toString();
        const res = await fetch(`${CONFIG.MEXC.BASE_URL}${path}?${query}`, { headers: { 'X-MEXC-APIKEY': CONFIG.MEXC.KEY } });
        return await res.json();
    } catch (e) { return null; }
}

async function updateMexcConfigCache() {
    try { if (!fetch) return; const data = await mexcPrivateRequest("/api/v3/capital/config/getall"); if (data && Array.isArray(data)) MEXC_CONFIG_CACHE = data; } catch (e) {}
}
setInterval(updateMexcConfigCache, 60000);

// --- API ---
app.get('/api/resolve', authMiddleware, async (req, res) => {
    const symbol = (req.query.symbol || '').toUpperCase();
    let data = MEXC_CONFIG_CACHE;
    if (!data) data = await mexcPrivateRequest("/api/v3/capital/config/getall");
    if (!data || !Array.isArray(data)) return res.json({ ok: false });
    const tokenData = data.find(t => t.coin === symbol);
    if (!tokenData?.networkList) return res.json({ ok: false });
    const depositOpen = tokenData.networkList.some(net => net.depositEnable);
    let bestPair = null;
    const contracts = tokenData.networkList.filter(n => n.contract).map(n => n.contract);
    await Promise.all(contracts.map(async (contract) => {
        try {
            const dsRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${contract}`);
            const dsData = await dsRes.json();
            if (dsData.pairs) {
                dsData.pairs.forEach(pair => {
                    if (!bestPair || (parseFloat(pair.volume?.h24 || 0) > parseFloat(bestPair.volume?.h24 || 0))) {
                        bestPair = pair;
                    }
                });
            }
        } catch (e) {}
    }));
    res.json({ ok: true, chain: bestPair?.chainId, addr: bestPair?.pairAddress, url: bestPair?.url, depositOpen });
});

app.get('/api/all', authMiddleware, async (req, res) => {
    let symbol = (req.query.symbol || '').toUpperCase();
    symbol = symbol.replace('USDT', '');
    if (!symbol) return res.json({ ok: false });

    const marketData = GLOBAL_PRICES[symbol] || {};
    const fairData = GLOBAL_FAIR[symbol] || {};
    
    const prices = {};
    const fairPrices = {};
    let sum = 0; let count = 0;

    ALL_SOURCES.forEach(source => {
        let p = marketData[source] || 0;
        prices[source] = p;
        fairPrices[source] = fairData[source] || 0;
        if (p > 0) { sum += p; count++; }
    });

    const globalAverage = count > 0 ? sum / count : 0;

    const allCandles = {};
    ALL_SOURCES.forEach(source => {
        let sourceCandles = [];
        if (HISTORY_OHLC[symbol] && HISTORY_OHLC[symbol][source]) sourceCandles = [...HISTORY_OHLC[symbol][source]];
        if (CURRENT_CANDLES[symbol] && CURRENT_CANDLES[symbol][source]) sourceCandles.push(CURRENT_CANDLES[symbol][source]);
        if (sourceCandles.length > 20) sourceCandles = sourceCandles.slice(-20);
        if (sourceCandles.length > 0) allCandles[source] = sourceCandles;
    });

    res.json({ ok: true, prices, fairPrices, allCandles, average: globalAverage });
});

app.get('/', (req, res) => {
    if (req.query.token !== CONFIG.SECRET_TOKEN) return res.status(403).send("Доступ запрещён!");
    const initialSymbol = (req.query.symbol || '').toUpperCase();
    
    res.send(`
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Crypto Monitor</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { background: #000; font-family: monospace; font-size: 28px; color: #fff; padding: 10px; overflow: hidden; }
#output { white-space: pre; line-height: 1.1; min-height: 280px; position: relative; }
.control-row { display: flex; gap: 5px; margin-top: 0; flex-wrap: wrap; }
#symbolInput { font-family: monospace; font-size: 28px; width: 100%; max-width: 280px; background: #000; color: #fff; border: 1px solid #444; }
#startBtn, #mexcBtn { font-family: monospace; font-size: 28px; background: #222; color: #fff; border: 1px solid #444; cursor: pointer; padding: 0 10px; }
#dexLink { font-family: monospace; font-size: 16px; width: 100%; background: #111; color: #888; border: 1px solid #333; padding: 5px; cursor: pointer; margin-top: 5px; }
.dex-row { color: #00ff00; }
.best { color: #ffff00; }
.closed { color: #ff0000 !important; }
.blink-dot { animation: blink 1s infinite; display: inline-block; }
@keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }
.url-search-container { display: flex; gap: 5px; align-items: center; font-family: Arial, sans-serif; margin-top: 20px; }
#urlInput { width: 46%; padding: 10px; font-size: 36px; background-color: #222; color: #fff; border: 1px solid #444; outline: none; font-family: Arial, sans-serif; }
#goBtn { padding: 10px 20px; font-size: 36px; cursor: pointer; background-color: #333; color: #fff; border: 1px solid #555; font-family: Arial, sans-serif; }
#goBtn:hover { background-color: #888; }

.exchange-link { cursor: pointer; text-decoration: none; color: inherit; }
.exchange-link:hover { text-decoration: underline; }
.exchange-active { background-color: #333; border-radius: 4px; padding: 0 3px; } 
.price-row { display: flex; align-items: center; height: 32px; overflow: hidden; white-space: nowrap; }

#chart-container {
    margin-top: 10px; width: 100%; max-width: 480px; height: 300px; 
    border: 1px solid #333; background: #050505; position: relative; margin-bottom: 5px;
}
#fair-price-display {
    margin-top: 2px; font-size: 14px; color: #888; text-align: right; max-width: 480px; font-family: Arial, sans-serif;
}
svg { width: 100%; height: 100%; display: block; }
.candle-wick { stroke-width: 1; }
.candle-body { stroke: none; }
.green { stroke: #00ff00; fill: #00ff00; }
.red { stroke: #ff0000; fill: #ff0000; }
.chart-text { font-family: Arial, sans-serif; font-size: 8px; }
.corner-label { fill: #ffff00; font-size: 8px; font-weight: bold; }
.vol-label { fill: #fff; font-size: 8px; font-weight: bold; }
.arrow-label { font-size: 8px; font-weight: bold; }
.gap-label { font-size: 8px; font-weight: bold; }
.watermark { font-size: 30px; font-family: Arial, sans-serif; fill: #333; font-weight: bold; opacity: 0.6; }
</style>
</head>
<body>
<div id="output">
    <div class="url-search-container">
        <input type="text" id="urlInput" placeholder="Введите URL или поиск">
        <button id="goBtn" onclick="go()">Go</button>
    </div>
</div>
<div class="control-row">  
    <input id="symbolInput" value="${initialSymbol}" placeholder="TICKER OR LINK" autocomplete="off" onfocus="this.select()" />  
    <button id="startBtn">СТАРТ</button>  
    <button id="mexcBtn">MEXC</button>
</div>  
<div id="chart-container"></div>
<div id="fair-price-display"></div>
<input id="dexLink" readonly placeholder="DEX URL" onclick="this.select(); document.execCommand('copy');" />  
<div id="status" style="font-size: 18px; margin-top: 5px; color: #444;"></div>  

<script>  
// MEXC теперь внутри списка
const allSources = ["MEXC", "Binance", "Bybit", "Gate", "Bitget", "BingX", "OKX", "Kucoin"];
let urlParams = new URLSearchParams(window.location.search);  
let symbol = urlParams.get('symbol')?.toUpperCase() || '';  
let token = urlParams.get('token') || '';  
let chain = urlParams.get('chain');  
let addr = urlParams.get('addr');  
let depositOpen = true;   
let timer = null, blink = false;  

// Обработка ?ex= параметр
let urlEx = urlParams.get('ex');
let activeSource = 'MEXC'; 
if (urlEx) {
    let normalized = urlEx.trim().toLowerCase();
    for (let src of allSources) {
        if (src.toLowerCase() === normalized) {
            activeSource = src;
            break;
        }
    }
}
let manualSourceSelection = !!urlEx; // Если задан в URL, считаем это ручным выбором

const output = document.getElementById("output");  
const input = document.getElementById("symbolInput");  
const dexLink = document.getElementById("dexLink");  
const statusEl = document.getElementById("status");  
const urlInput = document.getElementById("urlInput");
const chartContainer = document.getElementById("chart-container");
const fairPriceDisplay = document.getElementById("fair-price-display");

if(urlInput) {
    urlInput.addEventListener("keydown", function(event) { if (event.key === "Enter") go(); });
}
function go() {
    let query = urlInput.value.trim();
    if (!query) return;
    const isUrl = query.startsWith("http://") || query.startsWith("https://") || (query.includes(".") && !query.includes(" "));
    let targetUrl = isUrl ? (query.startsWith("http") ? query : "https://" + query) : "https://www.google.com/search?q=" + encodeURIComponent(query);
    window.location.href = targetUrl;
}

function setSource(source) {
    activeSource = source;
    manualSourceSelection = true;
    update();
}

function formatP(p) { return (p && p != 0) ? parseFloat(p).toString() : "0"; }  

function renderChart(candles, gap, sourceName) {
    if (!candles || candles.length < 2) {
        chartContainer.innerHTML = '';
        return;
    }
    let minPrice = Infinity, maxPrice = -Infinity;
    candles.forEach(c => {
        if(c.l < minPrice) minPrice = c.l;
        if(c.h > maxPrice) maxPrice = c.h;
    });
    if (minPrice === Infinity) return;

    let volatility = ((maxPrice - minPrice) / minPrice * 100).toFixed(2);
    const range = maxPrice - minPrice;
    const safeRange = range === 0 ? maxPrice * 0.01 : range;
    const padding = safeRange * 0.1; 
    const plotMin = minPrice - padding;
    const plotMax = maxPrice + padding;
    const plotRange = plotMax - plotMin;
    const candleWidth = 100 / 20; 
    const bodyWidth = candleWidth - 1.5;

    let svgHtml = '<svg viewBox="0 0 100 100" preserveAspectRatio="none">';
    svgHtml += \`<text x="50" y="55" text-anchor="middle" dominant-baseline="middle" class="watermark">\${sourceName}</text>\`;
    svgHtml += \`<text x="0.5" y="7" class="chart-text corner-label">\${formatP(maxPrice)}</text>\`;
    svgHtml += \`<text x="0.5" y="99" class="chart-text corner-label">\${formatP(minPrice)}</text>\`;
    svgHtml += \`<text x="99" y="7" text-anchor="end" class="chart-text vol-label">\${volatility}%</text>\`;

    if (gap !== undefined && gap !== null && !isNaN(gap)) {
        let gapColor = gap >= 0 ? '#ff0000' : '#00ff00';
        let gapSign = gap > 0 ? '+' : '';
        svgHtml += \`<text x="99" y="99" text-anchor="end" fill="\${gapColor}" class="chart-text gap-label">GAP: \${gapSign}\${gap.toFixed(2)}%</text>\`;
    }

    candles.forEach((c, index) => {
        const xCenter = (index * candleWidth) + (bodyWidth / 2);
        const yHigh = 100 - ((c.h - plotMin) / plotRange * 100);
        const yLow  = 100 - ((c.l - plotMin) / plotRange * 100);
        const yOpen = 100 - ((c.o - plotMin) / plotRange * 100);
        const yClose= 100 - ((c.c - plotMin) / plotRange * 100);
        const isGreen = c.c >= c.o;
        const colorClass = isGreen ? 'green' : 'red';
        const arrowColor = isGreen ? '#000000' : '#ffffff';

        svgHtml += \`<line x1="\${xCenter}" y1="\${yHigh}" x2="\${xCenter}" y2="\${yLow}" class="candle-wick \${colorClass}" />\`;
        const rectY = Math.min(yOpen, yClose);
        const rectH = Math.abs(yClose - yOpen) || 0.4; 
        const rectX = xCenter - (bodyWidth / 2);
        svgHtml += \`<rect x="\${rectX}" y="\${rectY}" width="\${bodyWidth}" height="\${rectH}" class="candle-body \${colorClass}" />\`;

        if (c.h === maxPrice) svgHtml += \`<text x="\${xCenter}" y="\${arrowY}" fill="\${arrowColor}" text-anchor="middle" class="chart-text arrow-label">↑</text>\`;
        if (c.l === minPrice) svgHtml += \`<text x="\${xCenter}" y="\${arrowY}" fill="\${arrowColor}" text-anchor="middle" class="chart-text arrow-label">↓</text>\`;
    });
    svgHtml += '</svg>';
    chartContainer.innerHTML = svgHtml;
}

async function update() {  
    if (!symbol) return;  
    let dexPrice = 0;  
    if (chain && addr) {  
        try {  
            const r = await fetch('https://api.dexscreener.com/latest/dex/pairs/' + chain + '/' + addr);  
            const d = await r.json();  
            if (d.pair) {  
                dexPrice = parseFloat(d.pair.priceUsd);  
                let pStr = d.pair.priceUsd;
                let sStr = symbol;
                const maxLen = 18; 
                if ((sStr.length + pStr.length + 2) > maxLen) {
                    let spaceForName = maxLen - pStr.length - 2; if(spaceForName < 3) spaceForName = 3;
                    sStr = sStr.substring(0, spaceForName);
                }
                document.title = sStr + ': ' + pStr;
                dexLink.value = d.pair.url;  
            }  
        } catch(e) {}  
    }  
    blink = !blink;  
    try {  
        const res = await fetch('/api/all?symbol=' + encodeURIComponent(symbol) + '&token=' + token);  
        if (res.status === 403) { window.location.reload(); return; }  
        const data = await res.json();  
        if(!data.ok) return;  
        
        let activePrice = data.prices[activeSource];
        
        // Auto-switch source if active is dead and we haven't selected manually
        if (!manualSourceSelection) {
            if (!activePrice || activePrice == 0) {
                // Default is MEXC, if MEXC 0 -> find first alive
                if(data.prices['MEXC'] > 0) activeSource = 'MEXC';
                else {
                    for (let ex of allSources) { if (data.prices[ex] > 0) { activeSource = ex; break; } }
                }
                activePrice = data.prices[activeSource];
            }
        }
        if(!activePrice) activePrice = 0;

        // FAIR PRICE logic
        let activeFair = (data.fairPrices && data.fairPrices[activeSource]) ? data.fairPrices[activeSource] : data.average;
        
        // GAP Calculation
        let chartGap = null;
        if (activePrice > 0 && activeFair > 0) {
            chartGap = ((activePrice - activeFair) / activeFair) * 100;
        }

        // Display Fair Price
        if (activeFair > 0) {
            let fpColor = (chartGap !== null && chartGap >= 0) ? '#ff0000' : '#00ff00';
            let fpSign = (chartGap !== null && chartGap > 0) ? '+' : '';
            let gapText = (chartGap !== null) ? \`(GAP: \${fpSign}\${chartGap.toFixed(2)}%)\` : '';
            fairPriceDisplay.innerHTML = \`Fair Price: \${formatP(activeFair)} <span style="color:\${fpColor}">\${gapText}</span>\`;
        } else {
            fairPriceDisplay.innerHTML = '';
        }
        
        // Update Title if no DEX
        if (!dexPrice) document.title = symbol + ': ' + formatP(activePrice);

        // --- RENDER TEXT ---
        let lines = [];
        
        // 1. DEX Line (Top)
        let dotColorClass = depositOpen ? '' : 'closed';  
        let dotSymbol = blink ? '<span class="'+dotColorClass+'">●</span>' : '○';
        let dotHtml = '<span style="display:inline-block; width:15px; text-align:center; font-family:Arial, sans-serif; line-height:1;">' + dotSymbol + '</span>&nbsp;';
        
        let dexDiffHtml = '';
        if (dexPrice > 0 && activePrice > 0) {
            let diff = ((dexPrice - activePrice) / activePrice * 100).toFixed(2);
            dexDiffHtml = ' (' + (diff > 0 ? "+" : "") + diff + '%)';
        }
        // DEX всегда первая строка
        lines.push('<div class="price-row">' + dotHtml + symbol + ' DEX: ' + formatP(dexPrice) + '<span class="dex-row">' + dexDiffHtml + '</span></div>');

        // 2. CEX List
        // Find best spread
        let bestEx = null, maxSp = 0;
        allSources.forEach(ex => {
            let p = data.prices[ex];
            if (p > 0 && activePrice > 0) {
                let sp = Math.abs((p - activePrice) / activePrice * 100);
                if (sp > maxSp) { maxSp = sp; bestEx = ex; }
            }
        });

        allSources.forEach(ex => {
            let p = data.prices[ex];
            if (p > 0) {
                let isActive = (ex === activeSource);
                let cls = (ex === bestEx) ? 'class="best"' : '';
                let mark = isActive ? '◆' : '◇';
                let activeClass = isActive ? 'exchange-active' : '';
                
                // Name (clickable)
                let nameHtml = '<span class="exchange-link '+activeClass+'" onclick="setSource(\\''+ex+'\\')">' + ex.padEnd(8, ' ') + '</span>';
                
                let tailHtml = '';
                if (isActive) {
                    // Active: Show GAP if > 5%
                    // Recalculate specific gap for this exchange to be sure
                    let thisFair = (data.fairPrices && data.fairPrices[ex]) ? data.fairPrices[ex] : data.average;
                    if(thisFair > 0) {
                        let thisGap = ((p - thisFair) / thisFair) * 100;
                        if(Math.abs(thisGap) > 5) {
                            let gColor = thisGap >= 0 ? '#ff0000' : '#00ff00';
                            let gSign = thisGap > 0 ? '+' : '';
                            tailHtml = \` <span style="color:\${gColor}">(\${gSign}\${thisGap.toFixed(2)}%)</span>\`;
                        }
                    }
                } else {
                    // Inactive: Show Spread
                    if (activePrice > 0) {
                        let diff = ((p - activePrice) / activePrice * 100).toFixed(2);
                        tailHtml = ' (' + (diff > 0 ? "+" : "") + diff + '%)';
                    }
                }

                lines.push('<div class="price-row"><span ' + cls + '>' + mark + ' ' + nameHtml + ': ' + formatP(p) + tailHtml + '</span></div>');
            }
        });

        output.innerHTML = lines.join(""); 
        statusEl.textContent = "Last: " + new Date().toLocaleTimeString();  
        
        // Render Chart
        let candlesToRender = (data.allCandles && data.allCandles[activeSource]) ? data.allCandles[activeSource] : [];
        if(candlesToRender.length > 0) {
            renderChart(candlesToRender, chartGap, activeSource);
        } else {
             chartContainer.innerHTML = '';
        }

    } catch(e) {}  
}  
async function start() {  
    let val = input.value.trim();  
    if(!val) return;  
    input.blur();
    
    // Если параметр ex не задан в URL, сбрасываем на MEXC при новом поиске, иначе держим то что в URL
    if (!urlEx) {
        manualSourceSelection = false;
        activeSource = 'MEXC';
    }

    if(timer) clearInterval(timer);  
    output.innerHTML = "Поиск...";  
    
    if (val.includes("dexscreener.com")) {  
        try {  
            const parts = val.split('/'); chain = parts[parts.length - 2]; addr = parts[parts.length - 1].split('?')[0];  
            fetch('https://api.dexscreener.com/latest/dex/pairs/' + chain + '/' + addr).then(r => r.json()).then(dsData => {
                     if (dsData.pair) {  
                        symbol = dsData.pair.baseToken.symbol.toUpperCase(); input.value = symbol; dexLink.value = dsData.pair.url;  
                    } 
                });
        } catch(e) { output.innerHTML = "Ошибка ссылки!"; return; }  
    } else { symbol = val.toUpperCase(); }  

    const url = new URL(window.location); url.searchParams.set('symbol', symbol); window.history.replaceState({}, '', url);  
    update(); timer = setInterval(update, 1000);  

    try {  
        const res = await fetch('/api/resolve?symbol=' + encodeURIComponent(symbol) + '&token=' + token);  
        if (res.status === 403) return;  
        const d = await res.json();  
        if (d.ok) { chain = d.chain; addr = d.addr; dexLink.value = d.url || ''; depositOpen = d.depositOpen; if(chain) url.searchParams.set('chain', chain); if(addr) url.searchParams.set('addr', addr); window.history.replaceState({}, '', url); } else { depositOpen = true; }  
    } catch(e) {}  
}  
document.getElementById("startBtn").onclick = start;  
document.getElementById("mexcBtn").onclick = function() { let val = input.value.trim().toUpperCase(); if(val) window.location.href = "mxcappscheme://kline?extra_page_name=其他&trade_pair=" + val + "_USDT&contract=1"; };
input.addEventListener("keypress", (e) => { if(e.key === "Enter") { input.blur(); start(); } });  
if (urlParams.get('symbol')) start();  
</script>  
</body>  
</html>  
    `); 
});

app.listen(CONFIG.PORT, () => console.log(`🚀 Server running on port ${CONFIG.PORT}`));
    
