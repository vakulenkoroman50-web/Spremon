const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const WebSocket = require('ws');
const mongoose = require('mongoose');

/**
 * КОНФИГУРАЦИЯ
 */
const CONFIG = {
    PORT: process.env.PORT || 3000,
    SECRET_TOKEN: process.env.SECRET_TOKEN || '',
    MONGO_URI: process.env.MONGO_URI || '', 
    MEXC: {
        KEY: process.env.MEXC_API_KEY || '',
        SECRET: process.env.MEXC_API_SECRET || '',
        BASE_URL: 'https://api.mexc.com',
        FUTURES_URL: 'https://contract.mexc.com'
    },
    // Интервал бэкапа в минутах (можно поставить 60, но 30 безопаснее)
    BACKUP_INTERVAL_MIN: 60 
};

const EXCHANGES_ORDER = ["Binance", "Bybit", "Gate", "Bitget", "BingX", "OKX", "Kucoin"];
const ALL_SOURCES = ["MEXC", ...EXCHANGES_ORDER];
const TIMEFRAMES = ['1m', '15m', '1h'];

/**
 * --- MONGODB (BACKUP SYSTEM) ---
 */
if (CONFIG.MONGO_URI) {
    mongoose.connect(CONFIG.MONGO_URI)
        .then(() => console.log('✅ MongoDB Connected'))
        .catch(err => console.error('❌ MongoDB Error:', err));
}

// Схема для хранения "слепка" истории
// _id будет составным: "SYMBOL_EXCHANGE" (например, "BTC_Binance")
const BackupSchema = new mongoose.Schema({
    _id: String, 
    data: Object, // Здесь лежит весь объект с таймфреймами: { '1m': [...], '1h': [...] }
    updatedAt: { type: Date, default: Date.now }
});

const BackupModel = mongoose.model('Backup', BackupSchema);

/**
 * GLOBAL DATA
 */
const GLOBAL_PRICES = {}; 
const GLOBAL_FAIR = {};   
let MEXC_CONFIG_CACHE = null;

// Главное хранилище (в RAM)
const HISTORY_OHLC = {}; 
const CURRENT_CANDLES = {};

// --- УТИЛИТЫ ---
const normalizeSymbol = (s) => {
    if (!s) return null;
    return s.toUpperCase().replace(/[-_]/g, '').replace('USDT', '').replace('SWAP', '').replace('M', '');        
};

const updateData = (rawSymbol, exchange, price, fairPrice = null) => {
    const s = normalizeSymbol(rawSymbol);
    if (!s) return;
    if (price && parseFloat(price) > 0) {
        if (!GLOBAL_PRICES[s]) GLOBAL_PRICES[s] = {};
        GLOBAL_PRICES[s][exchange] = parseFloat(price);
    }
    if (fairPrice && parseFloat(fairPrice) > 0) {
        if (!GLOBAL_FAIR[s]) GLOBAL_FAIR[s] = {};
        GLOBAL_FAIR[s][exchange] = parseFloat(fairPrice);
    }
};

const safeJson = (data) => {
    try { return JSON.parse(data); } catch (e) { return null; }
};

/**
 * --- ЛОГИКА БЭКАПА (Backup System) ---
 */

// 1. ВОССТАНОВЛЕНИЕ ПРИ СТАРТЕ
async function restoreHistory() {
    if (!CONFIG.MONGO_URI) return;
    console.log('🔄 Restoring history from DB...');
    const startTime = Date.now();
    
    try {
        // Используем курсор для экономии памяти при загрузке
        const cursor = BackupModel.find().cursor();
        let count = 0;

        for (let doc = await cursor.next(); doc != null; doc = await cursor.next()) {
            const [symbol, exchange] = doc._id.split('_');
            if (symbol && exchange && doc.data) {
                if (!HISTORY_OHLC[symbol]) HISTORY_OHLC[symbol] = {};
                HISTORY_OHLC[symbol][exchange] = doc.data;
                count++;
            }
        }
        console.log(`✅ History restored in ${((Date.now() - startTime)/1000).toFixed(2)}s. Loaded ${count} pairs.`);
    } catch (e) {
        console.error('❌ Restore failed:', e);
    }
}

