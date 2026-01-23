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

// Mapping для преобразования названий сетей MEXC в chainId для OKX/DEX
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
    'solana': 501,
    'ton': 600,
    'tron': 195,
    'opbnb': 204,
    'zkfair': 42766,
    'merlin': 4200,
    'blast': 81457,
    'scroll': 534352,
    'manta': 169
};

// Функции для работы с MEXC API
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

// Функции для получения цен с бирж
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
        switch (ex) {
            case 'Binance': url = `https://fapi.binance.com/fapi/v1/ticker/price?symbol=${pair}`; break;
            case 'Kucoin': url = `https://api-futures.kucoin.com/api/v1/ticker?symbol=${symbol === 'BTC' ? 'XBT' : symbol}USDTM`; break;
            case 'BingX': url = `https://open-api.bingx.com/openApi/swap/v2/quote/ticker?symbol=${symbol}-USDT`; break;
            case 'Bybit': url = `https://api.bybit.com/v5/market/tickers?category=linear&symbol=${pair}`; break;
            case 'Bitget': url = `https://api.bitget.com/api/v2/mix/market/ticker?symbol=${pair}&productType=USDT-FUTURES`; break;
            case 'OKX': url = `https://www.okx.com/api/v5/market/ticker?instId=${symbol}-USDT-SWAP`; break;
            case 'Gate': url = `https://api.gateio.ws/api/v4/futures/usdt/tickers?contract=${symbol}_USDT`; break;
        }
        const r = await fetch(url);
        const d = await r.json();
        if (ex === 'Binance') p = d.price;
        else if (ex === 'Kucoin') p = d.data?.price;
        else if (ex === 'BingX') p = d.data?.lastPrice;
        else if (ex === 'Bybit') p = d.result?.list?.[0]?.lastPrice;
        else if (ex === 'Bitget') p = d.data?.[0]?.lastPr;
        else if (ex === 'OKX') p = d.data?.[0]?.last;
        else if (ex === 'Gate') p = d.last || (d[0] && d[0].last);
        return parseFloat(p) || 0;
    } catch (e) { return 0; }
}

// Функция для подписи OKX Web3 запросов
function signOkx(timestamp, method, requestPath, body = '') {
    const message = timestamp + method + requestPath + body;
    return crypto.createHmac('sha256', OKX_API_SECRET).update(message).digest('base64');
}

// Функция для получения данных с OKX Web3 API
async function getOkxDexPrice(chainId, tokenAddress) {
    if (!OKX_API_KEY || !OKX_API_SECRET || !OKX_PASSPHRASE) {
        return { error: 'Ключи OKX API не настроены на сервере' };
    }

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
            return {
                price: parseFloat(data.data[0].price) || 0,
                baseToken: data.data[0].baseToken?.symbol
            };
        } else {
            let errorMsg = 'Неизвестная ошибка OKX';
            if (data.code === '50100') errorMsg = 'Неверные ключи API или подпись';
            if (data.code === '50016') errorMsg = 'Сеть не поддерживается OKX Web3 API';
            if (data.code === '51002') errorMsg = 'Контракт не найден в сети';
            if (data.code === '50018') errorMsg = 'Превышен лимит запросов';
            return { error: errorMsg };
        }
    } catch (error) {
        console.error('OKX API Network Error:', error.message);
        return { error: 'Сетевая ошибка при запросе к OKX' };
    }
}

// Функция для получения цены через DexScreener (fallback)
async function getDexScreenerPrice(contractAddress, network = null) {
    try {
        const fetch = (await import('node-fetch')).default;
        let url;

        if (network) {
            url = `https://api.dexscreener.com/latest/dex/tokens/${network}:${contractAddress}`;
        } else {
            url = `https://api.dexscreener.com/latest/dex/tokens/${contractAddress}`;
        }

        const response = await fetch(url);
        const data = await response.json();

        if (data.pairs && data.pairs.length > 0) {
            let bestPair = data.pairs[0];
            let maxVolume = parseFloat(bestPair.volume?.h24 || 0);

            for (const pair of data.pairs) {
                const volume = parseFloat(pair.volume?.h24 || 0);
                if (volume > maxVolume) {
                    maxVolume = volume;
                    bestPair = pair;
                }
            }

            return {
                price: parseFloat(bestPair.priceUsd) || 0,
                url: bestPair.url,
                baseToken: bestPair.baseToken?.symbol,
                chainId: bestPair.chainId
            };
        }
        return { error: 'Токен не найден на DexScreener' };
    } catch (error) {
        console.error('DexScreener Error:', error.message);
        return { error: 'Ошибка сети при запросе к DexScreener' };
    }
}

