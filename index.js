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
const ALL_SOURCES = ["MEXC", ...EXCHANGES_ORDER];

/**
 * GLOBAL DATA CACHE
 */
const GLOBAL_PRICES = {}; // { "BTC": { "MEXC": 100, "Binance": 100.1 } }
const GLOBAL_FAIR = {};   // { "BTC": { "MEXC": 100.05, "Binance": 100.12 } }
let MEXC_CONFIG_CACHE = null;

// Хранилище свечей
const HISTORY_OHLC = {}; 
const CURRENT_CANDLES = {};

// --- УТИЛИТА НОРМАЛИЗАЦИИ СИМВОЛА ---
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

// --- ФУНКЦИЯ ОБНОВЛЕНИЯ ЦЕНЫ И FAIR PRICE ---
const updateData = (rawSymbol, exchange, price, fairPrice = null) => {
    const s = normalizeSymbol(rawSymbol);
    if (!s) return;

    // Обновляем Last Price
    if (price) {
        if (!GLOBAL_PRICES[s]) GLOBAL_PRICES[s] = {};
        GLOBAL_PRICES[s][exchange] = parseFloat(price);
    }

    // Обновляем Fair Price (Mark Price)
    if (fairPrice) {
        if (!GLOBAL_FAIR[s]) GLOBAL_FAIR[s] = {};
        GLOBAL_FAIR[s][exchange] = parseFloat(fairPrice);
    }
};

// --- МОДУЛЬ ИСТОРИИ (OHLC) ---
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
 * --- GLOBAL MONITORS ---
 */