// 2. СОХРАНЕНИЕ (БЭКАП)
async function performBackup() {
    if (!CONFIG.MONGO_URI) return;
    console.log('💾 Starting scheduled backup...');
    
    // Собираем список всех ключей для сохранения
    const tasks = [];
    Object.keys(HISTORY_OHLC).forEach(symbol => {
        Object.keys(HISTORY_OHLC[symbol]).forEach(exchange => {
            const candles = HISTORY_OHLC[symbol][exchange];
            // Пропускаем пустые
            if (Object.keys(candles).length === 0) return;
            
            tasks.push({
                symbol: symbol,
                exchange: exchange,
                data: candles
            });
        });
    });

    if (tasks.length === 0) return console.log('⚠️ Nothing to backup.');

    // Разбиваем на пачки по 100 штук, чтобы не забить CPU и канал
    const CHUNK_SIZE = 100; 
    let savedCount = 0;

    for (let i = 0; i < tasks.length; i += CHUNK_SIZE) {
        const chunk = tasks.slice(i, i + CHUNK_SIZE);
        
        const bulkOps = chunk.map(item => ({
            updateOne: {
                filter: { _id: `${item.symbol}_${item.exchange}` },
                update: { $set: { data: item.data, updatedAt: new Date() } },
                upsert: true
            }
        }));

        try {
            await BackupModel.bulkWrite(bulkOps);
            savedCount += chunk.length;
        } catch (e) {
            console.error('Backup chunk error:', e.message);
        }

        // Небольшая пауза, чтобы разгрузить Event Loop (дать серверу ответить на запросы)
        await new Promise(resolve => setTimeout(resolve, 50));
    }

    console.log(`✅ Backup complete. Saved ${savedCount} pairs.`);
}

// --- CORE LOOP (Только RAM, быстро) ---
setInterval(() => {
    const now = new Date();
    const timeMs = now.getTime();

    const periods = {
        '1m': Math.floor(timeMs / 60000),
        '15m': Math.floor(timeMs / (15 * 60000)),
        '1h': Math.floor(timeMs / (60 * 60000))
    };

    Object.keys(GLOBAL_PRICES).forEach(symbol => {
        const prices = GLOBAL_PRICES[symbol];
        ALL_SOURCES.forEach(source => {
            const price = prices[source];
            if (!price) return; 

            // Инициализация
            if (!CURRENT_CANDLES[symbol]) CURRENT_CANDLES[symbol] = {};
            if (!CURRENT_CANDLES[symbol][source]) CURRENT_CANDLES[symbol][source] = {};
            
            if (!HISTORY_OHLC[symbol]) HISTORY_OHLC[symbol] = {};
            if (!HISTORY_OHLC[symbol][source]) HISTORY_OHLC[symbol][source] = {};

            TIMEFRAMES.forEach(tf => {
                const currentPeriod = periods[tf];
                let currentCandle = CURRENT_CANDLES[symbol][source][tf];

                // Смена периода
                if (!currentCandle || currentCandle.lastPeriod !== currentPeriod) {
                    // Сохраняем в RAM
                    if (currentCandle) {
                        if (!HISTORY_OHLC[symbol][source][tf]) HISTORY_OHLC[symbol][source][tf] = [];
                        HISTORY_OHLC[symbol][source][tf].push({ ...currentCandle });
                        if (HISTORY_OHLC[symbol][source][tf].length > 25) HISTORY_OHLC[symbol][source][tf].shift();
                        // В БД НЕ ПИШЕМ! (Ждем часового бэкапа)
                    }
                    // Новая свеча
                    CURRENT_CANDLES[symbol][source][tf] = {
                        o: price, h: price, l: price, c: price,
                        lastPeriod: currentPeriod
                    };
                } else {
                    // Обновление
                    if (price > currentCandle.h) currentCandle.h = price;
                    if (price < currentCandle.l) currentCandle.l = price;
                    currentCandle.c = price; 
                }
            });
        });
    });
}, 1000);

