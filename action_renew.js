const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const http = require('http');

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;

async function sendTelegramMessage(message, imagePath = null) {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;

    // 1. 发送文字消息
    try {
        const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
        await axios.post(url, {
            chat_id: TG_CHAT_ID,
            text: message,
            parse_mode: 'Markdown'
        });
        console.log('[Telegram] Message sent.');
    } catch (e) {
        console.error('[Telegram] Failed to send message:', e.message);
    }

    // 2. 发送图片 (如果有)
    if (imagePath && fs.existsSync(imagePath)) {
        console.log('[Telegram] Sending photo...');
        // 使用 curl 发送图片，避免引入额外的 multipart 依赖
        // 注意：Windows 本地测试可能需要环境支持 curl，GitHub Actions (Ubuntu) 默认支持
        const cmd = `curl -s -X POST "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto" -F chat_id="${TG_CHAT_ID}" -F photo="@${imagePath}"`;
        await new Promise(resolve => {
            exec(cmd, (err) => {
                if (err) console.error('[Telegram] Failed to send photo via curl:', err.message);
                else console.log('[Telegram] Photo sent.');
                resolve();
            });
        });
    }
}

// 启用 stealth 插件
chromium.use(stealth);

// GitHub Actions 环境下的 Chrome 路径 (通常是 google-chrome)
const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const DEBUG_PORT = 9222;

// 确保 localhost 不走代理
process.env.NO_PROXY = 'localhost,127.0.0.1';

// --- Proxy Configuration ---
const HTTP_PROXY = process.env.HTTP_PROXY;
let PROXY_CONFIG = null;

if (HTTP_PROXY) {
    try {
        const proxyUrl = new URL(HTTP_PROXY);
        PROXY_CONFIG = {
            server: `${proxyUrl.protocol}//${proxyUrl.hostname}:${proxyUrl.port}`,
            username: proxyUrl.username ? decodeURIComponent(proxyUrl.username) : undefined,
            password: proxyUrl.password ? decodeURIComponent(proxyUrl.password) : undefined
        };
        console.log(`[代理] 检测到配置: 服务器=${PROXY_CONFIG.server}, 认证=${PROXY_CONFIG.username ? '是' : '否'}`);
    } catch (e) {
        console.error('[代理] TODO HTTP_PROXY 格式无效。期望格式: http://user:pass@host:port 或 http://host:port');
        process.exit(1);
    }
}

// --- INJECTED_SCRIPT ---
const INJECTED_SCRIPT = `
(function() {
    if (window.self === window.top) return;

    // 1. 模拟鼠标屏幕坐标
    try {
        function getRandomInt(min, max) {
            return Math.floor(Math.random() * (max - min + 1)) + min;
        }
        let screenX = getRandomInt(800, 1200);
        let screenY = getRandomInt(400, 600);
        
        Object.defineProperty(MouseEvent.prototype, 'screenX', { value: screenX });
        Object.defineProperty(MouseEvent.prototype, 'screenY', { value: screenY });
    } catch (e) { }

    // 2. 简单的 attachShadow Hook
    try {
        const originalAttachShadow = Element.prototype.attachShadow;
        
        Element.prototype.attachShadow = function(init) {
            const shadowRoot = originalAttachShadow.call(this, init);
            
            if (shadowRoot) {
                const checkAndReport = () => {
                    const checkbox = shadowRoot.querySelector('input[type="checkbox"]');
                    if (checkbox) {
                        const rect = checkbox.getBoundingClientRect();
                        if (rect.width > 0 && rect.height > 0 && window.innerWidth > 0 && window.innerHeight > 0) {
                            const xRatio = (rect.left + rect.width / 2) / window.innerWidth;
                            const yRatio = (rect.top + rect.height / 2) / window.innerHeight;
                            window.__turnstile_data = { xRatio, yRatio };
                            return true;
                        }
                    }
                    return false;
                };

                if (!checkAndReport()) {
                    const observer = new MutationObserver(() => {
                        if (checkAndReport()) observer.disconnect();
                    });
                    observer.observe(shadowRoot, { childList: true, subtree: true });
                }
            }
            return shadowRoot;
        };
    } catch (e) {
        console.error('[注入] Hook attachShadow 失败:', e);
    }
})();
`;

