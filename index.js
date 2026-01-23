const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const app = express();

app.use(cors());
app.use(express.json());

// --- КОНФИГУРАЦИЯ ---
const PORT = process.env.PORT || 3000;
const SECRET_TOKEN = process.env.SECRET_TOKEN || '777'; 
const MEXC_API_KEY = process.env.MEXC_API_KEY || '';
const MEXC_API_SECRET = process.env.MEXC_API_SECRET || '';
const OKX_API_KEY = process.env.OKX_API_KEY || '';
const OKX_API_SECRET = process.env.OKX_API_SECRET || '';
const OKX_PASSPHRASE = process.env.OKX_PASSPHRASE || '';

const exchangesOrder = ["Binance", "Bybit", "Gate", "Bitget", "BingX", "OKX", "Kucoin"];

// Расширенный mapping для OKX API (добавлены Solana и TON)
const chainMapping = {
    'eth': 1, 'ethereum': 1,
    'bsc': 56, 'binance': 56,
    'polygon': 137, 'matic': 137,
    'arbitrum': 42161,
    'optimism': 10,
    'avalanche': 43114,
    'fantom': 250,
    'cronos': 25,
    'base': 8453,
    'celo': 42220,
    'zksync': 324,
    'linea': 59144,
    'mantle': 5000,
    'solana': 501, // Solana chainId для OKX API
    'ton': 600, // TON chainId для OKX API
    'tron': 195, // Tron chainId
    'opbnb': 204,
    'zkfair': 42766,
    'merlin': 4200,
    'blast': 81457,
    'scroll': 534352,
    'manta': 169
};

// Функция для преобразования названий сетей от MEXC к формату для chainMapping
function normalizeNetworkName(networkName) {
    const name = networkName.toLowerCase();
    
    // Маппинг для распространенных названий сетей
    const networkAliases = {
        'erc20': 'eth',
        'bep20': 'bsc',
        'sol': 'solana',
        'ton network': 'ton',
        'trc20': 'tron',
        'arbitrum one': 'arbitrum',
        'avax c-chain': 'avalanche',
        'ftm': 'fantom',
        'polygon (pos)': 'polygon',
        'optimism (op)': 'optimism',
        'base (base)': 'base',
        'zksync era': 'zksync',
        'linea (linea)': 'linea',
        'mantle (mantle)': 'mantle'
    };
    
    return networkAliases[name] || name;
}

// Функция для подписи OKX запросов
function signOkx(timestamp, method, requestPath, body = '') {
    const message = timestamp + method + requestPath + body;
    return crypto.createHmac('sha256', OKX_API_SECRET).update(message).digest('base64');
}

// Функция для получения данных с OKX API
async function getOkxDexPrice(chainId, tokenAddress) {
    if (!OKX_API_KEY || !OKX_API_SECRET || !OKX_PASSPHRASE) return null;
    
    try {
        const fetch = (await import('node-fetch')).default;
        const method = 'GET';
        const requestPath = `/api/v6/dex/market/price-info?chainId=${chainId}&tokenAddress=${tokenAddress}`;
        const timestamp = new Date().toISOString();
        const signature = signOkx(timestamp, method, requestPath);
        
        const response = await fetch(`https://web3.okx.com${requestPath}`, {
            headers: {
                'OK-ACCESS-KEY': OKX_API_KEY,
                'OK-ACCESS-SIGN': signature,
                'OK-ACCESS-TIMESTAMP': timestamp,
                'OK-ACCESS-PASSPHRASE': OKX_PASSPHRASE,
                'Content-Type': 'application/json'
            }
        });
        
        const data = await response.json();
        
        if (data.code === '0' && data.data && data.data.length > 0) {
            return data.data[0];
        }
        return null;
    } catch (error) {
        console.error('OKX API Error:', error);
        return null;
    }
}

// Функция для получения цены через DexScreener (для сетей, не поддерживаемых OKX)
async function getDexScreenerPrice(contractAddress, network = null) {
    try {
        const fetch = (await import('node-fetch')).default;
        
        // Если есть сеть, используем поиск по сети и адресу
        if (network) {
            const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${network}:${contractAddress}`);
            const data = await response.json();
            
            if (data.pairs && data.pairs.length > 0) {
                // Находим пару с максимальным объемом
                let bestPair = data.pairs[0];
                for (const pair of data.pairs) {
                    if (parseFloat(pair.volume?.h24 || 0) > parseFloat(bestPair.volume?.h24 || 0)) {
                        bestPair = pair;
                    }
                }
                return {
                    price: bestPair.priceUsd,
                    url: bestPair.url,
                    chainId: bestPair.chainId,
                    baseToken: bestPair.baseToken?.symbol
                };
            }
        }
        
        // Fallback: поиск только по адресу контракта
        const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${contractAddress}`);
        const data = await response.json();
        
        if (data.pairs && data.pairs.length > 0) {
            let bestPair = data.pairs[0];
            for (const pair of data.pairs) {
                if (parseFloat(pair.volume?.h24 || 0) > parseFloat(bestPair.volume?.h24 || 0)) {
                    bestPair = pair;
                }
            }
            return {
                price: bestPair.priceUsd,
                url: bestPair.url,
                chainId: bestPair.chainId,
                baseToken: bestPair.baseToken?.symbol
            };
        }
        
        return null;
    } catch (error) {
        console.error('DexScreener Error:', error);
        return null;
    }
}

