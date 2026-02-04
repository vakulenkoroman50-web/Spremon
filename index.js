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

/**
 * GLOBAL PRICE CACHE
 * Структура: { "BTC": { Mexc: 100, Binance: 100.5, ... }, "ETH": { ... } }
 */
const GLOBAL_PRICES = {};

// Хелпер для безопасного обновления цены
const updatePrice = (symbol, exchange, price) => {
    if (!symbol || !price) return;
    // Нормализация к виду "BTC" (удаляем суффиксы USDT, SWAP, M и т.д.)
    const s = symbol.toUpperCase()
        .replace(/[-_]/g, '')
        .replace('USDT', '')
        .replace('SWAP', '')
        .replace('M', ''); // KuCoin иногда шлет XBTUSDTM
        
    if (!GLOBAL_PRICES[s]) GLOBAL_PRICES[s] = {};
    GLOBAL_PRICES[s][exchange] = parseFloat(price);
};

const safeJson = (data) => {
    try { return JSON.parse(data); } catch (e) { return null; }
};

/**
 * --- GLOBAL WEBSOCKET MANAGERS ---
 */

// 1. MEXC GLOBAL
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
                    items.forEach(i => updatePrice(i.symbol, 'MEXC', i.lastPrice));
                }
            });
            ws.on('error', () => {});
            ws.on('close', () => setTimeout(connect, 3000));
        } catch (e) { setTimeout(connect, 5000); }
    };
    connect();
};

// 2. BINANCE GLOBAL
const initBinanceGlobal = () => {
    let ws = null;
    const connect = () => {
        try {
            ws = new WebSocket('wss://fstream.binance.com/ws/!ticker@arr'); 
            ws.on('open', () => console.log('[Binance] Connected Global'));
            ws.on('message', (data) => {
                const arr = safeJson(data);
                if (Array.isArray(arr)) {
                    arr.forEach(i => updatePrice(i.s, 'Binance', i.c));
                }
            });
            ws.on('error', () => {});
            ws.on('close', () => setTimeout(connect, 3000));
        } catch (e) { setTimeout(connect, 5000); }
    };
    connect();
};

// 3. KUCOIN GLOBAL (NEW!)
const initKucoinGlobal = async () => {
    let ws = null;
    let pingInterval = null;

    const connect = async () => {
        try {
            // 1. Получаем токен для подключения
            // Используем fetch (он есть глобально в Node 18+)
            const tokenRes = await fetch('https://api-futures.kucoin.com/api/v1/bullet-public', { method: 'POST' });
            const tokenData = await tokenRes.json();
            
            if (!tokenData || !tokenData.data || !tokenData.data.token) {
                console.error('[Kucoin] Failed to get token');
                setTimeout(connect, 5000);
                return;
            }

            const token = tokenData.data.token;
            const endpoint = tokenData.data.instanceServers[0].endpoint;
            
            // 2. Подключаемся
            ws = new WebSocket(`${endpoint}?token=${token}`);
            
            ws.on('open', () => {
                console.log('[Kucoin] Connected Global');
                
                // Запускаем Ping каждые 15 сек (KuCoin требует {type: "ping"})
                pingInterval = setInterval(() => {
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ id: Date.now(), type: 'ping' }));
                    }
                }, 15000);

                // Подписываемся на ВСЕ пары к USDT
                ws.send(JSON.stringify({
                    id: Date.now(),
                    type: 'subscribe',
                    topic: '/contract/instrument:USDT', // Топик для всех USDT фьючерсов
                    response: true
                }));
            });

            ws.on('message', (data) => {
                const d = safeJson(data);
                if (!d) return;
                
                // Ответ на пинг - игнорируем
                if (d.type === 'pong') return;

                // Данные
                if (d.type === 'message' && d.subject === 'match' && d.data) {
                    // Топик 'match' или 'ticker' может отличаться, для instrument:USDT приходит обновление
                    // Обычно data содержит lastTradePrice
                     updatePrice(d.data.symbol, 'Kucoin', d.data.lastTradePrice || d.data.price);
                }
                
                // Иногда KuCoin шлет данные в change
                if (d.subject === 'ticker' && d.data) {
                    updatePrice(d.data.symbol, 'Kucoin', d.data.price || d.data.lastPrice);
                }
                
                // Для топика /contract/instrument:USDT данные выглядят как snapshot
                if (d.data && d.data.lastTradePrice) {
                     updatePrice(d.data.symbol, 'Kucoin', d.data.lastTradePrice);
                }
            });

            ws.on('error', () => {});
            ws.on('close', () => {
                if (pingInterval) clearInterval(pingInterval);
                setTimeout(connect, 3000);
            });

        } catch (e) { 
            console.error('[Kucoin Error]', e);
            setTimeout(connect, 5000); 
        }
    };
    connect();
};