// 1. MEXC GLOBAL (WS)
const initMexcGlobal = () => {
    let ws = null;
    const connect = () => {
        try {
            ws = new WebSocket('wss://contract.mexc.com/edge');
            ws.on('open', () => {
                console.log('[MEXC] Connected Global');
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

// 2. BINANCE GLOBAL (WS + REST)
const initBinanceGlobal = () => {
    // WS для Last Price (быстро)
    let ws = null;
    const connect = () => {
        try {
            ws = new WebSocket('wss://fstream.binance.com/ws/!ticker@arr'); 
            ws.on('open', () => console.log('[Binance] Connected Global'));
            ws.on('message', (data) => {
                const arr = safeJson(data);
                if (Array.isArray(arr)) {
                    arr.forEach(i => updateData(i.s, 'Binance', i.c)); // Только Last Price
                }
            });
            ws.on('error', () => {});
            ws.on('close', () => setTimeout(connect, 3000));
        } catch (e) { setTimeout(connect, 5000); }
    };
    connect();

    // REST для Mark Price (раз в 3 сек)
    setInterval(async () => {
        try {
            if(!fetch) return;
            const res = await fetch('https://fapi.binance.com/fapi/v1/premiumIndex');
            const data = await res.json();
            if(Array.isArray(data)) {
                data.forEach(i => updateData(i.symbol, 'Binance', null, i.markPrice));
            }
        } catch(e) {}
    }, 3000);
};

// 3. BYBIT (REST - Last + Mark)
const initBybitGlobal = () => {
    setInterval(async () => {
        try {
            if (!fetch) return;
            const res = await fetch('https://api.bybit.com/v5/market/tickers?category=linear');
            const d = await res.json();
            if (d.result && d.result.list) {
                d.result.list.forEach(i => updateData(i.symbol, 'Bybit', i.lastPrice, i.markPrice));
            }
        } catch(e) {}
    }, 1500);
};

// 4. GATE (REST - Last + Mark)
const initGateGlobal = () => {
    setInterval(async () => {
        try {
            if (!fetch) return;
            const res = await fetch('https://api.gateio.ws/api/v4/futures/usdt/tickers');
            const data = await res.json();
            if (Array.isArray(data)) {
                data.forEach(i => updateData(i.contract, 'Gate', i.last, i.mark_price));
            }
        } catch(e) {}
    }, 2000);
};

// 5. BITGET (REST - Last + Mark)
const initBitgetGlobal = () => {
    setInterval(async () => {
        try {
            if (!fetch) return;
            const res = await fetch('https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES');
            const d = await res.json();
            if (d.data) {
                d.data.forEach(i => updateData(i.symbol, 'Bitget', i.lastPr, i.markPr));
            }
        } catch(e) {}
    }, 2000);
};

// 6. OKX (REST - Last + Mark отдельно)
const initOkxGlobal = () => {
    // Last Price
    setInterval(async () => {
        try {
            if (!fetch) return;
            const res = await fetch('https://www.okx.com/api/v5/market/tickers?instType=SWAP');
            const d = await res.json();
            if (d.data) {
                d.data.forEach(i => {
                    if (i.instId.endsWith('USDT-SWAP')) updateData(i.instId, 'OKX', i.last);
                });
            }
        } catch(e) {}
    }, 2000);

    // Mark Price (отдельный запрос)
    setInterval(async () => {
        try {
            if (!fetch) return;
            const res = await fetch('https://www.okx.com/api/v5/public/mark-price?instType=SWAP');
            const d = await res.json();
            if (d.data) {
                d.data.forEach(i => {
                    if (i.instId.endsWith('USDT-SWAP')) updateData(i.instId, 'OKX', null, i.markPx);
                });
            }
        } catch(e) {}
    }, 4000); // Чуть реже
};

// 7. BINGX (REST - Last + Mark)
const initBingxGlobal = () => {
    setInterval(async () => {
        try {
            if (!fetch) return;
            const res = await fetch('https://open-api.bingx.com/openApi/swap/v2/quote/ticker');
            const d = await res.json();
            if (d.data) {
                d.data.forEach(i => updateData(i.symbol, 'BingX', i.lastPrice, i.markPrice));
            }
        } catch(e) {}
    }, 2000);
};

// 8. KUCOIN (REST - Last + Mark отдельно)
const initKucoinGlobal = () => {
    // Last
    setInterval(async () => {
        try {
            if (!fetch) return;
            const res = await fetch('https://api-futures.kucoin.com/api/v1/allTickers');
            const d = await res.json();
            if (d.data && Array.isArray(d.data)) {
                d.data.forEach(i => updateData(i.symbol, 'Kucoin', i.price));
            }
        } catch(e) {}
    }, 2000);
    
    // Mark
    setInterval(async () => {
        try {
            if (!fetch) return;
            const res = await fetch('https://api-futures.kucoin.com/api/v1/contracts/active');
            const d = await res.json();
            if (d.data && Array.isArray(d.data)) {
                d.data.forEach(i => updateData(i.symbol, 'Kucoin', null, i.markPrice));
            }
        } catch(e) {}
    }, 5000);
};

// ЗАПУСК МОНИТОРОВ
initMexcGlobal();
initBinanceGlobal();
initBybitGlobal();
initGateGlobal();
initBitgetGlobal();
initOkxGlobal();
initBingxGlobal();
initKucoinGlobal();


// --- SERVER SETUP ---

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
    if (req.query.token !== CONFIG.SECRET_TOKEN) {
        return res.status(403).json({ ok: false, msg: "AUTH_ERR" });
    }
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
        const res = await fetch(`${CONFIG.MEXC.BASE_URL}${path}?${query}`, {
            headers: { 'X-MEXC-APIKEY': CONFIG.MEXC.KEY }
        });
        return await res.json();
    } catch (e) { return null; }
}

async function updateMexcConfigCache() {
    try {
        if (!fetch) return;
        const data = await mexcPrivateRequest("/api/v3/capital/config/getall");
        if (data && Array.isArray(data)) MEXC_CONFIG_CACHE = data;
    } catch (e) {}
}
setInterval(updateMexcConfigCache, 60000);

// --- API ROUTES ---

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
    const fairData = GLOBAL_FAIR[symbol] || {}; // Данные по Fair Price
    
    const mexcPrice = marketData['MEXC'] || 0;

    const prices = {};
    const fairPrices = {};

    ALL_SOURCES.forEach(source => {
        prices[source] = marketData[source] || 0;
        fairPrices[source] = fairData[source] || 0;
    });

    const allCandles = {};
    ALL_SOURCES.forEach(source => {
        let sourceCandles = [];
        if (HISTORY_OHLC[symbol] && HISTORY_OHLC[symbol][source]) {
            sourceCandles = [...HISTORY_OHLC[symbol][source]];
        }
        if (CURRENT_CANDLES[symbol] && CURRENT_CANDLES[symbol][source]) {
            sourceCandles.push(CURRENT_CANDLES[symbol][source]);
        }
        if (sourceCandles.length > 20) sourceCandles = sourceCandles.slice(-20);
        
        if (sourceCandles.length > 0) {
            allCandles[source] = sourceCandles;
        }
    });

    // Отдаем цены и fair цены
    res.json({ ok: true, mexc: mexcPrice, prices, fairPrices, allCandles });
});

app.get('/', (req, res) => {
    if (req.query.token !== CONFIG.SECRET_TOKEN) {
        return res.status(403).send("Доступ запрещён!");
    }

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
#startBtn { font-family: monospace; font-size: 28px; background: #222; color: #fff; border: 1px solid #444; cursor: pointer; padding: 0 10px; }
#mexcBtn { font-family: monospace; font-size: 28px; background: #222; color: #fff; border: 1px solid #444; cursor: pointer; padding: 0 10px; }
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
.exchange-active { background-color: #333; border-radius: 4px; } 

#chart-container {
    margin-top: 10px;
    width: 100%;
    max-width: 480px;
    height: 300px; 
    border: 1px solid #333;
    background: #050505;
    position: relative;
    margin-bottom: 5px;
}
#fair-price-display {
    margin-top: 2px;
    font-size: 14px;
    color: #888;
    text-align: right;
    max-width: 480px;
    font-family: Arial, sans-serif;
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
const exchangesOrder = ["Binance", "Bybit", "Gate", "Bitget", "BingX", "OKX", "Kucoin"];  
let urlParams = new URLSearchParams(window.location.search);  
let symbol = urlParams.get('symbol')?.toUpperCase() || '';  
let token = urlParams.get('token') || '';  
let chain = urlParams.get('chain');  
let addr = urlParams.get('addr');  
let depositOpen = true;   
let timer = null, blink = false;  
let activeSource = 'MEXC';
let manualSourceSelection = false;

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
    let targetUrl;
    if (isUrl) {
        targetUrl = query;
        if (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://")) targetUrl = "https://" + targetUrl;
    } else {
        targetUrl = "https://www.google.com/search?q=" + encodeURIComponent(query);
    }
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

    let minPrice = Infinity;
    let maxPrice = -Infinity;
    
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

    const w = 100; 
    
    const candleWidth = w / 20; 
    const gapC = 1.5; 
    const bodyWidth = candleWidth - gapC;

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

        if (c.h === maxPrice) {
            const arrowY = rectY + (rectH / 2) + 2; 
            svgHtml += \`<text x="\${xCenter}" y="\${arrowY}" fill="\${arrowColor}" text-anchor="middle" class="chart-text arrow-label">↑</text>\`;
        }
        if (c.l === minPrice) {
            const arrowY = rectY + (rectH / 2) + 2;
            svgHtml += \`<text x="\${xCenter}" y="\${arrowY}" fill="\${arrowColor}" text-anchor="middle" class="chart-text arrow-label">↓</text>\`;
        }
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
                    let spaceForName = maxLen - pStr.length - 2;
                    if (spaceForName < 3) spaceForName = 3;
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
        if (res.status === 403) {  
            window.location.reload(); 
            return;  
        }  
        const data = await res.json();  
        if(!data.ok) return;  
        
        let mainPrice = data.mexc;
        
        if (!manualSourceSelection) {
            if (mainPrice > 0) activeSource = 'MEXC';
            else {
                for (let ex of exchangesOrder) {
                    if (data.prices[ex] > 0) { activeSource = ex; break; }
                }
            }
        }
        
        // Цена активной биржи
        let activePrice = (activeSource === 'MEXC') ? mainPrice : data.prices[activeSource];
        if (!activePrice || activePrice == 0) activePrice = mainPrice;

        // Fair Price активной биржи
        let activeFair = (data.fairPrices && data.fairPrices[activeSource]) ? data.fairPrices[activeSource] : 0;

        // Расчет GAP для ГРАФИКА
        let chartGap = null;
        if (activePrice > 0 && activeFair > 0) {
            chartGap = ((activePrice - activeFair) / activeFair) * 100;
        }

        // --- ВЫВОД FAIR PRICE ПОД ГРАФИКОМ ---
        if (activeFair > 0) {
            let fpColor = (chartGap !== null && chartGap >= 0) ? '#ff0000' : '#00ff00';
            let fpSign = (chartGap !== null && chartGap > 0) ? '+' : '';
            let gapText = (chartGap !== null) ? \`(GAP: \${fpSign}\${chartGap.toFixed(2)}%)\` : '';
            fairPriceDisplay.innerHTML = \`Fair: \${formatP(activeFair)} <span style="color:\${fpColor}">\${gapText}</span>\`;
        } else {
            fairPriceDisplay.innerHTML = '';
        }
        
        if (!dexPrice) {
             let pStr = formatP(mainPrice);
             let sStr = symbol;
             const maxLen = 18; 
             if ((sStr.length + pStr.length + 2) > maxLen) {
                let spaceForName = maxLen - pStr.length - 2;
                if (spaceForName < 3) spaceForName = 3;
                sStr = sStr.substring(0, spaceForName);
            }
            document.title = sStr + ': ' + pStr;
        }

        let dotColorClass = depositOpen ? '' : 'closed';  
        
        let dotSymbol = blink ? '<span class="'+dotColorClass+'">●</span>' : '○';
        let dotHtml = '<span style="display:inline-block; width:15px; text-align:center; font-family:Arial, sans-serif; line-height:1;">' + dotSymbol + '</span>&nbsp;';
        
        let activeClassMexc = (activeSource === 'MEXC') ? 'exchange-active' : '';
        let mexcPart = '<span class="exchange-link '+activeClassMexc+'" onclick="setSource(\\'MEXC\\')">' + symbol + ' MEXC</span>: ' + formatP(mainPrice);
        
        let mexcLine = dotHtml + mexcPart;
        
        if (activeSource !== 'MEXC' && activePrice > 0 && mainPrice > 0) {
             let diff = ((mainPrice - activePrice) / activePrice * 100).toFixed(2);
             mexcLine += ' (' + (diff > 0 ? "+" : "") + diff + '%)';
        }

        // GAP MEXC для строки MEXC (если есть данные)
        let mexcFair = (data.fairPrices && data.fairPrices['MEXC']) ? data.fairPrices['MEXC'] : 0;
        let mexcGapVal = 0;
        if (mainPrice > 0 && mexcFair > 0) {
            mexcGapVal = ((mainPrice - mexcFair) / mexcFair) * 100;
            if (Math.abs(mexcGapVal) > 5) {
                let gapColor = mexcGapVal >= 0 ? '#ff0000' : '#00ff00';
                let gapSign = mexcGapVal > 0 ? '+' : '';
                mexcLine += \` <span style="color:\${gapColor}">(\${gapSign}\${mexcGapVal.toFixed(2)}%)</span>\`;
            }
        }

        let lines = [mexcLine];  
        
        if (dexPrice > 0) {  
            let diff = ((dexPrice - activePrice) / activePrice * 100).toFixed(2);  
            lines.push('<span class="dex-row">◇ DEX     : ' + formatP(dexPrice) + ' (' + (diff > 0 ? "+" : "") + diff + '%)</span>');  
        }  
        let bestEx = null, maxSp = 0;  
        exchangesOrder.forEach(ex => {  
            let p = data.prices[ex];  
            if (p > 0) {  
                let sp = Math.abs((p - activePrice) / activePrice * 100);  
                if (sp > maxSp) { maxSp = sp; bestEx = ex; }  
            }  
        });  
        
        exchangesOrder.forEach(ex => {  
            let p = data.prices[ex];  
            if (p > 0) {  
                let diff = ((p - activePrice) / activePrice * 100).toFixed(2);  
                let cls = (ex === bestEx) ? 'class="best"' : '';  
                let mark = (ex === bestEx) ? '◆' : '◇';  
                let activeClass = (activeSource === ex) ? 'exchange-active' : '';
                let nameHtml = '<span class="exchange-link '+activeClass+'" onclick="setSource(\\''+ex+'\\')">' + ex.padEnd(8, ' ') + '</span>';
                
                lines.push('<span ' + cls + '>' + mark + ' ' + nameHtml + ': ' + formatP(p) + ' (' + (diff > 0 ? "+" : "") + diff + '%)</span>');  
            }  
        });  
        
        output.innerHTML = lines.join("<br>"); 
        statusEl.textContent = "Last: " + new Date().toLocaleTimeString();  
        
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
    manualSourceSelection = false;
    activeSource = 'MEXC';

    if(timer) clearInterval(timer);  
    output.innerHTML = "Поиск...";  
    
    if (val.includes("dexscreener.com")) {  
        try {  
            const parts = val.split('/');  
            chain = parts[parts.length - 2];  
            addr = parts[parts.length - 1].split('?')[0];  
            fetch('https://api.dexscreener.com/latest/dex/pairs/' + chain + '/' + addr)
                .then(r => r.json())
                .then(dsData => {
                     if (dsData.pair) {  
                        symbol = dsData.pair.baseToken.symbol.toUpperCase();  
                        input.value = symbol;  
                        dexLink.value = dsData.pair.url;  
                    } 
                });
        } catch(e) { output.innerHTML = "Ошибка ссылки!"; return; }  
    } else {  
        symbol = val.toUpperCase();  
    }  

    const url = new URL(window.location);  
    url.searchParams.set('symbol', symbol);  
    window.history.replaceState({}, '', url);  

    update();  
    timer = setInterval(update, 1000);  

    try {  
        const res = await fetch('/api/resolve?symbol=' + encodeURIComponent(symbol) + '&token=' + token);  
        if (res.status === 403) return;  
        const d = await res.json();  
        if (d.ok) {   
            chain = d.chain;   
            addr = d.addr;   
            dexLink.value = d.url || '';   
            depositOpen = d.depositOpen;   
            
            if(chain) url.searchParams.set('chain', chain);  
            if(addr) url.searchParams.set('addr', addr);  
            window.history.replaceState({}, '', url);  
        } else {  
            depositOpen = true;  
        }  
    } catch(e) {}  
}  
document.getElementById("startBtn").onclick = start;  
document.getElementById("mexcBtn").onclick = function() {
    let val = input.value.trim().toUpperCase();
    if(val) window.location.href = "mxcappscheme://kline?extra_page_name=其他&trade_pair=" + val + "_USDT&contract=1";
};
input.addEventListener("keypress", (e) => { 
    if(e.key === "Enter") {
        input.blur(); 
        start(); 
    }
});  

if (urlParams.get('symbol')) start();  
</script>  
</body>  
</html>  
    `); 
});

app.listen(CONFIG.PORT, () => console.log(`🚀 Server running on port ${CONFIG.PORT}`));
                