// Обновленная функция resolve
app.get('/api/resolve', async (req, res) => {
    const symbol = (req.query.symbol || '').toUpperCase();
    
    // Получаем информацию о токене из MEXC
    const data = await mexcPrivateGet("/api/v3/capital/config/getall");
    if (!data || !Array.isArray(data)) return res.json({ ok: false });

    const token = data.find(t => t.coin === symbol);
    if (!token || !token.networkList) return res.json({ ok: false });

    // Ищем сеть с контрактом
    const network = token.networkList.find(net => net.contract && net.contract.trim() !== '');
    if (!network) return res.json({ ok: false });

    const networkName = normalizeNetworkName(network.network);
    const chainId = chainMapping[networkName];
    
    // Определяем, поддерживается ли сеть OKX
    const isOkxSupported = chainId !== undefined;
    
    // Если сеть поддерживается OKX, используем chainId, иначе используем имя сети для DexScreener
    const result = {
        ok: true,
        contractAddress: network.contract,
        network: networkName,
        isOkxSupported,
        chainId: chainId || null
    };
    
    res.json(result);
});

// Обновленный endpoint для получения цены DEX
app.get('/api/dex-price', async (req, res) => {
    const { chainId, contractAddress, network } = req.query;
    
    if (!contractAddress) {
        return res.json({ ok: false, error: 'Missing contract address' });
    }
    
    let dexData = null;
    
    // Если указан chainId (сеть поддерживается OKX), используем OKX API
    if (chainId && chainId !== 'null') {
        dexData = await getOkxDexPrice(chainId, contractAddress);
    }
    
    // Если OKX не вернул данные или сеть не поддерживается, используем DexScreener
    if (!dexData) {
        dexData = await getDexScreenerPrice(contractAddress, network);
    }
    
    if (dexData) {
        res.json({
            ok: true,
            price: dexData.price,
            url: dexData.url || null,
            chainId: dexData.chainId || chainId,
            baseToken: dexData.baseToken || null
        });
    } else {
        res.json({ ok: false });
    }
});

// Остальные функции остаются без изменений...
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
    if (req.query.token !== SECRET_TOKEN) return res.status(403).json({ok:false});
    const symbol = (req.query.symbol || 'BTC').toUpperCase();
    const mexc = await getMexcPrice(symbol);
    const prices = {};
    await Promise.all(exchangesOrder.map(async ex => { prices[ex] = await getExPrice(ex, symbol); }));
    res.json({ ok: true, mexc, prices });
});