/**
 * --- MONITORS ---
 */
const initMexcGlobal = () => {
    let ws = null;
    const connect = () => {
        try {
            ws = new WebSocket('wss://contract.mexc.com/edge');
            ws.on('open', () => {
                console.log('[MEXC] Connected');
                ws.send(JSON.stringify({ "method": "sub.tickers", "param": {} }));
            });
            ws.on('message', (data) => {
                const d = safeJson(data);
                if (!d) return;
                if (d.method === 'ping') { ws.send(JSON.stringify({ "method": "pong" })); return; }
                if (d.channel === 'push.tickers' && d.data) {
                    const items = Array.isArray(d.data) ? d.data : [d.data];
                    items.forEach(i => updateData(i.symbol, 'MEXC', i.lastPrice, i.fairPrice));
                }
            });
            ws.on('error', () => {});
            ws.on('close', () => setTimeout(connect, 3000));
        } catch (e) { setTimeout(connect, 5000); }
    };
    connect();
};

const initBinanceGlobal = () => {
    let ws = null;
    const connect = () => {
        try {
            ws = new WebSocket('wss://fstream.binance.com/ws/!ticker@arr'); 
            ws.on('open', () => console.log('[Binance] Connected'));
            ws.on('message', (data) => {
                const arr = safeJson(data);
                if (Array.isArray(arr)) arr.forEach(i => updateData(i.s, 'Binance', i.c));
            });
            ws.on('error', () => {});
            ws.on('close', () => setTimeout(connect, 3000));
        } catch (e) { setTimeout(connect, 5000); }
    };
    connect();
    setInterval(async () => {
        try {
            if(!fetch) return;
            const res = await fetch('https://fapi.binance.com/fapi/v1/premiumIndex');
            const data = await res.json();
            if(Array.isArray(data)) data.forEach(i => updateData(i.symbol, 'Binance', null, i.markPrice));
        } catch(e) {}
    }, 3000);
};

const initBybitGlobal = () => {
    setInterval(async () => {
        try {
            if (!fetch) return;
            const res = await fetch('https://api.bybit.com/v5/market/tickers?category=linear');
            const d = await res.json();
            if (d.result && d.result.list) d.result.list.forEach(i => updateData(i.symbol, 'Bybit', i.lastPrice, i.markPrice));
        } catch(e) {}
    }, 1500);
};

const initGateGlobal = () => {
    setInterval(async () => {
        try {
            if (!fetch) return;
            const res = await fetch('https://api.gateio.ws/api/v4/futures/usdt/tickers');
            const data = await res.json();
            if (Array.isArray(data)) data.forEach(i => updateData(i.contract, 'Gate', i.last, i.mark_price));
        } catch(e) {}
    }, 2000);
};

const initBitgetGlobal = () => {
    setInterval(async () => {
        try {
            if (!fetch) return;
            const res = await fetch('https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES');
            const d = await res.json();
            if (d.data) d.data.forEach(i => updateData(i.symbol, 'Bitget', i.lastPr, i.markPrice));
        } catch(e) {}
    }, 2000);
};

const initOkxGlobal = () => {
    setInterval(async () => {
        try {
            if (!fetch) return;
            const res = await fetch('https://www.okx.com/api/v5/market/tickers?instType=SWAP');
            const d = await res.json();
            if (d.data) d.data.forEach(i => { if (i.instId.endsWith('USDT-SWAP')) updateData(i.instId, 'OKX', i.last); });
        } catch(e) {}
    }, 2000);
    setInterval(async () => {
        try {
            if (!fetch) return;
            const res = await fetch('https://www.okx.com/api/v5/public/mark-price?instType=SWAP');
            const d = await res.json();
            if (d.data) d.data.forEach(i => { if (i.instId.endsWith('USDT-SWAP')) updateData(i.instId, 'OKX', null, i.markPx); });
        } catch(e) {}
    }, 4000);
};

