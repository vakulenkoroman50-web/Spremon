const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const app = express();

app.use(cors());
app.use(express.json());

// --- КОНФИГУРАЦИЯ ---
const PORT = process.env.PORT || 3000;
const SECRET_TOKEN = process.env.SECRET_TOKEN; 
const MEXC_API_KEY = process.env.MEXC_API_KEY || '';
const MEXC_API_SECRET = process.env.MEXC_API_SECRET || '';

const exchangesOrder = ["Binance", "Bybit", "Gate", "Bitget", "BingX", "OKX", "Kucoin"];

function signMexc(params) {
    const queryString = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
    return crypto.createHmac('sha256', MEXC_API_SECRET).update(queryString).digest('hex');
}

async function mexcPrivateGet(path, params = {}) {
    if (!MEXC_API_KEY || !MEXC_API_SECRET) return null;
    try {
        const fetch = (await import('node-fetch')).default;
        params.timestamp = Date.now();
        params.signature = signMexc(params);
        const query = new URLSearchParams(params).toString();
        const res = await fetch(`https://api.mexc.com${path}?${query}`, {
            headers: { 'X-MEXC-APIKEY': MEXC_API_KEY }
        });
        return await res.json();
    } catch (e) { return null; }
}

async function getMexcDepositStatus(symbol) {
    if (!MEXC_API_KEY || !MEXC_API_SECRET) return true;
    try {
        const data = await mexcPrivateGet("/api/v3/capital/config/getall");
        if (!data || !Array.isArray(data)) return true;
        const token = data.find(t => t.coin === symbol);
        if (!token) return true;
        if (token.depositAllEnable === false) return false;
        if (token.networkList && token.networkList.length > 0) {
            return token.networkList.some(network => network.depositEnable === true);
        }
        return true;
    } catch (e) { return true; }
}

function formatPrice(price) {
    if (!price || price == 0) return "0".padStart(15, ' ');
    const num = parseFloat(price);
    let decimals = num >= 1000 ? 2 : num >= 1 ? 4 : num >= 0.1 ? 5 : num >= 0.01 ? 6 : num >= 0.001 ? 7 : 8;
    let formatted = num.toFixed(decimals);
    const parts = formatted.split('.');
    if (parts.length === 2) {
        let [int, dec] = parts;
        while (dec.length < decimals) { dec += '0'; }
        formatted = int + '.' + dec;
    }
    return formatted.padStart(15, ' ');
}