app.get('/', (req, res) => {
    const initialSymbol = (req.query.symbol || 'BTC').toUpperCase();
    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
    <meta charset="UTF-8">
    <title>Crypto Monitor</title>
    <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #000; font-family: monospace; font-size: 28px; color: #fff; padding: 10px; overflow: hidden; }
    #output { white-space: pre; line-height: 1.1; height: 320px; }
    .control-row { display: flex; gap: 5px; margin-top: 10px; }
    #symbolInput { font-family: monospace; font-size: 28px; width: 100%; max-width: 400px; background: #000; color: #fff; border: 1px solid #444; }
    #startBtn { font-family: monospace; font-size: 28px; background: #222; color: #fff; border: 1px solid #444; cursor: pointer; padding: 0 10px; }
    #dexLink { font-family: monospace; font-size: 16px; width: 100%; background: #111; color: #888; border: 1px solid #333; padding: 5px; cursor: pointer; margin-top: 5px; }
    .dex-row { color: #00ff00; }
    .best { color: #ffff00; }
    .blink-dot { animation: blink 1s infinite; display: inline-block; }
    @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }
    </style>
    </head>
    <body>
      <div id="output">Готов к работе</div>
      <div class="control-row">
        <input id="symbolInput" value="${initialSymbol}" autocomplete="off" onfocus="this.select()" />
        <button id="startBtn">СТАРТ</button>
      </div>
      <input id="dexLink" readonly placeholder="Token Address / DEX URL" onclick="this.select(); document.execCommand('copy');" />
      <div id="status" style="font-size: 18px; margin-top: 5px; color: #444;"></div>

    <script>
    const exchangesOrder = ["Binance", "Bybit", "Gate", "Bitget", "BingX", "OKX", "Kucoin"];
    let urlParams = new URLSearchParams(window.location.search);
    let symbol = urlParams.get('symbol')?.toUpperCase() || 'BTC';
    let token = urlParams.get('token') || '777';
    let chainId = urlParams.get('chainId');
    let contractAddress = urlParams.get('contractAddress');
    let network = urlParams.get('network');
    let dexUrl = urlParams.get('dexUrl');
    let timer=null, blink=false;

    const output=document.getElementById("output");
    const input=document.getElementById("symbolInput");
    const dexLink=document.getElementById("dexLink");
    const statusEl=document.getElementById("status");

    function formatP(p) { 
        if(!p || p == 0) return "0";
        return parseFloat(p).toString();
    }

    async function getDexPrice() {
        if (!contractAddress) return 0;
        
        try {
            const params = new URLSearchParams({
                contractAddress: contractAddress
            });
            if (chainId) params.append('chainId', chainId);
            if (network) params.append('network', network);
            
            const res = await fetch('/api/dex-price?' + params.toString());
            const data = await res.json();
            if (data.ok && data.price) {
                if (data.url) dexUrl = data.url;
                if (data.baseToken) {
                    symbol = data.baseToken.toUpperCase();
                    input.value = symbol;
                }
                return parseFloat(data.price);
            }
        } catch(e) {
            console.error('DEX price error:', e);
        }
        return 0;
    }

    async function update() {
        blink = !blink;
        
        // Получаем цену с DEX
        const dexPrice = await getDexPrice();
        
        try {
            const res = await fetch('/api/all?symbol=' + symbol + '&token=' + token);
            const data = await res.json();
            if(!data.ok) return;

            let dot = blink ? '<span class="blink-dot">●</span>' : '○';
            let lines = [];
            lines.push(dot + ' ' + symbol + ' MEXC: ' + formatP(data.mexc));

            if (dexPrice > 0) {
                let diff = ((dexPrice - data.mexc) / data.mexc * 100).toFixed(2);
                lines.push('<span class="dex-row">  DEX     : ' + formatP(dexPrice) + ' (' + (diff > 0 ? "+" : "") + diff + '%)</span>');
                if (dexUrl) {
                    dexLink.value = dexUrl;
                    document.title = symbol + ': ' + dexPrice;
                } else {
                    dexLink.value = contractAddress;
                }
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
                    let isBest = (ex === bestEx);
                    let mark = isBest ? '◆' : '◇';
                    let cls = isBest ? 'class="best"' : '';
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
        
        if(timer) clearInterval(timer);
        output.innerHTML = "Обработка...";
        dexLink.value = "";
        
        // Проверяем, не ссылка ли это DexScreener
        if (val.includes("dexscreener.com")) {
            try {
                const parts = val.split('/');
                chainId = parts[parts.length - 2];
                contractAddress = parts[parts.length - 1].split('?')[0];
                
                // Получаем данные из DexScreener
                const dsRes = await fetch('https://api.dexscreener.com/latest/dex/pairs/' + chainId + '/' + contractAddress);
                const dsData = await dsRes.json();
                
                if (dsData.pair) {
                    symbol = dsData.pair.baseToken.symbol.toUpperCase();
                    contractAddress = dsData.pair.baseToken.address;
                    network = dsData.pair.chainId;
                    dexUrl = dsData.pair.url;
                    
                    input.value = symbol;
                    dexLink.value = dexUrl;
                }
            } catch(e) {
                output.innerHTML = "Ошибка ссылки!";
                return;
            }
        } 
        // Проверяем, не адрес ли это токена
        else if (val.startsWith('0x') && val.length === 42) {
            // Если это адрес токена, пытаемся найти информацию через resolve
            try {
                const res = await fetch('/api/resolve?symbol=' + val);
                const data = await res.json();
                if (data.ok) {
                    symbol = val.toUpperCase();
                    contractAddress = data.contractAddress;
                    network = data.network;
                    chainId = data.chainId;
                    dexLink.value = contractAddress;
                }
            } catch(e) {}
        } else {
            // Если это тикер
            symbol = val.toUpperCase();
            chainId = null;
            contractAddress = null;
            network = null;
            dexUrl = null;
            
            try {
                const res = await fetch('/api/resolve?symbol=' + symbol);
                const d = await res.json();
                if (d.ok) {
                    chainId = d.chainId;
                    contractAddress = d.contractAddress;
                    network = d.network;
                    dexLink.value = d.contractAddress;
                }
            } catch(e) {}
        }

        const url = new URL(window.location);
        url.searchParams.set('symbol', symbol);
        if(chainId) url.searchParams.set('chainId', chainId);
        if(contractAddress) url.searchParams.set('contractAddress', contractAddress);
        if(network) url.searchParams.set('network', network);
        if(dexUrl) url.searchParams.set('dexUrl', dexUrl);
        window.history.replaceState({}, '', url);

        update();
        timer = setInterval(update, 1000);
    }

    document.getElementById("startBtn").onclick = start;
    input.addEventListener("keypress", (e) => { if(e.key === "Enter") start(); });

    if (urlParams.get('symbol')) {
        start();
    } else {
        update();
        timer = setInterval(update, 1000);
    }
    </script>
    </body>
    </html>
    `);
});

app.listen(PORT, () => console.log(`Server running on ${PORT}`));
