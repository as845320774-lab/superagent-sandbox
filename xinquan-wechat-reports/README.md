# xinquan-wechat-reports — 市场日报采集器

把「新圈/私圈」两个微信群的推广日报（xlsx）从微信文件缓存采集出来，落盘后交给
Codex 更新市场数据，再把中文简报转发到飞书主群。

## 本次改动：苹果（七麦ASA）日报邮箱自动抓取

苹果搜索广告（ASA）的日报不是走微信，而是由七麦邮局（`no-reply2@qimai.cn`）每天
推送到老板的 163 邮箱。本改动新增一个邮箱抓取步骤，接入现有采集链路：

- `fetch-asa-mail.py` — 用 Python 标准库 `imaplib` 连 163 邮箱（IMAP 993/SSL），
  抓取当天「七麦ASA … 数据推送」邮件的 xlsx 附件，按规范名
  `私圈-苹果-日报.xlsx` 落盘到 `destination` 目录。幂等（内容不变则跳过），
  当天未到则输出空、不算错误。
- `collect.js` — 新增 `fetchEmailReport()`，在微信扫描之后、计算当天清单之前调用，
  把邮箱抓到的苹果日报并入当天采集清单（`presentNames`），随其余日报一起复制进
  项目 inbox、交给 Codex。仅在当天微信日报已到位时才并入，避免单凭一封邮件触发 Codex。

### 163 邮箱的 IMAP 注意事项

163/Coremail 会拒绝不发 `IMAP ID` 扩展的客户端（`SELECT` 返回
`Unsafe Login. Please contact kefu@188.com`）。`fetch-asa-mail.py` 在登录前发送
`ID ("name" "Thunderbird" ...)` 解决。

163 只接受「客户端授权码」登录，不接受登录密码；授权码在 163 网页版
「设置 → POP3/SMTP/IMAP」里生成。

## 部署位置

这些文件部署在（不在本仓库之外有任何运行时依赖）：

```
~/Library/Application Support/XinquanWeChatReports/
├── collect.js          # 采集器（本仓库的完整拷贝）
├── fetch-asa-mail.py   # 邮箱抓取脚本（本仓库的完整拷贝）
├── config.json         # 本地私有配置（含授权码，不提交仓库）
└── ...
```

`config.example.json` 是配置模板；真实的 `config.json` 含 163 授权码，仅保存在本地，
不进 git。

## 验证

- `python3 fetch-asa-mail.py` 能连上 `imap.163.com:993`，抓到当天
  「七麦ASA - 私圈-同城兴趣小圈子 - 2026-11-20 数据推送」的 xlsx 附件（7911 字节），
  落盘为 `私圈-苹果-日报.xlsx`，重复运行显示 `unchanged`（幂等）。
- `node collect.js --no-codex` 完整跑通：微信 4 份日报 `unchanged` + 邮箱苹果日报
  并入清单 + 复制进项目 inbox（`data/inbox/wechat-reports/<date>/`），
  `last-run.json` 记录 `email: 私圈-苹果-日报.xlsx`。
- 简报口径无需改动：`collect.js` 的 Codex 提示词里「私圈：小米、华为、苹果」渠道
  枚举已包含苹果，明天采集起自然纳入。