// Нормализация названия сети от MEXC
function normalizeNetworkName(networkName) {
    const name = networkName.toLowerCase();
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

// API Endpoint: Поиск токена (через MEXC)
app.get('/api/resolve', async (req, res) => {
    const symbol = (req.query.symbol || '').toUpperCase();

    const data = await mexcPrivateGet("/api/v3/capital/config/getall");
    if (!data || !Array.isArray(data)) return res.json({ ok: false, error: 'Ошибка получения данных от MEXC' });

    const token = data.find(t => t.coin === symbol);
    if (!token || !token.networkList) return res.json({ ok: false, error: 'Токен не найден в MEXC' });

    const network = token.networkList.find(net => net.contract && net.contract.trim() !== '');
    if (!network) return res.json({ ok: false, error: 'У токена нет контрактного адреса' });

    const networkName = normalizeNetworkName(network.network);
    const chainId = chainMapping[networkName];

    res.json({
        ok: true,
        contractAddress: network.contract,
        network: networkName,
        isOkxSupported: chainId !== undefined,
        chainId: chainId || null,
        networkFullName: network.network
    });
});

// API Endpoint: Получение DEX цены (основная логика)
app.get('/api/dex-price', async (req, res) => {
    const { chainId, contractAddress, network } = req.query;

    if (!contractAddress) {
        return res.json({ ok: false, error: 'Отсутствует адрес контракта', source: 'none' });
    }

    let finalResult = {
        ok: false,
        price: 0,
        source: 'none',
        error: null,
        url: null,
        baseToken: null
    };

    // 1. ПРИОРИТЕТ: OKX Web3 API
    const shouldTryOkx = chainId && chainId !== 'null' && OKX_API_KEY && OKX_API_SECRET && OKX_PASSPHRASE;
    if (shouldTryOkx) {
        const okxData = await getOkxDexPrice(chainId, contractAddress);

        if (okxData && okxData.price > 0) {
            finalResult.ok = true;
            finalResult.price = okxData.price;
            finalResult.source = 'okx';
            finalResult.baseToken = okxData.baseToken;
        } else if (okxData && okxData.error) {
            finalResult.error = `OKX: ${okxData.error}`;
            finalResult.source = 'okx_error';
        } else {
            finalResult.error = 'OKX: Неизвестная ошибка';
            finalResult.source = 'okx_error';
        }
    } else if (chainId && chainId !== 'null') {
        finalResult.error = 'Проблема с ключами OKX API (отсутствуют в настройках сервера)';
        finalResult.source = 'config_error';
    } else {
        finalResult.error = 'Сеть не поддерживается OKX Web3 API';
        finalResult.source = 'network_error';
    }

    // 2. FALLBACK: DexScreener (если OKX не дал цены)
    if (!finalResult.ok && !finalResult.source.startsWith('okx_error')) {
        const dexData = await getDexScreenerPrice(contractAddress, network);

        if (dexData && dexData.price > 0) {
            finalResult.ok = true;
            finalResult.price = dexData.price;
            finalResult.source = 'dexscreener';
            finalResult.url = dexData.url;
            finalResult.baseToken = dexData.baseToken;
        } else {
            if (!finalResult.error) {
                finalResult.error = dexData?.error || 'DexScreener: Токен не найден';
            }
        }
    }

    res.json(finalResult);
});

// API Endpoint: Получение цен со всех бирж (для основного интерфейса)
app.get('/api/all', async (req, res) => {
    if (req.query.token !== SECRET_TOKEN) return res.status(403).json({ ok: false, error: 'Неверный токен' });
    const symbol = (req.query.symbol || 'BTC').toUpperCase();
    const mexc = await getMexcPrice(symbol);
    const prices = {};
    await Promise.all(exchangesOrder.map(async ex => { prices[ex] = await getExPrice(ex, symbol); }));
    res.json({ ok: true, mexc, prices });
});

// Главная страница
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
    #output { white-space: pre; line-height: 1.1; min-height: 350px; }
    .control-row { display: flex; gap: 5px; margin-top: 10px; }
    #symbolInput { font-family: monospace; font-size: 28px; width: 100%; max-width: 400px; background: #000; color: #fff; border: 1px solid #444; padding: 5px; }
    #startBtn { font-family: monospace; font-size: 28px; background: #222; color: #fff; border: 1px solid #444; cursor: pointer; padding: 0 20px; }
    #startBtn:hover { background: #333; }
    #dexLink { font-family: monospace; font-size: 16px; width: 100%; background: #111; color: #888; border: 1px solid #333; padding: 8px; cursor: pointer; margin-top: 5px; }
    #errorDisplay { font-family: monospace; font-size: 16px; color: #ff4444; margin-top: 5px; min-height: 20px; }
    .dex-row { color: #00ff00; }
    .dex-okx { color: #00ff00; }
    .dex-dexscreener { color: #ff9900; }
    .best { color: #ffff00; }
    .blink-dot { animation: blink 1s infinite; display: inline-block; }
    @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }
    .status-ok { color: #44ff44; }
    .status-error { color: #ff4444; }
    </style>
    </head>
    <body>
      <div id="output">Готов к работе. Введите тикер или адрес токена.</div>
      <div class="control-row">
        <input id="symbolInput" value="${initialSymbol}" autocomplete="off" onfocus="this.select()" />
        <button id="startBtn">СТАРТ</button>
      </div>
      <input id="dexLink" readonly placeholder="Адрес токена или ссылка DEX" onclick="this.select(); document.execCommand('copy');" />
      <div id="errorDisplay"></div>
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
    let timer = null, blink = false;

    const output = document.getElementById("output");
    const input = document.getElementById("symbolInput");
    const dexLink = document.getElementById("dexLink");
    const errorDisplay = document.getElementById("errorDisplay");
    const statusEl = document.getElementById("status");

    function formatP(p) { 
        if (!p || p == 0) return "0";
        return parseFloat(p).toFixed(8).replace(/\.?0+$/, '');
    }

    async function getDexPrice() {
        if (!contractAddress) {
            return { price: 0, source: 'none', error: 'Адрес контракта не указан', url: null, baseToken: null };
        }

        try {
            const params = new URLSearchParams({ contractAddress: contractAddress });
            if (chainId) params.append('chainId', chainId);
            if (network) params.append('network', network);

            const res = await fetch('/api/dex-price?' + params.toString());
            const data = await res.json();
            return {
                price: data.price || 0,
                source: data.source || 'none',
                error: data.error || null,
                url: data.url || null,
                baseToken: data.baseToken || null
            };
        } catch(e) {
            console.error('DEX price error:', e);
            return { price: 0, source: 'none', error: 'Ошибка сети при запросе к серверу', url: null, baseToken: null };
        }
    }

    async function update() {
        blink = !blink;
        
        // Получаем данные DEX
        const dexResult = await getDexPrice();
        
        // Получаем цены с бирж
        let exchangeData = { ok: false, mexc: 0, prices: {} };
        try {
            const res = await fetch('/api/all?symbol=' + encodeURIComponent(symbol) + '&token=' + token);
            exchangeData = await res.json();
        } catch(e) {
            console.error('Exchange data error:', e);
        }

        // Очищаем ошибки
        errorDisplay.innerHTML = '';
        dexLink.style.color = '#888';
        
        // Формируем вывод
        let lines = [];
        
        // Статус подключения и символ
        let dot = blink ? '<span class="blink-dot">●</span>' : '○';
        lines.push(dot + ' <span class="status-ok">' + symbol + '</span> MEXC: ' + formatP(exchangeData.mexc));

        // DEX информация
        if (dexResult.price > 0) {
            const diff = ((dexResult.price - exchangeData.mexc) / exchangeData.mexc * 100).toFixed(2);
            const diffSign = diff > 0 ? '+' : '';
            const spreadText = \`(\${diffSign}\${diff}%)\`;

            let sourceLabel, sourceClass;
            if (dexResult.source === 'okx') {
                sourceLabel = 'DEX OKX';
                sourceClass = 'dex-okx';
            } else if (dexResult.source === 'dexscreener') {
                sourceLabel = 'DEX (через DexScreener)';
                sourceClass = 'dex-dexscreener';
            } else {
                sourceLabel = 'DEX';
                sourceClass = 'dex-row';
            }

            lines.push(\`<span class="\${sourceClass}">  \${sourceLabel}: \${formatP(dexResult.price)} \${spreadText}</span>\`);

            // Обновляем ссылку/адрес
            if (dexResult.url) {
                dexLink.value = dexResult.url;
            } else {
                dexLink.value = contractAddress;
            }
        }

        // Обработка ошибок DEX
        if (dexResult.error) {
            errorDisplay.innerHTML = \`⚠️ \${dexResult.error}\`;
            dexLink.style.color = '#ff4444';
        }

        // Цены с других бирж
        let bestEx = null, maxSp = 0;
        exchangesOrder.forEach(ex => {
            let p = exchangeData.prices[ex];
            if (p > 0) {
                let sp = Math.abs((p - exchangeData.mexc) / exchangeData.mexc * 100);
                if (sp > maxSp) { maxSp = sp; bestEx = ex; }
            }
        });

        exchangesOrder.forEach(ex => {
            let p = exchangeData.prices[ex];
            if (p > 0) {
                let diff = ((p - exchangeData.mexc) / exchangeData.mexc * 100).toFixed(2);
                let isBest = (ex === bestEx);
                let mark = isBest ? '◆' : '◇';
                let cls = isBest ? 'class="best"' : '';
                lines.push(\`<span \${cls}>\${mark} \${ex.padEnd(8, ' ')}: \${formatP(p)} (\${diff > 0 ? "+" : ""}\${diff}%)</span>\`);
            }
        });

        output.innerHTML = lines.join("<br>");
        statusEl.textContent = "Обновлено: " + new Date().toLocaleTimeString();
        
        // Обновляем заголовок окна
        if (dexResult.price > 0) {
            document.title = \`\${symbol}: \${dexResult.price}\`;
        } else if (exchangeData.mexc > 0) {
            document.title = \`\${symbol}: \${exchangeData.mexc}\`;
        }
    }

    async function start() {
        let val = input.value.trim();
        if (!val) return;
        
        if (timer) clearInterval(timer);
        output.innerHTML = "Поиск токена...";
        dexLink.value = "";
        errorDisplay.innerHTML = "";
        
        // Обработка ссылки DexScreener
        if (val.includes("dexscreener.com")) {
            try {
                const parts = val.split('/');
                const dsChain = parts[parts.length - 2];
                const dsAddress = parts[parts.length - 1].split('?')[0];
                
                const dsRes = await fetch('https://api.dexscreener.com/latest/dex/pairs/' + dsChain + '/' + dsAddress);
                const dsData = await dsRes.json();
                
                if (dsData.pair) {
                    symbol = dsData.pair.baseToken.symbol.toUpperCase();
                    contractAddress = dsData.pair.baseToken.address;
                    network = dsData.pair.chainId;
                    dexUrl = dsData.pair.url;
                    
                    input.value = symbol;
                    dexLink.value = dexUrl;
                } else {
                    output.innerHTML = "Не удалось распознать ссылку DexScreener";
                    return;
                }
            } catch(e) {
                output.innerHTML = "Ошибка при обработке ссылки";
                return;
            }
        } 
        // Обработка адреса контракта
        else if (val.startsWith('0x') || val.length > 30) {
            symbol = val.substring(0, 10).toUpperCase() + '...';
            contractAddress = val;
            network = null;
            dexUrl = null;
            dexLink.value = contractAddress;
        } 
        // Обработка тикера
        else {
            symbol = val.toUpperCase();
            contractAddress = null;
            network = null;
            dexUrl = null;
            
            try {
                const res = await fetch('/api/resolve?symbol=' + encodeURIComponent(symbol));
                const d = await res.json();
                if (d.ok) {
                    chainId = d.chainId;
                    contractAddress = d.contractAddress;
                    network = d.network;
                    dexLink.value = contractAddress;
                    
                    if (!d.isOkxSupported) {
                        errorDisplay.innerHTML = '⚠️ Сеть ' + d.networkFullName + ' не поддерживается OKX Web3 API. Используется DexScreener.';
                    }
                } else {
                    errorDisplay.innerHTML = '⚠️ ' + (d.error || 'Токен не найден в MEXC');
                }
            } catch(e) {
                errorDisplay.innerHTML = '⚠️ Ошибка при поиске токена';
            }
        }

        // Обновляем URL
        const url = new URL(window.location);
        url.searchParams.set('symbol', symbol);
        if (chainId) url.searchParams.set('chainId', chainId);
        if (contractAddress) url.searchParams.set('contractAddress', contractAddress);
        if (network) url.searchParams.set('network', network);
        if (dexUrl) url.searchParams.set('dexUrl', dexUrl);
        window.history.replaceState({}, '', url);

        // Запускаем обновление
        update();
        timer = setInterval(update, 2000);
    }

    document.getElementById("startBtn").onclick = start;
    input.addEventListener("keypress", (e) => { if (e.key === "Enter") start(); });

    // Автозапуск если в URL есть символ
    if (urlParams.get('symbol')) {
        start();
    }
    </script>
    </body>
    </html>
    `);
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