// 4. GATE GLOBAL
const initGateGlobal = () => {
    let ws = null;
    const connect = () => {
        try {
            ws = new WebSocket('wss://fx-ws.gateio.ws/v4/ws/usdt');
            ws.on('open', () => {
                console.log('[Gate] Connected Global');
                ws.send(JSON.stringify({ time: Date.now(), channel: "futures.tickers", event: "subscribe", payload: ["USDT"] }));
            });
            ws.on('message', (data) => {
                const d = safeJson(data);
                if (d && d.event === 'update' && d.result) {
                    (Array.isArray(d.result) ? d.result : [d.result]).forEach(i => {
                        updatePrice(i.contract, 'Gate', i.last);
                    });
                }
            });
            ws.on('error', () => {});
            ws.on('close', () => setTimeout(connect, 3000));
        } catch (e) { setTimeout(connect, 5000); }
    };
    connect();
};

// 5. BYBIT GLOBAL (Polling is more reliable for "ALL" on V5)
const initBybitGlobal = () => {
    setInterval(async () => {
        try {
            const res = await fetch('https://api.bybit.com/v5/market/tickers?category=linear');
            const d = await res.json();
            if (d.result && d.result.list) {
                d.result.list.forEach(i => updatePrice(i.symbol, 'Bybit', i.lastPrice));
            }
        } catch(e) {}
    }, 1500);
};

// 6. BITGET GLOBAL (Polling)
const initBitgetGlobal = () => {
    setInterval(async () => {
        try {
            const res = await fetch('https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES');
            const d = await res.json();
            if (d.data) {
                d.data.forEach(i => updatePrice(i.symbol, 'Bitget', i.lastPr));
            }
        } catch(e) {}
    }, 2000);
};

// 7. OKX GLOBAL (Polling)
const initOkxGlobal = () => {
    setInterval(async () => {
        try {
            const res = await fetch('https://www.okx.com/api/v5/market/tickers?instType=SWAP');
            const d = await res.json();
            if (d.data) {
                d.data.forEach(i => {
                    if (i.instId.endsWith('USDT-SWAP')) updatePrice(i.instId, 'OKX', i.last);
                });
            }
        } catch(e) {}
    }, 2000);
};

// 8. BINGX GLOBAL (Polling)
const initBingxGlobal = () => {
    setInterval(async () => {
        try {
            const res = await fetch('https://open-api.bingx.com/openApi/swap/v2/quote/ticker');
            const d = await res.json();
            if (d.data) {
                d.data.forEach(i => updatePrice(i.symbol, 'BingX', i.lastPrice));
            }
        } catch(e) {}
    }, 2000);
};

// ЗАПУСК ВСЕХ МОНИТОРОВ
initMexcGlobal();
initBinanceGlobal();
initKucoinGlobal(); // <-- NEW WEBSOCKET
initGateGlobal();
initBybitGlobal();
initBitgetGlobal();
initOkxGlobal();
initBingxGlobal();

// API CONFIG
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

