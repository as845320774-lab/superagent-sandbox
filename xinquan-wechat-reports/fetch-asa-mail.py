#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
fetch-asa-mail.py — 从 163 邮箱抓取当天「七麦ASA（苹果搜索广告）」日报 xlsx 附件，
落盘到微信日报采集器的 destination 目录（规范文件名见 config.email.canonicalName），
供 collect.js 纳入当天市场数据采集。

- 只读邮箱，幂等（附件内容不变则跳过重写）。
- 当天没有匹配邮件时正常退出、stdout 输出为空（= 日报未到），不算错误。
- 成功时 stdout 输出规范文件名（collect.js 据此把文件纳入采集清单）。
- 运行日志写 stderr，错误时退出码非 0。

依赖：仅 Python 3 标准库（imaplib / email / ssl）。
"""

import hashlib
import imaplib
import json
import os
import sys
import time
from email.header import decode_header
from email.parser import BytesParser
from email.policy import default
from email.utils import parsedate_to_datetime

SUPPORT = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(SUPPORT, "config.json")


def log(msg):
    print("[%s] %s" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg), file=sys.stderr)


def decode_header_value(value):
    if not value:
        return ""
    parts = []
    for data, enc in decode_header(value):
        if isinstance(data, bytes):
            parts.append(data.decode(enc or "utf-8", errors="replace"))
        else:
            parts.append(data)
    return "".join(parts)


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def connect_imap(cfg):
    # 163/Coremail 会拒绝不发送 IMAP ID 扩展的客户端（SELECT 报 Unsafe Login）。
    if "ID" not in imaplib.Commands:
        imaplib.Commands["ID"] = ("NONAUTH", "AUTH", "SELECTED")
    m = imaplib.IMAP4_SSL(cfg["imapHost"], int(cfg.get("imapPort", 993)))
    m._simple_command("ID", '("name" "Thunderbird" "version" "1.0")')
    m._untagged_response("OK", None, "ID")
    m.login(cfg["user"], cfg["authCode"])
    return m


def walk_parts(part):
    """Yield (part) for every MIME part, depth-first."""
    yield part
    if part.is_multipart():
        for sub in part.get_payload():
            for p in walk_parts(sub):
                yield p


def attachment_filename(part):
    name = part.get_filename()
    if name:
        return decode_header_value(name)
    return None


def find_xlsx_attachment(msg):
    """Return decoded bytes of the first .xlsx attachment, or None."""
    for part in walk_parts(msg):
        disp = (part.get("Content-Disposition") or "").lower()
        name = attachment_filename(part)
        if name and name.lower().endswith(".xlsx"):
            payload = part.get_payload(decode=True)
            if payload:
                return payload, name
        # 某些推送把附件标成 octet-stream 且无 disposition，按文件名兜底。
        if disp.startswith("attachment") or (name and name.lower().endswith((".xlsx", ".xls"))):
            payload = part.get_payload(decode=True)
            if payload:
                return payload, name or "report.xlsx"
    return None


def imap_date(today):
    """把 YYYY-MM-DD 转成 IMAP SEARCH 的 d-Mon-yyyy（如 20-Nov-2026）。"""
    import datetime
    d = datetime.datetime.strptime(today, "%Y-%m-%d")
    return d.strftime("%-d-%b-%Y")


def find_latest_match(m, cfg, today):
    """找到今天匹配发件人/主题的最新一封邮件，返回其 RFC822 原始字节或 None。"""
    status, data = m.select("INBOX", readonly=True)
    if status != "OK":
        raise RuntimeError("SELECT INBOX failed: %r" % (data,))

    status, data = m.search(None, "(SINCE %s)" % imap_date(today))
    if status != "OK":
        raise RuntimeError("SEARCH failed: %r" % (data,))

    sender_needle = cfg.get("senderContains", "qimai.cn")
    subject_needle = cfg.get("subjectContains", "七麦ASA")
    ids = data[0].split()
    best = None  # (datetime, raw_bytes)
    for i in ids:
        status, msg_data = m.fetch(i, "(RFC822)")
        if status != "OK":
            continue
        raw = msg_data[0][1]
        msg = BytesParser(policy=default).parsebytes(raw)
        frm = decode_header_value(msg.get("From", ""))
        subj = decode_header_value(msg.get("Subject", ""))
        if sender_needle not in frm and sender_needle not in (msg.get("From") or ""):
            continue
        if subject_needle and subject_needle not in subj:
            continue
        when = None
        try:
            when = parsedate_to_datetime(msg.get("Date"))
        except Exception:
            when = None
        if best is None or (when and best[0] and when > best[0]):
            best = (when, raw)
    return best[1] if best else None


def write_attachment(payload, dest_dir, canonical_name):
    os.makedirs(dest_dir, exist_ok=True)
    target = os.path.join(dest_dir, canonical_name)
    if os.path.exists(target) and sha256_file(target) == hashlib.sha256(payload).hexdigest():
        return target, False  # unchanged
    tmp = target + ".tmp"
    with open(tmp, "wb") as f:
        f.write(payload)
    os.replace(tmp, target)
    return target, True


def main():
    args = sys.argv[1:]
    date_arg = None
    if "--date" in args:
        date_arg = args[args.index("--date") + 1]
    today = date_arg or time.strftime("%Y-%m-%d")

    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        config = json.load(f)
    email_cfg = config.get("email") or {}
    if not email_cfg.get("enabled", False):
        log("email fetch disabled; skip")
        return 0
    canonical = email_cfg.get("canonicalName", "私圈-苹果-日报.xlsx")
    dest_dir = os.path.expanduser(config.get("destination") or "")

    m = connect_imap(email_cfg)
    try:
        raw = find_latest_match(m, email_cfg, today)
    finally:
        try:
            m.logout()
        except Exception:
            pass

    if raw is None:
        log("no matching ASA email for %s (日报未到)" % today)
        return 0

    msg = BytesParser(policy=default).parsebytes(raw)
    found = find_xlsx_attachment(msg)
    if not found:
        log("matching email found but no xlsx attachment for %s" % today)
        return 0

    payload, orig_name = found
    target, changed = write_attachment(payload, dest_dir, canonical)
    log("saved %s (%d bytes, %s) from attachment %r" % (
        canonical, len(payload), "updated" if changed else "unchanged", orig_name))
    sys.stdout.write(canonical + "\n")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001
        log("error: %s" % e)
        sys.exit(1)
