#!/usr/bin/env node
'use strict';

/*
 * Xinquan WeChat daily-report collector.
 *
 * Runs as Node through /Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness
 * (ELECTRON_RUN_AS_NODE=1) from a LaunchAgent, because the harness has the macOS
 * permission needed to read WeChat's container. It copies today's promo reports
 * from the two WeChat groups' file cache into
 * /Users/mc/Desktop/新圈数据分析/推广数据 and then asks Codex to update market data.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const HOME = os.homedir();
const SUPPORT = path.join(HOME, 'Library', 'Application Support', 'XinquanWeChatReports');
const CONFIG_PATH = path.join(SUPPORT, 'config.json');
const STATE_PATH = path.join(SUPPORT, 'state.json');
const LAST_RUN_PATH = path.join(SUPPORT, 'last-run.json');
const LOCK_PATH = path.join(SUPPORT, 'run.lock');
const RUN_LOG = path.join(SUPPORT, 'collector.log');
const CODEX_LOG_DIR = path.join(SUPPORT, 'codex');
const WECHAT_ROOT = process.env.XINQUAN_WECHAT_ROOT || path.join(
  HOME,
  'Library', 'Containers', 'com.tencent.xinWeChat', 'Data', 'Documents', 'xwechat_files'
);

const DEFAULTS = {
  destination: path.join(HOME, 'Desktop', '新圈数据分析', '推广数据'),
  historyDirName: '历史',
  projectDir: path.join(HOME, 'Documents', '新圈数据分析'),
  codexBin: '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex',
  codexEnabled: true,
  codexReasoningEffort: 'medium',
  codexTimeoutMinutes: 45,
  maxCodexAttemptsPerDay: 2,
  excludeNamePatterns: ['百度', '关键词'],
};

function pad(n) { return String(n).padStart(2, '0'); }
function localDate(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function today() { return localDate(new Date()); }
function monthKey(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; }
function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return fallback; }
}
function writeJsonAtomic(p, obj) {
  const tmp = p + '.tmp';
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, p);
}
function sha256(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  console.log(line);
  try { fs.appendFileSync(RUN_LOG, line + '\n'); } catch (_) { /* ignore */ }
}

const config = Object.assign({}, DEFAULTS, readJson(CONFIG_PATH, {}));
if (process.env.XINQUAN_DESTINATION) config.destination = process.env.XINQUAN_DESTINATION;
if (process.env.XINQUAN_PROJECT_DIR) config.projectDir = process.env.XINQUAN_PROJECT_DIR;

function isReport(name) {
  if (!/\.(xlsx|xls|csv)$/i.test(name)) return false;
  for (const excluded of config.excludeNamePatterns || []) {
    if (name.includes(excluded)) return false;
  }
  // vivo reports use the 【私圈】vivo日报数据-... convention.
  if (/vivo/i.test(name) && /日报/.test(name)) return true;
  // 新圈/私圈 reports, including 新圈商店  日报 and 新圈-华为&鸿蒙日报.
  return /^(新圈|私圈|【新圈】|【私圈】)/.test(name) && /日报/.test(name);
}

function baseName(name) {
  return name.replace(/\s*\(\d+\)(?=\.[^.]+$)/, '');
}