const initBingxGlobal = () => {
    setInterval(async () => {
        try {
            if (!fetch) return;
            const res = await fetch('https://open-api.bingx.com/openApi/swap/v2/quote/ticker');
            const d = await res.json();
            if (d.data) d.data.forEach(i => updateData(i.symbol, 'BingX', i.lastPrice));
        } catch(e) {}
    }, 2000);
    setInterval(async () => {
        try {
            if (!fetch) return;
            const res = await fetch('https://open-api.bingx.com/openApi/swap/v2/quote/premiumIndex');
            const d = await res.json();
            if (d.data) d.data.forEach(i => updateData(i.symbol, 'BingX', null, i.markPrice));
        } catch(e) {}
    }, 4000);
};

const initKucoinGlobal = () => {
    setInterval(async () => {
        try {
            if (!fetch) return;
            const res = await fetch('https://api-futures.kucoin.com/api/v1/allTickers');
            const d = await res.json();
            if (d.data && Array.isArray(d.data)) d.data.forEach(i => updateData(i.symbol, 'Kucoin', i.price));
        } catch(e) {}
    }, 2000);
    setInterval(async () => {
        try {
            if (!fetch) return;
            const res = await fetch('https://api-futures.kucoin.com/api/v1/contracts/active');
            const d = await res.json();
            if (d.data && Array.isArray(d.data)) d.data.forEach(i => updateData(i.symbol, 'Kucoin', null, i.markPrice));
        } catch(e) {}
    }, 5000);
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
    // 1. Сначала восстанавливаем историю
    await restoreHistory();
    // 2. Запускаем планировщик бэкапов (раз в час)
    setInterval(performBackup, CONFIG.BACKUP_INTERVAL_MIN * 30 * 1000);
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
    let symbol = normalizeSymbol(req.query.symbol || '');
    if (!symbol) return res.json({ ok: false });

    const marketData = GLOBAL_PRICES[symbol] || {};
    const fairData = GLOBAL_FAIR[symbol] || {};
    const mexcPrice = marketData['MEXC'] || 0;

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
        allCandles[source] = {};
        TIMEFRAMES.forEach(tf => {
            let sourceCandles = [];
            if (HISTORY_OHLC[symbol] && HISTORY_OHLC[symbol][source] && HISTORY_OHLC[symbol][source][tf]) {
                sourceCandles = [...HISTORY_OHLC[symbol][source][tf]];
            }
            if (CURRENT_CANDLES[symbol] && CURRENT_CANDLES[symbol][source] && CURRENT_CANDLES[symbol][source][tf]) {
                sourceCandles.push(CURRENT_CANDLES[symbol][source][tf]);
            }
            if (sourceCandles.length > 20) sourceCandles = sourceCandles.slice(-20);
            if (sourceCandles.length > 0) allCandles[source][tf] = sourceCandles;
        });
    });

    res.json({ ok: true, mexc: mexcPrice, prices, fairPrices, allCandles, average: globalAverage });
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
#output { white-space: pre; line-height: 1.1; min-height: 280px; position: relative; font-family: monospace; }
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
.exchange-active { background-color: #333; } 
#chart-container {
    margin-top: 10px; width: 100%; max-width: 480px; height: 300px; 
    border: 1px solid #333; background: #050505; position: relative; margin-bottom: 5px; cursor: pointer;
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
<div id="chart-container" onclick="switchTimeframe()"></div>
<div id="fair-price-display"></div>
<input id="dexLink" readonly placeholder="DEX URL" onclick="this.select(); document.execCommand('copy');" />  
<div id="status" style="font-size: 18px; margin-top: 5px; color: #444;"></div>  

<script>  
const allSources = ["MEXC", "Binance", "Bybit", "Gate", "Bitget", "BingX", "OKX", "Kucoin"];
let urlParams = new URLSearchParams(window.location.search);  
let symbol = urlParams.get('symbol')?.toUpperCase() || '';  
let token = urlParams.get('token') || '';  
let chain = urlParams.get('chain');  
let addr = urlParams.get('addr');  
let depositOpen = true;   
let timer = null, blink = false;  

let urlEx = urlParams.get('ex');
let activeSource = 'MEXC'; 
let activeTimeframe = '1m';
const timeframes = ['1m', '15m', '1h'];

if (urlEx) {
    let normalized = urlEx.trim().toLowerCase();
    for (let src of allSources) {
        if (src.toLowerCase() === normalized) { activeSource = src; break; }
    }
}
let manualSourceSelection = !!urlEx; 

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

function switchTimeframe() {
    let idx = timeframes.indexOf(activeTimeframe);
    idx = (idx + 1) % timeframes.length;
    activeTimeframe = timeframes[idx];
    update();
}

function formatP(p) { return (p && p != 0) ? parseFloat(p).toString() : "0"; }  

function renderChart(candles, gap, sourceName) {
    if (!candles || candles.length === 0) {
        chartContainer.innerHTML = '';
        return;
    }
    let minPrice = Infinity, maxPrice = -Infinity;
    candles.forEach(c => {
        if(c.l < minPrice) minPrice = c.l;
        if(c.h > maxPrice) maxPrice = c.h;
    });
    if (minPrice === Infinity) return;

    let volatility = 0;
    if(minPrice > 0) volatility = ((maxPrice - minPrice) / minPrice * 100).toFixed(2);
    
    let range = maxPrice - minPrice;
    if (range === 0) {
        range = maxPrice * 0.001 || 0.001; 
        minPrice = maxPrice - (range/2);
        maxPrice = maxPrice + (range/2);
    }
    
    const padding = range * 0.1; 
    const plotMin = minPrice - padding;
    const plotMax = maxPrice + padding;
    const plotRange = plotMax - plotMin;
    const candleWidth = 100 / 20; 
    const bodyWidth = candleWidth - 1.5;

    let svgHtml = '<svg viewBox="0 0 100 100" preserveAspectRatio="none">';
    svgHtml += \`<text x="50" y="55" text-anchor="middle" dominant-baseline="middle" class="watermark">\${sourceName}</text>\`;
    svgHtml += \`<text x="0.5" y="7" class="chart-text corner-label">\${formatP(maxPrice)}</text>\`;
    svgHtml += \`<text x="0.5" y="99" class="chart-text corner-label">\${formatP(minPrice)}</text>\`;
    svgHtml += \`<text x="99" y="7" text-anchor="end" class="chart-text vol-label">\${activeTimeframe} | \${volatility}%</text>\`;

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
        
        const rawRectH = Math.abs(yClose - yOpen);
        const rectH = rawRectH < 0.2 ? 0.2 : rawRectH;
        
        const rectY = Math.min(yOpen, yClose);
        const rectX = xCenter - (bodyWidth / 2);
        svgHtml += \`<rect x="\${rectX}" y="\${rectY}" width="\${bodyWidth}" height="\${rectH}" class="candle-body \${colorClass}" />\`;

        // СТРЕЛКИ ВНУТРИ
        if (c.h === maxPrice) svgHtml += \`<text x="\${xCenter}" y="\${yHigh + 8}" fill="\${arrowColor}" text-anchor="middle" class="chart-text arrow-label">↑</text>\`;
        if (c.l === minPrice) svgHtml += \`<text x="\${xCenter}" y="\${yLow - 2}" fill="\${arrowColor}" text-anchor="middle" class="chart-text arrow-label">↓</text>\`;
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
        
        let mainPrice = data.prices[activeSource];
        
        if (!manualSourceSelection) {
            if (!mainPrice || mainPrice == 0) {
                if(data.prices['MEXC'] > 0) activeSource = 'MEXC';
                else {
                    for (let ex of allSources) { if (data.prices[ex] > 0) { activeSource = ex; break; } }
                }
                mainPrice = data.prices[activeSource];
            }
        }
        if(!mainPrice) mainPrice = 0;

        let activeFair = (data.fairPrices && data.fairPrices[activeSource]) ? data.fairPrices[activeSource] : 0;
        
        let chartGap = null;
        if (mainPrice > 0 && activeFair > 0) {
            chartGap = ((mainPrice - activeFair) / activeFair) * 100;
        }

        if (activeFair > 0) {
            let fpColor = (chartGap !== null && chartGap >= 0) ? '#ff0000' : '#00ff00';
            let fpSign = (chartGap !== null && chartGap > 0) ? '+' : '';
            let gapText = (chartGap !== null) ? \`(GAP: \${fpSign}\${chartGap.toFixed(2)}%)\` : '';
            fairPriceDisplay.innerHTML = \`Fair: \${formatP(activeFair)} <span style="color:\${fpColor}">\${gapText}</span>\`;
        } else {
            fairPriceDisplay.innerHTML = '';
        }
        
        if (!dexPrice) document.title = symbol + ': ' + formatP(mainPrice);

        let lines = [];
        
        let dotColorClass = depositOpen ? '' : 'closed';  
        let dotSymbol = blink ? '<span class="'+dotColorClass+'">●</span>' : '○';
        let dotHtml = '<span style="display:inline-block; width:15px; text-align:center; font-family:Arial, sans-serif; line-height:1;">' + dotSymbol + '</span>&nbsp;';
        
        let dexDiffHtml = '';
        if (dexPrice > 0 && mainPrice > 0) {
            let diff = ((dexPrice - mainPrice) / mainPrice * 100).toFixed(2);
            dexDiffHtml = ' (' + (diff > 0 ? "+" : "") + diff + '%)';
        }
        lines.push(dotHtml + symbol + ' DEX: ' + formatP(dexPrice) + '<span class="dex-row">' + dexDiffHtml + '</span>');

        let bestEx = null, maxSp = 0;
        allSources.forEach(ex => {
            let p = data.prices[ex];
            if (p > 0 && mainPrice > 0) {
                let sp = Math.abs((p - mainPrice) / mainPrice * 100);
                if (sp > maxSp) { maxSp = sp; bestEx = ex; }
            }
        });

        allSources.forEach(ex => {
            let p = data.prices[ex];
            if (p > 0) {
                let isActive = (ex === activeSource);
                let cls = (ex === bestEx) ? 'class="best"' : ''; 
                
                let mark = isActive ? '◆' : '◇';
                
                let rowBg = isActive ? 'background-color:#333;' : '';
                
                let namePadded = ex.padEnd(8, ' '); 
                let nameHtml = '<span class="exchange-link" onclick="setSource(\\''+ex+'\\')">' + namePadded + '</span>';
                
                let tailHtml = '';
                if (isActive) {
                    if(chartGap !== null && Math.abs(chartGap) > 5) {
                        let gColor = chartGap >= 0 ? '#ff0000' : '#00ff00';
                        let gSign = chartGap > 0 ? '+' : '';
                        tailHtml = \` <span style="color:\${gColor}">(\${gSign}\${chartGap.toFixed(2)}%)</span>\`;
                    }
                } else {
                    if (mainPrice > 0) {
                        let diff = ((p - mainPrice) / mainPrice * 100).toFixed(2);
                        tailHtml = ' (' + (diff > 0 ? "+" : "") + diff + '%)';
                    }
                }

                lines.push('<span style="' + rowBg + '"><span ' + cls + '>' + mark + ' ' + nameHtml + ': ' + formatP(p) + tailHtml + '</span></span>');
            }
        });

        output.innerHTML = lines.join("<br>"); 
        statusEl.textContent = "Last: " + new Date().toLocaleTimeString();  
        
        let candles = (data.allCandles && data.allCandles[activeSource] && data.allCandles[activeSource][activeTimeframe]) 
                      ? data.allCandles[activeSource][activeTimeframe] 
                      : [];
                      
        if(candles.length > 0) {
            renderChart(candles, chartGap, activeSource);
        } else {
             chartContainer.innerHTML = '';
        }

    } catch(e) {}  
}  
async function start() {  
    let val = input.value.trim();  
    if(!val) return;  
    input.blur();
    
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
        