// 辅助函数：检测代理是否可用
async function checkProxy() {
    if (!PROXY_CONFIG) return true;

    console.log('[代理] 正在验证代理连接...');
    try {
        const axiosConfig = {
            proxy: {
                protocol: 'http',
                host: new URL(PROXY_CONFIG.server).hostname,
                port: new URL(PROXY_CONFIG.server).port,
            },
            timeout: 10000
        };

        if (PROXY_CONFIG.username && PROXY_CONFIG.password) {
            axiosConfig.proxy.auth = {
                username: PROXY_CONFIG.username,
                password: PROXY_CONFIG.password
            };
        }

        await axios.get('https://www.google.com', axiosConfig);
        console.log('[代理] 连接成功！');
        return true;
    } catch (error) {
        console.error(`[代理] 连接失败: ${error.message}`);
        return false;
    }
}

function checkPort(port) {
    return new Promise((resolve) => {
        const req = http.get(`http://localhost:${port}/json/version`, (res) => {
            resolve(true);
        });
        req.on('error', () => resolve(false));
        req.end();
    });
}

const CHROME_USER_DATA_DIR = '/tmp/chrome_user_data';
const CHROME_LOG_PATH = path.join(process.cwd(), 'chrome.log');
const CHROME_START_ATTEMPTS = 3;
const CHROME_START_TIMEOUT_MS = 25000;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function printChromeLog(lines = 40) {
    try {
        const content = fs.readFileSync(CHROME_LOG_PATH, 'utf8').trim();
        if (!content) return;
        console.error(`--- chrome.log (最后 ${lines} 行) ---`);
        console.error(content.split('\n').slice(-lines).join('\n'));
        console.error('--- chrome.log 结束 ---');
    } catch (e) { }
}

function killChrome(chrome) {
    if (!chrome || !chrome.pid) return;
    try {
        process.kill(-chrome.pid, 'SIGKILL'); // detached 启动，杀整个进程组
    } catch (e) {
        try { chrome.kill('SIGKILL'); } catch (e2) { }
    }
}

async function launchChromeOnce(attempt) {
    // 每次重试都用干净的 profile：上次崩溃留下的锁/单例文件会让新进程直接把请求转交给已死的实例
    try { fs.rmSync(CHROME_USER_DATA_DIR, { recursive: true, force: true }); } catch (e) { }

    const args = [
        `--remote-debugging-port=${DEBUG_PORT}`,
        '--no-first-run',
        '--no-default-browser-check',
        // '--headless=new', // (已被注释) 使用 xvfb-run 时不需要 headless 模式，这样可以模拟有头浏览器增加成功率
        '--disable-gpu',
        '--window-size=1280,720',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        `--user-data-dir=${CHROME_USER_DATA_DIR}` // 必须指定用户数据目录，否则远程调试可能失败
    ];

    if (PROXY_CONFIG) {
        args.push(`--proxy-server=${PROXY_CONFIG.server}`);
        args.push('--proxy-bypass-list=<-loopback>');
    }
    // 添加针对 Linux 环境的额外稳定性参数
    args.push('--disable-dev-shm-usage'); // 避免共享内存不足

    // 把 Chrome 自己的 stdout/stderr 落盘：原来 stdio: 'ignore' 会丢掉它起不来的真正原因
    const logFd = fs.openSync(CHROME_LOG_PATH, 'a');
    fs.writeSync(logFd, `\n===== Chrome 启动尝试 ${attempt} @ ${new Date().toISOString()} =====\n`);
    fs.writeSync(logFd, `命令: ${CHROME_PATH} ${args.join(' ')}\n`);

    const chrome = spawn(CHROME_PATH, args, {
        detached: true,
        stdio: ['ignore', logFd, logFd]
    });
    chrome.unref();
    fs.closeSync(logFd); // 子进程已继承该 fd，父进程可以关掉

    let exitInfo = null;
    chrome.on('exit', (code, signal) => { exitInfo = { code, signal }; });
    chrome.on('error', (err) => { exitInfo = { code: null, signal: null, error: err.message }; });

    const deadline = Date.now() + CHROME_START_TIMEOUT_MS;
    while (Date.now() < deadline) {
        if (await checkPort(DEBUG_PORT)) return true;
        if (exitInfo) break;
        await sleep(500);
    }

    if (await checkPort(DEBUG_PORT)) return true;

    if (exitInfo) {
        console.error(`Chrome 第 ${attempt} 次启动失败：进程已退出 (code=${exitInfo.code}, signal=${exitInfo.signal}${exitInfo.error ? `, error=${exitInfo.error}` : ''})`);
    } else {
        console.error(`Chrome 第 ${attempt} 次启动失败：进程仍在运行，但 ${CHROME_START_TIMEOUT_MS / 1000}s 内端口 ${DEBUG_PORT} 未监听`);
    }
    killChrome(chrome);
    printChromeLog();
    return false;
}