function scanWechat(todayStr) {
  const candidates = new Map();
  const now = new Date();
  const months = [monthKey(now), monthKey(new Date(now.getFullYear(), now.getMonth() - 1, 1))];

  let accounts = [];
  try {
    accounts = fs.readdirSync(WECHAT_ROOT);
  } catch (e) {
    log('cannot read WeChat root:', e.code, e.message);
    return [];
  }

  for (const account of accounts) {
    if (!account.startsWith('wxid_')) continue;
    for (const month of months) {
      const dir = path.join(WECHAT_ROOT, account, 'msg', 'file', month);
      let names;
      const started = Date.now();
      try {
        names = fs.readdirSync(dir);
      } catch (e) {
        if (e.code !== 'ENOENT') log('scan error', dir, e.code, e.message);
        continue;
      }
      log(`scanned ${dir} (${names.length} entries, ${Date.now() - started} ms)`);
      for (const name of names) {
        if (!isReport(name)) continue;
        const filePath = path.join(dir, name);
        let st;
        try { st = fs.statSync(filePath); } catch (e) { log('stat failed', filePath, e.code); continue; }
        if (localDate(new Date(st.mtimeMs)) !== todayStr) continue;
        const base = baseName(name);
        const prev = candidates.get(base);
        if (!prev ||
            st.mtimeMs > prev.mtimeMs ||
            (st.mtimeMs === prev.mtimeMs && name.length < prev.name.length)) {
          candidates.set(base, { name, path: filePath, mtimeMs: st.mtimeMs, size: st.size, base });
        }
      }
    }
  }
  return [...candidates.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh'));
}

function requiredMissing(names) {
  const checks = [
    ['新圈-小米日报', (n) => /^新圈-小米-日报/.test(n)],
    ['私圈-小米日报', (n) => /^私圈-小米-日报/.test(n)],
    ['新圈商店日报', (n) => /^新圈商店\s+日报/.test(n)],
    ['华为日报', (n) => /^(新圈|私圈)-华为/.test(n)],
    ['苹果日报', (n) => /^私圈-苹果-日报/.test(n)],
  ];
  return checks.filter(([, fn]) => !names.some(fn)).map(([label]) => label);
}

function copyOne(candidate, dest, todayStr) {
  const dst = path.join(dest, candidate.name);
  if (fs.existsSync(dst)) {
    try {
      if (sha256(dst) === sha256(candidate.path)) return 'unchanged';
    } catch (_) { /* fall through and replace */ }
    const dstStat = fs.statSync(dst);
    const backupDate = localDate(new Date(dstStat.mtimeMs));
    const backupDir = path.join(dest, config.historyDirName, backupDate);
    fs.mkdirSync(backupDir, { recursive: true });
    fs.renameSync(dst, path.join(backupDir, `${candidate.name}.prev-${Date.now()}`));
  }
  fs.copyFileSync(candidate.path, dst);
  const st = fs.statSync(candidate.path);
  fs.utimesSync(dst, st.atime, st.mtime);
  return 'copied';
}

function archiveOldReports(dest, todayStr) {
  const moved = [];
  let entries = [];
  try { entries = fs.readdirSync(dest); } catch (e) { log('cannot list destination', dest, e.code); return moved; }
  for (const name of entries) {
    if (!isReport(name)) continue;
    const source = path.join(dest, name);
    let st;
    try { st = fs.statSync(source); } catch (_) { continue; }
    if (!st.isFile()) continue;
    const fileDate = localDate(new Date(st.mtimeMs));
    if (fileDate >= todayStr) continue;
    const dir = path.join(dest, config.historyDirName, fileDate);
    fs.mkdirSync(dir, { recursive: true });
    let target = path.join(dir, name);
    if (fs.existsSync(target)) {
      target = path.join(dir, `${name}.${Date.now()}`);
    }
    try {
      fs.renameSync(source, target);
      moved.push(path.relative(dest, target));
    } catch (e) {
      log('archive failed', name, e.code, e.message);
    }
  }
  return moved;
}

function buildPrompt(todayStr, dest, files, projectInbox, missing) {
  const fileLines = files.map((f) => `- ${f}`).join('\n');
  const missingLine = missing.length
    ? `今天应到五类日报，实际收到 ${files.length} 类；未到的：${missing.join('、')}。`
    : '今天应到的五类日报都已收到。';
  return `今天是 ${todayStr}。两个微信群的推广日报已经自动下载，苹果（七麦ASA）日报从邮箱自动下载。

项目内副本（优先从这里读取）：
${projectInbox}
${fileLines}

桌面副本（给用户查看）：
${dest}

${missingLine}

请在 /Users/mc/Documents/新圈数据分析（Codex 的“新圈数据分析”项目）中完成今天（${todayStr}）的市场数据更新：

1. 只使用上面列出的今天这批日报；不要把旧日报或旧快照当成今天的数据。
2. 参考项目现有的市场日报更新流程（例如 outputs/2026-11-03-市场日报更新/import_spend.py 和 outputs/2026-11-05-近7天经营数据/prepare.py），核对已收到日报的口径（应到五类：新圈-小米、私圈-小米、新圈商店、新圈-华为/鸿蒙、私圈-苹果）。私圈-苹果-日报.xlsx 是七麦ASA（苹果搜索广告）推送：读「广告系列组」sheet，消耗取「支出(¥)」列（该列是文本，需转成数值后求和），「广告系列组ID」作为 campaign_id，platform 记为 apple，导入 data/staging/ad-spend-history.csv；该报表只有「安装次数(经点击)」、没有注册字段，不要把安装数当成注册数。
3. 把原始日报归档到项目现有位置（data/raw/ad-spend/${todayStr}/ 或项目约定位置），更新 data/staging/ad-spend-history.csv 和相关的市场/经营数据产物。
4. 运行项目已有的校验，确认明细与汇总一致、日期覆盖正确；刷新需要更新的仪表盘数据。
5. 不要发送 Telegram；不要修改与本任务无关的代码、凭据或线上配置；不要删除历史数据。
6. 未到的日报渠道在最终报告中标注为“日报未到/未更新”，不要用旧数据补齐，也不要因此停止其余已到渠道的更新；如果已收到的日报口径异常或校验失败，再停止并说明原因。
7. 完成后用中文给出“市场数据简报”正文，格式固定如下（这是直接推送到飞书的内容，不要额外标题、表格或客套话，数字用阿拉伯数字，金额保留两位小数）：
   第 1 行：当日消耗合计：X元；收入X元；新增X用户，注册成本X元（注册成本=当日消耗合计÷当日新增用户）；暂算ROI X，近7天ROI X
   第 2 行：按“新圈小米消耗X元，注册单价X元；新圈荣耀消耗X元，注册单价X元；……”的写法，逐项列出今天所有有消耗的渠道（新圈：小米、荣耀、华为、鸿蒙；私圈：小米、华为、苹果），一个渠道都不能漏。注册单价取该渠道今日日报中的注册成本/注册均价字段（注册成本=消耗÷注册量），当日无注册或该字段为“--”时写“注册单价—”；私圈苹果（七麦ASA）只有安装数、无注册数据，注册单价写“—”，安装数放到第 3 行附带说明；今天未收到日报的渠道不要用旧数据补，放到末行统一说明。
   第 3 行（最多两句）：数据截至X月X日；如有日报未到/未更新要写明，并明确写“数据完整”或“数据不完整”（数据不完整时注明“ROI暂算”）。
   不要写归档、台账、校验过程、Telegram、本地文件链接等内部细节。`;
}

function copyToProjectInbox(files, todayStr) {
  if (!files.length) return null;
  const dir = path.join(config.projectDir, 'data', 'inbox', 'wechat-reports', todayStr);
  fs.mkdirSync(dir, { recursive: true });
  for (const name of files) {
    const src = path.join(config.destination, name);
    const dst = path.join(dir, name);
    try {
      if (fs.existsSync(dst)) {
        try { if (sha256(dst) === sha256(src)) continue; } catch (_) { /* replace */ }
      }
      fs.copyFileSync(src, dst);
      const st = fs.statSync(src);
      fs.utimesSync(dst, st.atime, st.mtime);
    } catch (e) {
      log('project inbox copy failed', name, e.code || '', e.message);
    }
  }
  log(`project inbox: ${dir}`);
  return dir;
}

/**
 * 从邮箱抓取当天「七麦ASA（苹果搜索广告）」日报 xlsx 附件到 destination，
 * 返回规范文件名（如 私圈-苹果-日报.xlsx），当天未到或抓取失败返回 null。
 * 抓取逻辑在 fetch-asa-mail.py（Python 标准库 imaplib，无需额外依赖）。
 */
function fetchEmailReport(todayStr) {
  const emailCfg = config.email || {};
  if (!emailCfg.enabled) return Promise.resolve(null);
  return new Promise((resolve) => {
    const py = spawn('/usr/bin/python3',
      [path.join(SUPPORT, 'fetch-asa-mail.py'), '--date', todayStr], {
        cwd: SUPPORT,
        env: Object.assign({}, process.env, { HOME, LANG: 'zh_CN.UTF-8' }),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    let out = '';
    let err = '';
    py.stdout.on('data', (d) => { out += d; });
    py.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => { try { py.kill('SIGTERM'); } catch (_) {} }, 120000);
    py.on('error', (e) => {
      clearTimeout(timer);
      log('email fetch spawn error:', e.message);
      resolve(null);
    });
    py.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        log(`email fetch failed (exit ${code}): ${err.slice(-300)}`);
        resolve(null);
        return;
      }
      const lastLine = err.trim().split('\n').pop();
      if (lastLine) log(`email fetch: ${lastLine}`);
      const name = out.trim().split('\n').pop();
      resolve(name || null);
    });
  });
}