let fetch;
(async () => {
    fetch = (await import('node-fetch')).default;
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

// --- API ENDPOINTS ---

app.get('/api/resolve', authMiddleware, async (req, res) => {
    const symbol = (req.query.symbol || '').toUpperCase();
    const data = await mexcPrivateRequest("/api/v3/capital/config/getall");
    
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

    res.json({
        ok: true,
        chain: bestPair?.chainId,
        addr: bestPair?.pairAddress,
        url: bestPair?.url,
        depositOpen
    });
});

app.get('/api/all', authMiddleware, async (req, res) => {
    const symbol = (req.query.symbol || '').toUpperCase().replace('USDT', '');
    if (!symbol) return res.json({ ok: false });

    // Берем данные из ГЛОБАЛЬНОГО кэша
    const marketData = GLOBAL_PRICES[symbol] || {};
    
    const mexcPrice = marketData['MEXC'] || 0;

    // Формируем ответ
    const prices = {};
    EXCHANGES_ORDER.forEach(ex => {
        prices[ex] = marketData[ex] || 0;
    });

    res.json({ ok: true, mexc: mexcPrice, prices });
});

app.get('/', (req, res) => {
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
.control-row { display: flex; gap: 5px; margin-top: 0; }
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
const output = document.getElementById("output");  
const input = document.getElementById("symbolInput");  
const dexLink = document.getElementById("dexLink");  
const statusEl = document.getElementById("status");  
const urlInput = document.getElementById("urlInput");
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
    window.open(targetUrl, '_blank');
}
function formatP(p) { return (p && p != 0) ? parseFloat(p).toString() : "0"; }  
async function update() {  
    if (!symbol) return;  
    let dexPrice = 0;  
    if (chain && addr) {  
        try {  
            const r = await fetch('https://api.dexscreener.com/latest/dex/pairs/' + chain + '/' + addr);  
            const d = await r.json();  
            if (d.pair) {  
                dexPrice = parseFloat(d.pair.priceUsd);  
                document.title = symbol + ': ' + d.pair.priceUsd;  
                dexLink.value = d.pair.url;  
            }  
        } catch(e) {}  
    }  
    blink = !blink;  
    try {  
        const res = await fetch('/api/all?symbol=' + symbol + '&token=' + token);  
        if (res.status === 403) {  
            output.innerHTML = "<span style='color:red'>Доступ запрещён!</span>";  
            if(timer) clearInterval(timer);  
            return;  
        }  
        const data = await res.json();  
        if(!data.ok) return;  
        let dotColorClass = depositOpen ? '' : 'closed';  
        let dot = blink ? '<span class="blink-dot '+dotColorClass+'">●</span>' : '○';  
        let lines = [dot + ' ' + symbol + ' MEXC: ' + formatP(data.mexc)];  
        if (dexPrice > 0) {  
            let diff = ((dexPrice - data.mexc) / data.mexc * 100).toFixed(2);  
            lines.push('<span class="dex-row">◇ DEX     : ' + formatP(dexPrice) + ' (' + (diff > 0 ? "+" : "") + diff + '%)</span>');  
        }  
        let bestEx = null, maxSp = 0;  
        exchangesOrder.forEach(ex => {  
            let p = data.prices[ex];  
            if (p > 0) {  
                let sp = Math.abs((p - data.mexc) / data.mexc * 100);  
                if (sp > maxSp) { maxSp = sp; bestEx = ex; }  
            }  
        });  
        exchangesOrder.forEach(ex => {  
            let p = data.prices[ex];  
            if (p > 0) {  
                let diff = ((p - data.mexc) / data.mexc * 100).toFixed(2);  
                let cls = (ex === bestEx) ? 'class="best"' : '';  
                let mark = (ex === bestEx) ? '◆' : '◇';  
                lines.push('<span ' + cls + '>' + mark + ' ' + ex.padEnd(8, ' ') + ': ' + formatP(p) + ' (' + (diff > 0 ? "+" : "") + diff + '%)</span>');  
            }  
        });  
        output.innerHTML = lines.join("<br>");  
        statusEl.textContent = "Last: " + new Date().toLocaleTimeString();  
    } catch(e) {}  
}  
async function start() {  
    let val = input.value.trim();  
    if(!val) return;  
    if (!token) { output.innerHTML = "<span style='color:red'>Доступ запрещён!</span>"; return; }  
    if(timer) clearInterval(timer);  
    output.innerHTML = "Поиск...";  
    if (val.includes("dexscreener.com")) {  
        try {  
            const parts = val.split('/');  
            chain = parts[parts.length - 2];  
            addr = parts[parts.length - 1].split('?')[0];  
            const dsRes = await fetch('https://api.dexscreener.com/latest/dex/pairs/' + chain + '/' + addr);  
            const dsData = await dsRes.json();  
            if (dsData.pair) {  
                symbol = dsData.pair.baseToken.symbol.toUpperCase();  
                input.value = symbol;  
                dexLink.value = dsData.pair.url;  
            }  
        } catch(e) { output.innerHTML = "Ошибка ссылки!"; return; }  
    } else { symbol = val.toUpperCase(); }  
    try {  
        const res = await fetch('/api/resolve?symbol=' + symbol + '&token=' + token);  
        if (res.status === 403) { output.innerHTML = "<span style='color:red'>Доступ запрещён!</span>"; return; }  
        const d = await res.json();  
        if (d.ok) {   
            chain = d.chain; addr = d.addr; dexLink.value = d.url || ''; depositOpen = d.depositOpen;   
        } else { depositOpen = true; }  
    } catch(e) {}  
    const url = new URL(window.location);  
    url.searchParams.set('symbol', symbol);  
    if(chain) url.searchParams.set('chain', chain);  
    if(addr) url.searchParams.set('addr', addr);  
    window.history.replaceState({}, '', url);  
    update();  
    timer = setInterval(update, 1000);  
}  
document.getElementById("startBtn").onclick = start;  
document.getElementById("mexcBtn").onclick = function() {
    let val = input.value.trim().toUpperCase();
    if(val) window.location.href = "mxcappscheme://kline?extra_page_name=其他&trade_pair=" + val + "_USDT&contract=1";
};
input.addEventListener("keypress", (e) => { if(e.key === "Enter") start(); });  
if (urlParams.get('symbol')) start();  
else if (!token) output.innerHTML = "<span style='color:red'>Доступ запрещён!</span>";  
</script>  
</body>  
</html>  
    `);
});

app.listen(CONFIG.PORT, () => console.log(`🚀 Server running on port ${CONFIG.PORT}`));
                