async function launchChrome() {
    console.log('检查 Chrome 是否已在端口 ' + DEBUG_PORT + ' 上运行...');
    if (await checkPort(DEBUG_PORT)) {
        console.log('Chrome 已开启。');
        return;
    }

    for (let attempt = 1; attempt <= CHROME_START_ATTEMPTS; attempt++) {
        console.log(`正在启动 Chrome (第 ${attempt}/${CHROME_START_ATTEMPTS} 次, 路径: ${CHROME_PATH})...`);
        if (await launchChromeOnce(attempt)) {
            console.log('Chrome 已就绪。');
            return;
        }
        if (attempt < CHROME_START_ATTEMPTS) {
            console.log('5 秒后重试...');
            await sleep(5000);
        }
    }

    printChromeLog(80);
    throw new Error(`Chrome 启动失败（已重试 ${CHROME_START_ATTEMPTS} 次）`);
}

function getUsers() {
    // 从环境变量读取 JSON 字符串
    // GitHub Actions Secret: USERS_JSON = [{"username":..., "password":...}]
    try {
        if (process.env.USERS_JSON) {
            const parsed = JSON.parse(process.env.USERS_JSON);
            const users = Array.isArray(parsed) ? parsed : (parsed.users || []);
            
            // --- GitHub 原生 Secret Masking ---
            // 通知 GitHub Actions runner 将所有用户名和密码进行掩码，日志中一旦出现均自动替换为 ***
            users.forEach(u => {
                if (u.username && u.username.length > 2) {
                    console.log(`::add-mask::${u.username}`);
                }
                if (u.password && u.password.length > 2) {
                    console.log(`::add-mask::${u.password}`);
                }
            });

            return users;
        }
    } catch (e) {
        console.error('解析 USERS_JSON 环境变量错误:', e);
    }
    return [];
}

async function attemptTurnstileCdp(page) {
    const frames = page.frames();
    for (const frame of frames) {
        try {
            const data = await frame.evaluate(() => window.__turnstile_data).catch(() => null);

            if (data) {
                console.log('>> 在 frame 中发现 Turnstile。比例:', data);

                const iframeElement = await frame.frameElement();
                if (!iframeElement) continue;

                const box = await iframeElement.boundingBox();
                if (!box) continue;

                const clickX = box.x + (box.width * data.xRatio);
                const clickY = box.y + (box.height * data.yRatio);

                console.log(`>> 计算点击坐标: (${clickX.toFixed(2)}, ${clickY.toFixed(2)})`);

                const client = await page.context().newCDPSession(page);

                await client.send('Input.dispatchMouseEvent', {
                    type: 'mousePressed',
                    x: clickX,
                    y: clickY,
                    button: 'left',
                    clickCount: 1
                });

                await new Promise(r => setTimeout(r, 50 + Math.random() * 100));

                await client.send('Input.dispatchMouseEvent', {
                    type: 'mouseReleased',
                    x: clickX,
                    y: clickY,
                    button: 'left',
                    clickCount: 1
                });

                console.log('>> CDP 点击已发送。');
                await client.detach();
                return true;
            }
        } catch (e) { }
    }
    return false;
}