function runCodex(todayStr, dest, files, projectInbox, missing) {
  if (!config.codexEnabled) {
    log('Codex disabled by config; skip');
    return Promise.resolve({ status: 'disabled' });
  }
  const state = readJson(STATE_PATH, {});
  const previous = state.codex || {};
  const attemptsToday = previous.date === todayStr ? (previous.attempts || 0) : 0;

  if (previous.date === todayStr && previous.status === 'success') {
    log('Codex already succeeded today; skip');
    return Promise.resolve(previous);
  }
  if (previous.date === todayStr && previous.status === 'running' &&
      Date.now() - (previous.startedAt || 0) < 2 * 60 * 60 * 1000) {
    log('Codex is still running; skip');
    return Promise.resolve(previous);
  }
  if (attemptsToday >= config.maxCodexAttemptsPerDay) {
    log(`Codex attempt cap reached (${attemptsToday}); skip`);
    return Promise.resolve(previous);
  }

  const attempt = attemptsToday + 1;
  const startedAt = Date.now();
  const record = {
    date: todayStr,
    status: 'running',
    attempts: attempt,
    startedAt,
    files,
  };
  state.codex = record;
  writeJsonAtomic(STATE_PATH, state);

  fs.mkdirSync(CODEX_LOG_DIR, { recursive: true });
  const logPath = path.join(CODEX_LOG_DIR, `codex-${todayStr}-attempt${attempt}.log`);
  const lastMessagePath = path.join(CODEX_LOG_DIR, `codex-${todayStr}-attempt${attempt}-last.txt`);
  const prompt = buildPrompt(todayStr, dest, files, projectInbox, missing);
  log(`starting Codex attempt ${attempt}; log ${logPath}`);

  return new Promise((resolve) => {
    let fd;
    let child;
    try {
      fd = fs.openSync(logPath, 'a');
      child = spawn(config.codexBin, [
        'exec',
        '-C', config.projectDir,
        '--skip-git-repo-check',
        '--dangerously-bypass-approvals-and-sandbox',
        '--color', 'never',
        '-c', `model_reasoning_effort="${config.codexReasoningEffort}"`,
        '-c', 'notify=[]',
        '-o', lastMessagePath,
        '-',
      ], {
        cwd: config.projectDir,
        env: Object.assign({}, process.env, {
          PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin',
          LANG: 'zh_CN.UTF-8',
          TERM: 'dumb',
          NO_COLOR: '1',
        }),
        stdio: ['pipe', fd, fd],
      });
    } catch (e) {
      log('failed to spawn Codex:', e.message);
      if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {}
      record.status = 'failed';
      record.error = e.message;
      record.finishedAt = Date.now();
      state.codex = record;
      writeJsonAtomic(STATE_PATH, state);
      resolve(record);
      return;
    }

    let finished = false;
    const finish = (code, error) => {
      if (finished) return;
      finished = true;
      try { fs.closeSync(fd); } catch (_) {}
      let sessionId = null;
      try {
        const text = fs.readFileSync(logPath, 'utf8');
        const match = text.match(/session id:\s*([0-9a-f-]{36})/);
        if (match) sessionId = match[1];
      } catch (_) {}
      record.status = code === 0 ? 'success' : 'failed';
      record.exitCode = code;
      record.finishedAt = Date.now();
      record.sessionId = sessionId;
      if (error) record.error = error;
      state.codex = record;
      writeJsonAtomic(STATE_PATH, state);
      log(`Codex attempt ${attempt} finished: ${record.status} (exit ${code})` +
          (sessionId ? ` session ${sessionId}` : ''));
      resolve(record);
    };

    child.on('error', (e) => {
      log('Codex process error:', e.message);
      finish(-1, e.message);
    });
    child.stdin.on('error', () => { /* Codex may close stdin early */ });
    try {
      child.stdin.write(prompt);
      child.stdin.end();
    } catch (e) {
      log('failed to send prompt to Codex:', e.message);
    }

    const timer = setTimeout(() => {
      log(`Codex exceeded ${config.codexTimeoutMinutes} minutes; terminating`);
      try { child.kill('SIGTERM'); } catch (_) {}
      setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 30000);
    }, config.codexTimeoutMinutes * 60 * 1000);

    child.on('close', (code) => {
      clearTimeout(timer);
      finish(code === null ? -1 : code);
    });
  });
}