app.get('/api/resolve', async (req, res) => {
    if (!SECRET_TOKEN || req.query.token !== SECRET_TOKEN) return res.status(403).json({ok:false});
    const symbol = (req.query.symbol || '').toUpperCase();
    const data = await mexcPrivateGet("/api/v3/capital/config/getall");
    if (!data || !Array.isArray(data)) return res.json({ ok: false });
    const token = data.find(t => t.coin === symbol);
    if (!token || !token.networkList) return res.json({ ok: false });
    const depositOpen = token.depositAllEnable !== false && token.networkList.some(network => network.depositEnable === true);
    let bestPair = null;
    const fetch = (await import('node-fetch')).default;
    for (const net of token.networkList) {
        if (!net.contract) continue;
        try {
            const dsRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${net.contract}`);
            const dsData = await dsRes.json();
            if (dsData.pairs) {
                dsData.pairs.forEach(pair => {
                    if (!bestPair || (parseFloat(pair.volume?.h24 || 0) > parseFloat(bestPair.volume?.h24 || 0))) bestPair = pair;
                });
            }
        } catch (e) {}
    }
    res.json({ ok: !!bestPair, chain: bestPair?.chainId, addr: bestPair?.pairAddress, url: bestPair?.url, depositOpen });
});

async function getMexcPrice(symbol) {
    try {
        const fetch = (await import('node-fetch')).default;
        const res = await fetch(`https://contract.mexc.com/api/v1/contract/ticker?symbol=${symbol}_USDT`);
        const d = await res.json();
        return parseFloat(d.data?.lastPrice) || 0;
    } catch (e) { return 0; }
}

async function getExPrice(ex, symbol) {
    const pair = symbol + 'USDT';
    try {
        const fetch = (await import('node-fetch')).default;
        let url, p;
        switch(ex) {
            case 'Binance': url = `https://fapi.binance.com/fapi/v1/ticker/price?symbol=${pair}`; break;
            case 'Kucoin': url = `https://api-futures.kucoin.com/api/v1/ticker?symbol=${symbol==='BTC'?'XBT':symbol}USDTM`; break;
            case 'BingX': url = `https://open-api.bingx.com/openApi/swap/v2/quote/ticker?symbol=${symbol}-USDT`; break;
            case 'Bybit': url = `https://api.bybit.com/v5/market/tickers?category=linear&symbol=${pair}`; break;
            case 'Bitget': url = `https://api.bitget.com/api/v2/mix/market/ticker?symbol=${pair}&productType=USDT-FUTURES`; break;
            case 'OKX': url = `https://www.okx.com/api/v5/market/ticker?instId=${symbol}-USDT-SWAP`; break;
            case 'Gate': url = `https://api.gateio.ws/api/v4/futures/usdt/tickers?contract=${symbol}_USDT`; break;
        }
        const r = await fetch(url);
        const d = await r.json();
        if (ex==='Binance') p=d.price;
        else if (ex==='Kucoin') p=d.data?.price;
        else if (ex==='BingX') p=d.data?.lastPrice;
        else if (ex==='Bybit') p=d.result?.list?.[0]?.lastPrice;
        else if (ex==='Bitget') p=d.data?.[0]?.lastPr;
        else if (ex==='OKX') p=d.data?.[0]?.last;
        else if (ex==='Gate') p=d.last || (d[0] && d[0].last);
        return parseFloat(p) || 0;
    } catch(e) { return 0; }
}

app.get('/api/all', async (req, res) => {
    if (!SECRET_TOKEN || req.query.token !== SECRET_TOKEN) return res.status(403).json({ok:false});
    const symbol = (req.query.symbol || '').toUpperCase();
    if(!symbol) return res.json({ok:false});
    const mexc = await getMexcPrice(symbol);
    const prices = {};
    await Promise.all(exchangesOrder.map(async ex => { prices[ex] = await getExPrice(ex, symbol); }));
    const depositOpen = await getMexcDepositStatus(symbol);
    res.json({ 
        ok: true, 
        mexc, 
        prices,
        mexcFormatted: formatPrice(mexc),
        pricesFormatted: Object.fromEntries(Object.entries(prices).map(([k, v]) => [k, formatPrice(v)])),
        depositOpen 
    });
});

app.get('/', (req, res) => {
    if (!SECRET_TOKEN || req.query.token !== SECRET_TOKEN) {
        return res.status(403).send("<h1>Доступ запрещён</h1>");
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
    #output { white-space: pre; line-height: 1.1; min-height: 200px; }
    .control-row { display: flex; gap: 5px; margin-top: 15px; border-top: 1px solid #222; padding-top: 15px; }
    #symbolInput { font-family: monospace; font-size: 28px; width: 100%; max-width: 400px; background: #000; color: #fff; border: 1px solid #444; padding: 5px; }
    #startBtn { font-family: monospace; font-size: 28px; background: #222; color: #fff; border: 1px solid #444; cursor: pointer; padding: 0 15px; }
    #dexLink { font-family: monospace; font-size: 16px; width: 100%; background: #111; color: #888; border: 1px solid #333; padding: 5px; cursor: pointer; margin-top: 10px; }
    .dex-row { color: #00ff00; }
    .best { color: #ffff00; }
    .blink-dot { animation: blink 1s infinite; display: inline-block; }
    .red-blink { animation: blink-red 1s infinite; display: inline-block; color: #ff0000; }
    @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }
    @keyframes blink-red { 0%, 100% { color: #ff0000; } 50% { color: #990000; } }
    </style>
    </head>
    <body>
      <div id="output">Готов к работе</div>

      <div class="control-row">
        <input id="symbolInput" value="${initialSymbol}" autocomplete="off" placeholder="TICKER" onfocus="this.select()" />
        <button id="startBtn">СТАРТ</button>
      </div>

      <input id="dexLink" readonly placeholder="DEX URL" onclick="this.select(); document.execCommand('copy');" />
      <div id="status" style="font-size: 18px; margin-top: 5px; color: #444;"></div>

    <script>
    const exchangesOrder = ["Binance", "Bybit", "Gate", "Bitget", "BingX", "OKX", "Kucoin"];
    let urlParams = new URLSearchParams(window.location.search);
    let symbol = '';
    let token = urlParams.get('token');
    let chain = urlParams.get('chain');
    let addr = urlParams.get('addr');
    let mexcDepositOpen = true;
    let timer=null, blink=false;

    const output=document.getElementById("output");
    const input=document.getElementById("symbolInput");
    const dexLink=document.getElementById("dexLink");
    const statusEl=document.getElementById("status");

    function formatP(p) { 
        if(!p || p == 0) return "0".padStart(15, ' ');
        const num = parseFloat(p);
        let decimals = num >= 1000 ? 2 : num >= 1 ? 4 : num >= 0.1 ? 5 : num >= 0.01 ? 6 : num >= 0.001 ? 7 : 8;
        let formatted = num.toFixed(decimals);
        const parts = formatted.split('.');
        if (parts.length === 2) {
            let [int, dec] = parts;
            while (dec.length < decimals) { dec += '0'; }
            formatted = int + '.' + dec;
        }
        return formatted.padStart(15, ' ');
    }

    async function update() {
        if (!symbol && !(chain && addr)) return;
        blink = !blink;
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

        try {
            const res = await fetch('/api/all?symbol=' + symbol + '&token=' + token);
            const data = await res.json();
            if(!data.ok) return;

            mexcDepositOpen = data.depositOpen !== false;
            let dot = mexcDepositOpen 
                ? (blink ? '<span class="blink-dot">●</span>' : '○')
                : (blink ? '<span class="red-blink">●</span>' : '<span style="color:#ff0000">○</span>');
            
            let lines = [];
            const mexcDisplay = data.mexcFormatted || formatP(data.mexc);
            // Выравнивание "MEXC    " (8 символов)
            lines.push(dot + ' ' + symbol.padEnd(4, ' ') + ' MEXC    : ' + mexcDisplay);

            if (dexPrice > 0) {
                let diff = ((dexPrice - data.mexc) / data.mexc * 100).toFixed(2);
                // Выравнивание "DEX     " (8 символов)
                lines.push('<span class="dex-row">◇ ' + 'DEX'.padEnd(8, ' ') + ': ' + formatP(dexPrice) + ' (' + (diff > 0 ? "+" : "") + diff + '%)</span>');
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
                    let mark = (ex === bestEx) ? '◆' : '◇';
                    let cls = (ex === bestEx) ? 'class="best"' : '';
                    const priceDisplay = (data.pricesFormatted && data.pricesFormatted[ex]) || formatP(p);
                    // Выравнивание названия биржи (8 символов)
                    lines.push('<span ' + cls + '>' + mark + ' ' + ex.padEnd(8, ' ') + ': ' + priceDisplay + ' (' + (diff > 0 ? "+" : "") + diff + '%)</span>');
                }
            });

            output.innerHTML = lines.join("<br>");
            statusEl.textContent = "Last: " + new Date().toLocaleTimeString() + (mexcDepositOpen ? "" : " | MEXC CLOSED");
        } catch(e) {}
    }

    async function start() {
        let val = input.value.trim();
        if(!val) return;
        if(timer) clearInterval(timer);
        output.innerHTML = "Загрузка...";
        
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
                }
            } catch(e) { output.innerHTML = "Ошибка DEX ссылки"; return; }
        } else {
            symbol = val.toUpperCase();
            chain = null; addr = null;
            try {
                const res = await fetch('/api/resolve?symbol=' + symbol + '&token=' + token);
                const d = await res.json();
                if (d.ok) { chain = d.chain; addr = d.addr; }
            } catch(e) {}
        }
        update();
        timer = setInterval(update, 2000);
    }

    document.getElementById("startBtn").onclick = start;
    input.addEventListener("keypress", (e) => { if(e.key === "Enter") start(); });
    if (urlParams.get('symbol') || (urlParams.get('chain') && urlParams.get('addr'))) start();
    </script>
    </body>
    </html>
    `);
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