(async () => {
    const users = getUsers();
    if (users.length === 0) {
        console.log('未在 process.env.USERS_JSON 中找到用户');
        process.exit(1);
    }

    if (PROXY_CONFIG) {
        const isValid = await checkProxy();
        if (!isValid) {
            console.error('[代理] 代理无效，终止运行。');
            process.exit(1);
        }
    }

    await launchChrome();

    console.log(`正在连接 Chrome...`);
    let browser;
    for (let k = 0; k < 5; k++) {
        try {
            browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`);
            console.log('连接成功！');
            break;
        } catch (e) {
            console.log(`连接尝试 ${k + 1} 失败。2秒后重试...`);
            await new Promise(r => setTimeout(r, 2000));
        }
    }

    if (!browser) {
        console.error('连接失败。退出。');
        process.exit(1);
    }

    const context = browser.contexts()[0];
    let page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
    page.setDefaultTimeout(60000);

    if (PROXY_CONFIG && PROXY_CONFIG.username) {
        console.log('[代理] 正在设置认证...');
        await context.setHTTPCredentials({
            username: PROXY_CONFIG.username,
            password: PROXY_CONFIG.password
        });
    } else {
        await context.setHTTPCredentials(null);
    }

    await page.addInitScript(INJECTED_SCRIPT);
    console.log('注入脚本已添加。');

    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        console.log(`\n=== 正在处理用户 ${i + 1}/${users.length} ===`); // 隐去具体邮箱 logging

        try {
            if (page.isClosed()) {
                page = await context.newPage();
                // Context credentials apply
                await page.addInitScript(INJECTED_SCRIPT);
            }

            // --- 登录逻辑 (简略版，逻辑一致) ---
            if (page.url().includes('dashboard')) {
                await page.goto('https://dashboard.katabump.com/auth/logout');
                await page.waitForTimeout(2000);
            }
            // 总是先去登录页
            await page.goto('https://dashboard.katabump.com/auth/login');
            await page.waitForTimeout(2000);
            if (page.url().includes('dashboard')) {
                // 如果登出没成功，再次登出
                await page.goto('https://dashboard.katabump.com/auth/logout');
                await page.waitForTimeout(2000);
                await page.goto('https://dashboard.katabump.com/auth/login');
            }

            console.log('正在输入凭据...');
            try {
                const emailInput = page.getByRole('textbox', { name: 'Email' });
                await emailInput.waitFor({ state: 'visible', timeout: 5000 });
                await emailInput.fill(user.username);
                const pwdInput = page.getByRole('textbox', { name: 'Password' });
                await pwdInput.fill(user.password);
                await page.waitForTimeout(500);

                // --- Cloudflare Turnstile Bypass for Login ---
                console.log('   >> 正在登录前检查 Turnstile (使用 CDP 绕过)...');
                let cdpClickResult = false;
                for (let findAttempt = 0; findAttempt < 15; findAttempt++) {
                    cdpClickResult = await attemptTurnstileCdp(page);
                    if (cdpClickResult) break;
                    await page.waitForTimeout(1000);
                }

                if (cdpClickResult) {
                    console.log('   >> 登录 CDP 点击生效。正在等待最多 10秒 Cloudflare 成功标志...');
                    for (let waitSec = 0; waitSec < 10; waitSec++) {
                        const frames = page.frames();
                        let isSuccess = false;
                        for (const f of frames) {
                            if (f.url().includes('cloudflare')) {
                                try {
                                    if (await f.getByText('Success!', { exact: false }).isVisible({ timeout: 500 })) {
                                        isSuccess = true;
                                        break;
                                    }
                                } catch (e) { }
                            }
                        }
                        if (isSuccess) {
                            console.log('   >> 登录前 Turnstile 验证成功。');
                            break;
                        }
                        await page.waitForTimeout(1000);
                    }
                } else {
                    console.log('   >> 登录前未检测到或未点击 Turnstile，继续操作...');
                }
                // --------------------------------------------

                await page.getByRole('button', { name: 'Login', exact: true }).click();

                // User Request: Check for incorrect password
                try {
                    const errorMsg = page.getByText('Incorrect password or no account');
                    if (await errorMsg.isVisible({ timeout: 3000 })) {
                        console.error(`   >> ❌ 登录失败: 用户 ${user.username} 账号或密码错误`);
                        const failShotPath = path.join(photoDir, `${safeUsername}.png`);
                        try { await page.screenshot({ path: failShotPath, fullPage: true }); } catch (e) { }

                        await sendTelegramMessage(`❌ *登录失败*\n用户: ${user.username}\n原因: 账号或密码错误`, failShotPath);

                        continue;
                    }
                } catch (e) { }

            } catch (e) {
                console.log('登录错误:', e.message);
            }

            console.log('正在寻找 "See" 链接...');
            try {
                await page.getByRole('link', { name: 'See' }).first().waitFor({ timeout: 15000 });
                await page.waitForTimeout(1000);
                await page.getByRole('link', { name: 'See' }).first().click();
            } catch (e) {
                console.log('未找到 "See" 按钮。');
                continue;
            }

            // --- Renew 逻辑 ---
            let renewSuccess = false;
            // 2. 一个扁平化的主循环：尝试 Renew 整个流程 (最多 20 次)
            for (let attempt = 1; attempt <= 20; attempt++) {
                let hasCaptchaError = false;

                // 1. 如果是重试 (attempt > 1)，说明之前失败了或者刚刷新完页面
                // 我们直接开始寻找 Renew 按钮
                console.log(`\n[尝试 ${attempt}/20] 正在寻找 Renew 按钮...`);

                const renewBtn = page.getByRole('button', { name: 'Renew', exact: true }).first();
                try {
                    // 稍微等待一下，防止页面刚刷新还没渲染出来
                    await renewBtn.waitFor({ state: 'visible', timeout: 5000 });
                } catch (e) { }

                if (await renewBtn.isVisible()) {
                    await renewBtn.click();
                    console.log('Renew 按钮已点击。等待模态框...');

                    const modal = page.locator('#renew-modal');
                    try { await modal.waitFor({ state: 'visible', timeout: 5000 }); } catch (e) {
                        console.log('模态框未出现？重试中...');
                        continue;
                    }

                    // 准备点击模态框中的确认 Renew 按钮
                    const confirmBtn = modal.getByRole('button', { name: 'Renew' });
                    try {
                        await confirmBtn.waitFor({ state: 'visible', timeout: 3000 });
                    } catch (e) { }

                    if (await confirmBtn.isVisible()) {
                        console.log('   >> 直接点击模态框中的 Renew 确认按钮...');
                        await confirmBtn.click();

                        try {
                            const startVerifyTime = Date.now();
                            while (Date.now() - startVerifyTime < 5000) {
                                // 检查 URL 或页面中的未到期提示 (如: You can't renew your server yet...)
                                const currentUrl = page.url();
                                const notTimeLoc = page.getByText("You can't renew your server yet");
                                const isNotTime = currentUrl.includes('renew-error') || await notTimeLoc.isVisible().catch(() => false);

                                if (isNotTime) {
                                    let dateStr = 'Unknown Date';

                                    // 1. 尝试从页面红色警告框获取文本
                                    try {
                                        if (await notTimeLoc.first().isVisible({ timeout: 1000 })) {
                                            const text = await notTimeLoc.first().innerText();
                                            const match = text.match(/as of\s+([^\(\n\r]+)/i);
                                            if (match) dateStr = match[1].trim();
                                        }
                                    } catch (e) { }

                                    // 2. 如果页面没提取到，从 URL 参数提取 (把 + 转为空格)
                                    if (dateStr === 'Unknown Date' && currentUrl.includes('renew-error')) {
                                        try {
                                            const rawUrlText = currentUrl.replace(/\+/g, ' ');
                                            const decodedUrl = decodeURIComponent(rawUrlText);
                                            const matchUrl = decodedUrl.match(/as of\s+([^\(\n\r&]+)/i);
                                            if (matchUrl) dateStr = matchUrl[1].trim();
                                        } catch (e) { }
                                    }

                                    console.log(`   >> ⏳ 暂无法续期。下次可用时间: ${dateStr}`);

                                    // 截图证明
                                    const fs = require('fs');
                                    const path = require('path');
                                    const photoDir = path.join(process.cwd(), 'screenshots');
                                    if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });
                                    const safeUser = user.username.replace(/[^a-z0-9]/gi, '_');
                                    const skipShotPath = path.join(photoDir, `${safeUser}_skip.png`);
                                    try { await page.screenshot({ path: skipShotPath, fullPage: true }); } catch (e) { }

                                    await sendTelegramMessage(`⏳ *暂无法续期 (跳过)*\n用户: ${user.username}\n原因: 还没到时间\n下次可用: ${dateStr}`, skipShotPath);

                                    renewSuccess = true; // 标记完成，跳出重试
                                    try {
                                        const closeBtn = modal.getByRole('button', { name: 'Close' });
                                        if (await closeBtn.isVisible()) await closeBtn.click();
                                    } catch (e) { }
                                    break;
                                }

                                // 检查是否有验证码错误提示
                                if (await page.getByText('Please complete the captcha to continue').isVisible().catch(() => false)) {
                                    console.log('   >> ⚠️ 检测到错误: "Please complete the captcha". 需要进行 Turnstile 验证.');
                                    hasCaptchaError = true;
                                    break;
                                }

                                await page.waitForTimeout(300);
                            }
                        } catch (e) { }

                        if (renewSuccess) break; // 还没到时间，直接结束当前用户

                        if (hasCaptchaError) {
                            console.log('   >> 尝试通过 Turnstile CDP 绕过验证码...');
                            for (let findAttempt = 0; findAttempt < 10; findAttempt++) {
                                const ok = await attemptTurnstileCdp(page);
                                if (ok) {
                                    await page.waitForTimeout(3000);
                                    await confirmBtn.click();
                                    break;
                                }
                                await page.waitForTimeout(1000);
                            }
                            console.log('   >> 刷新页面重试...');
                            await page.reload();
                            await page.waitForTimeout(3000);
                            continue;
                        }

                        // F. 检查成功 (模态框消失)
                        await page.waitForTimeout(2000);
                        if (!await modal.isVisible()) {
                            console.log('   >> ✅ Modal closed. Renew successful!');

                            // 截图成功状态
                            const fs = require('fs');
                            const path = require('path');
                            const photoDir = path.join(process.cwd(), 'screenshots');
                            if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });
                            const safeUser = user.username.replace(/[^a-z0-9]/gi, '_');
                            const successShotPath = path.join(photoDir, `${safeUser}_success.png`);
                            try { await page.screenshot({ path: successShotPath, fullPage: true }); } catch (e) { }

                            await sendTelegramMessage(`✅ *续期成功*\n用户: ${user.username}\n状态: 服务器已成功续期！`, successShotPath);
                            renewSuccess = true;
                            break;
                        } else {
                            console.log('   >> 模态框仍打开但无错误？重试循环...');
                            await page.reload();
                            await page.waitForTimeout(3000);
                            continue;
                        }
                    } else {
                        console.log('   >> 未找到模态框内的验证按钮？刷新中...');
                        await page.reload();
                        await page.waitForTimeout(3000);
                        continue;
                    }

                } else {
                    console.log('未找到 Renew 按钮 (服务器可能已续期或页面加载错误)。');
                    break;
                }
            }
        } catch (err) {
            console.error(`Error processing user:`, err);
        }

        // Snapshot before handling next user
        // In GitHub Actions, we save to 'screenshots' dir
        const fs = require('fs');
        const path = require('path');
        const photoDir = path.join(process.cwd(), 'screenshots');
        if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });
        // 使用不包含账号信息的编号作为文件名 (避免公开 Artifact 暴露真实邮箱)
        const screenshotPath = path.join(photoDir, `user_${i + 1}.png`);
        try {
            await page.screenshot({ path: screenshotPath, fullPage: true });
            console.log(`截图已保存至: ${screenshotPath}`);
        } catch (e) {
            console.log('截图失败:', e.message);
        }

        console.log(`用户处理完成\n`);
    }

    console.log('完成。');
    await browser.close();
    process.exit(0);
})();