function acquireLock() {
  fs.mkdirSync(SUPPORT, { recursive: true });
  try {
    fs.writeFileSync(LOCK_PATH, String(process.pid), { flag: 'wx' });
    return;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
  let pid = 0;
  try { pid = parseInt(fs.readFileSync(LOCK_PATH, 'utf8'), 10); } catch (_) {}
  let alive = false;
  if (pid) {
    try { process.kill(pid, 0); alive = true; } catch (_) { alive = false; }
  }
  if (alive) {
    log(`another collector is already running (pid ${pid}); exit`);
    process.exit(0);
  }
  try { fs.unlinkSync(LOCK_PATH); } catch (_) {}
  fs.writeFileSync(LOCK_PATH, String(process.pid), { flag: 'wx' });
}

function releaseLock() {
  try {
    if (parseInt(fs.readFileSync(LOCK_PATH, 'utf8'), 10) === process.pid) {
      fs.unlinkSync(LOCK_PATH);
    }
  } catch (_) { /* ignore */ }
}

async function main() {
  fs.mkdirSync(SUPPORT, { recursive: true });
  fs.mkdirSync(CODEX_LOG_DIR, { recursive: true });
  const args = process.argv.slice(2);
  const noCodex = args.includes('--no-codex');
  const todayStr = today();

  acquireLock();
  process.on('exit', releaseLock);

  log(`run start: date=${todayStr}, noCodex=${noCodex}, dest=${config.destination}`);
  fs.mkdirSync(config.destination, { recursive: true });

  const candidates = scanWechat(todayStr);
  const candidateNames = candidates.map((c) => c.name);
  log(`today's candidate reports (${candidates.length}): ${candidateNames.join(', ') || '(none)'}`);

  const copied = [];
  const archived = [];
  if (candidates.length > 0) {
    for (const candidate of candidates) {
      try {
        const status = copyOne(candidate, config.destination, todayStr);
        copied.push({ name: candidate.name, status });
        log(`copy ${candidate.name}: ${status}`);
      } catch (e) {
        log(`copy failed ${candidate.name}: ${e.code || ''} ${e.message}`);
      }
    }
    if (copied.some((x) => x.status === 'copied' || x.status === 'unchanged')) {
      archived.push(...archiveOldReports(config.destination, todayStr));
      if (archived.length) log(`archived old reports: ${archived.join(', ')}`);
    }
  } else {
    log('no reports for today yet; nothing copied');
  }

  const emailName = await fetchEmailReport(todayStr);
  const presentNames = candidateNames.filter((name) =>
    fs.existsSync(path.join(config.destination, name))
  );
  // 邮箱苹果日报是补充渠道：仅在当天微信日报已到位时纳入，避免单凭一封邮件触发 Codex。
  if (emailName && presentNames.length > 0 &&
      fs.existsSync(path.join(config.destination, emailName)) &&
      !presentNames.includes(emailName)) {
    presentNames.push(emailName);
    log(`email report included: ${emailName}`);
  }
  const missing = requiredMissing(presentNames);
  const projectInbox = presentNames.length
    ? copyToProjectInbox(presentNames, todayStr)
    : null;
  const summary = {
    date: todayStr,
    runAt: new Date().toISOString(),
    candidates: candidateNames,
    email: emailName,
    copied,
    archived,
    missing,
    projectInbox,
    codex: null,
  };

  writeJsonAtomic(LAST_RUN_PATH, summary);

  if (presentNames.length === 0) {
    log('no reports available today; Codex not triggered');
    return;
  }
  if (noCodex) {
    log('--no-codex supplied; Codex not triggered');
    return;
  }

  const codex = await runCodex(todayStr, config.destination, presentNames, projectInbox, missing);
  summary.codex = codex;
  summary.finishedAt = new Date().toISOString();
  writeJsonAtomic(LAST_RUN_PATH, summary);
  log('run finished');
}

main().catch((e) => {
  log('fatal error:', e.stack || e.message);
  releaseLock();
  process.exit(1);
});
