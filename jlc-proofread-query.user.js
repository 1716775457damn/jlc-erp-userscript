// ==UserScript==
// @name         JLC ERP 机器库校对快查
// @namespace    https://local.yamaha-migrate/
// @version      1.16.21
// @description  机器库校对；私有库提货申请（查客编/填单）；登录态落盘/恢复；云目录大批量 list
// @updateURL    http://127.0.0.1:8787/userscripts/jlc-proofread-query.user.js
// @downloadURL  http://127.0.0.1:8787/userscripts/jlc-proofread-query.user.js
// @author       yamaha_migrate_gui
// @match        https://mh.jlcerp.com/*
// @match        https://nw.jlcerp.com/*
// @connect      nw.jlcerp.com
// @connect      mh.jlcerp.com
// @connect      sso.jlcerp.com
// @connect      127.0.0.1
// @connect      localhost
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_cookie
// @grant        GM_download
// @grant        GM_setClipboard
// @grant        unsafeWindow
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const VERSION = "1.16.21";
  /** CTU 货位页「最近入库时间」默认近 7 天会查不到老料；与页面一致字段，起点固定 2020-01-01 */
  const CTU_SHELVES_IN_STOCK_START = "2020-01-01";
  const SITE = "jlc";
  /** 与立创商城油猴分流：poll 只取本脚本可执行 action */
  const BRIDGE_CAPABLE =
    "ping,query,list_mach_libs,list,download,export_cookie,sync_cookie,get_selection,template_classify,classify_template,query_template,list_unique_templates,dump_templates,private_pick_lookup,private_pick_fill";
  /**
   * CTU 呼出总开关：当前阶段只测「查容器号 → 容器列表勾选」，禁止点呼出/调 callout API。
   * 后续验收通过后再改为 true。
   */
  const CTU_CALLOUT_ENABLED = false;
  const CTU_PENDING_KEY = "jlc_ctu_pending_v1";
  /**
   * 私有库提货：自动提交总开关。附件/包裹号未确认前禁止走 save API。
   * 本阶段只做：库位查客编+库存 → 打开新增页填单（用途=重新入库/备注=校对）。
   */
  const PRIVATE_PICK_SUBMIT_ENABLED = false;
  const PRIVATE_PICK_PENDING_KEY = "jlc_private_pick_pending_v1";
  /** 使用用途：1生产维修 2客户提货 3重新入库 4ECN 5前台申请 */
  const PRIVATE_PICK_USE_PURPOSE_RE_INBOUND = 3;
  const PRIVATE_PICK_DEFAULT_REMARK = "校对";
  const PRIVATE_PICK_COMPONENT_SOURCES = ["preSale", "customer", "shopPrivate"];
  /** 单条桥命令最长执行时间；超时强制清 busy，避免 ERP 空等 180s */
  /** single bridge command max runtime; timed-out commands force-release busy to avoid ERP waiting forever.
   *  download commands get a longer budget aligned with the ERP-side wait (180 + 45*(n-1) seconds, capped at 600). */
  const BRIDGE_CMD_TIMEOUT_MS = 150000;
  const BRIDGE_BUSY_WATCHDOG_MS = 165000;
  const BRIDGE_CMD_TIMEOUT_DOWNLOAD_MS = 610000;
  const BRIDGE_BUSY_WATCHDOG_DOWNLOAD_MS = 620000;
  function isDownloadAction(action) {
    return String(action || "").toLowerCase().includes("download");
  }
  function bridgeCmdTimeoutMs(action) {
    return isDownloadAction(action)
      ? BRIDGE_CMD_TIMEOUT_DOWNLOAD_MS
      : BRIDGE_CMD_TIMEOUT_MS;
  }
  function bridgeBusyWatchdogMs(action) {
    return isDownloadAction(action)
      ? BRIDGE_BUSY_WATCHDOG_DOWNLOAD_MS
      : BRIDGE_BUSY_WATCHDOG_MS;
  }
  /**
   * 现场：打开 nw.jlcerp.com 常被门户重定向到 mh。此时 hostname=mh，但可用 Cookie+GM_XHR 调 nw API。
   * nw 标签仍优先（rank 更高）；仅 mh 时也能 poll/下载。
   */
  const API_CTU_SHELVES_LIST =
    "/api/smtstockproduce/ctuComponentBindShelvesWeb/list";
  const API_CTU_CONTAINER_LIST =
    "/api/smtstockproduce/ctuContainerWeb/list";
  const API_CTU_CONTAINER_CALLOUT =
    "/api/smtstockproduce/ctuContainerWeb/callout";
  /** 物料位置列表（库位页 normal tab）— 仅功能内按需查询，禁止当启动主页 */
  const API_SHELVES_BIND_LIST =
    "/api/smtstockproduce/shelvesManage/selectShelvesComponentBindList";
  const API_MIX_SHELVES_BIND_LIST =
    "/api/smtstockproduce/shelvesManage/selectMixComponentBindShelvesListWithStock";
  /** 私有库提货：选料对话框列表 */
  const API_PRIVATE_PICK_COMPONENTS =
    "/api/smtstockproduce/smtCustomerPrivatePick/pageComponentByCondition";
  // CTU 显式跳转才用容器列表 URL；库位 materialLocation 已废弃（禁止当主页/自动打开）
  const URL_CONTAINER_LIST =
    "https://mh.jlcerp.com/#/sub-app?page=https://nw.jlcerp.com/smtstockproduce/%23/ctuManage/containerList";
  const URL_CONTAINER_LIST_NW =
    "https://nw.jlcerp.com/smtstockproduce/#/ctuManage/containerList";
  const URL_PRIVATE_PICK_ADD_NW =
    "https://nw.jlcerp.com/smtstockproduce/#/smtStockManage/smtCustomerPrivateStockDeliveryreqAdd";
  const URL_PRIVATE_PICK_ADD_MH =
    "https://mh.jlcerp.com/#/sub-app?page=https://nw.jlcerp.com/smtstockproduce/%23/smtStockManage/smtCustomerPrivateStockDeliveryreqAdd";
  const URL_NW_HOME = "https://nw.jlcerp.com/";
  /** 贴片机机器库 SPA：进入后才会下发 SMT_ERP_SESSION_ID；仅开 mh 首页会假登录+460 */
  const URL_MACHINE_LIB_NW =
    "https://nw.jlcerp.com/smtbaseservice/#/common/index";
  const URL_MACHINE_LIB_MH =
    "https://mh.jlcerp.com/#/sub-app?page=https://nw.jlcerp.com/smtbaseservice/%23/common/index";
  const BRIDGE_DEFAULT_PORT = 18765;
  const BRIDGE_DEFAULT_TOKEN = "yamaha-jlc-bridge";
  const BRIDGE_POLL_MS = 800;
  /** 前台心跳 2s；后台标签页 Chrome 会节流 timer，故后台改 12s + watchdog */
  const BRIDGE_HEARTBEAT_MS_VISIBLE = 2000;
  const BRIDGE_HEARTBEAT_MS_HIDDEN = 30000;
  const BRIDGE_WATCHDOG_MS = 10000;
  const BRIDGE_STALE_MS = 45000;
  /** 多标签：仅主标签 poll 命令，副标签仍发 heartbeat */
  const BRIDGE_LEADER_KEY = "jlc_bridge_leader_v1";
  const BRIDGE_LEADER_TTL_MS = 25000;
  const TAB_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  /** 每隔多少次空闲 poll，顺带把 Cookie 推到本机 config */
  const BRIDGE_COOKIE_SYNC_EVERY = 40;
  /** 登录态 Cookie 汇总缓存 TTL */
  const AUTH_CACHE_TTL_MS = 60000;
  /** nw REST 真探测缓存（有 Cookie≠JWT 有效） */
  const NW_PROBE_TTL_MS = 45000;
  const API_BASE = "/api/smtbaseservice";
  const API_PATH =
    API_BASE + "/smtNewMachine/v1/queryMachCmpLibList";
  const API_URL = "https://nw.jlcerp.com" + API_PATH;
  const API_DOWNLOAD_CSV =
    API_BASE + "/smtNewMachine/v1/downloadCsv";
  const API_DOWNLOAD_JSON =
    API_BASE + "/SmtNewMachineFile/v1/downloadJsonFile";
  const API_DOWNLOAD_PROOFREAD =
    API_BASE + "/smtNewMachine/v1/downloadAndProofreading";
  /** 元器件绑定封装库模板 */
  const API_BIND_QUERY =
    API_BASE +
    "/smtComponentBindFootprintRecordWebController/queryRecordPageList";
  const BIND_LOOKBACK_MS = 7776e6;
  const BIND_PAGE_SIZE = 100;
  const BIND_MAX_PAGES = 30;

  /** REST 会话通常需要的关键 Cookie（缺则 GUI 易 460） */
  const IMPORTANT_COOKIE_KEYS = [
    "ERP_SSO_JWT",
    "SMT_ERP_SESSION_ID",
    "JLCWORK_SESSION_ID",
    "ERP_SSO_SESSION_ID",
    "DEVICEID",
    "GROUP_PORTAL_SESSION_ID",
    "FIN_MH_SESSION_ID",
  ];

  /** @type {{ at: number, map: Record<string, string>|null, header: string, restHeader: string, info: object|null }} */
  let authCache = { at: 0, map: null, header: "", restHeader: "", info: null };
  /** 并发 getAuthSession 合并为一次采集 */
  let authInflight = null;
  /** invalidate 后递增，丢弃仍在飞行中的陈旧采集结果 */
  let authGeneration = 0;
  /** @type {{ at: number, ok: boolean|null, error: string }} */
  let nwProbeCache = { at: 0, ok: null, error: "" };
  /** 非 460 的瞬时网络失败：连续 N 次才翻 false，避免 FAB/ERP 假掉线 */
  let nwProbeFailStreak = 0;
  const NW_PROBE_SOFT_FAIL_MAX = 3;
  let nwProbeInflight = null;
  let heartbeatProbeCounter = 0;

  /** @type {Record<string, string>} */
  const STATUS_MAP = {
    "1": "需校对",
    "2": "校对中",
    "3": "已校对",
  };

  const PANEL_ID = "jlc-proofread-panel";
  const STYLE_ID = "jlc-proofread-style";

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /** 出库码客户位：C27636975K1 → C27636975 */
  function stripCustomerKSuffix(code) {
    const u = String(code || "").trim().toUpperCase();
    const k = u.indexOf("K");
    if (k > 1 && /^C\d+$/.test(u.slice(0, k))) return u.slice(0, k);
    return u;
  }

  function normalizeStockCode(raw) {
    let s = String(raw || "").trim().toUpperCase();
    // ERP：优先 "c": / pc: / 音近写「赔偿」
    const erp = s.match(/(?:["']\s*C\s*["']|(?:^|[^A-Z0-9_])PC|赔偿)\s*[:=：]\s*["']?(C\d{4,}[A-Z0-9]*)/i);
    if (erp) {
      s = stripCustomerKSuffix(erp[1]);
    } else {
      const m = s.match(/(?<![A-Z0-9-])C\d{4,}/);
      if (m) s = stripCustomerKSuffix(m[0]);
    }
    if (/^\d+$/.test(s)) s = "C" + s;
    return s;
  }

  /** 解析多个 C 编码：支持空格/逗号/分号/换行分隔，或粘贴 ERP 扫码串 */
  function parseStockCodes(raw) {
    const text = String(raw || "");
    const found = [];
    const push = (s) => {
      s = stripCustomerKSuffix(String(s || "").toUpperCase());
      if (/^\d{5,}$/.test(s)) s = "C" + s;
      if (!/^C\d{5,}$/.test(s)) return;
      if (!found.includes(s)) found.push(s);
    };
    const erpAll = text.matchAll(
      /(?:["']\s*c\s*["']|(?:^|[^A-Za-z0-9_])pc|赔偿)\s*[:=：]\s*["']?(C\d{4,}[A-Za-z0-9]*)/gi
    );
    for (const m of erpAll) push(m[1]);
    if (found.length) return found;
    // 键名残缺：仍取引号内 C…K1（如 {'JJC…",":"C9900312309K1",…}）
    for (const m of text.matchAll(/["'](C\d{4,}[A-Za-z0-9]*)["']/gi)) push(m[1]);
    if (found.length) return found;
    const re = /C\d{4,}/gi;
    let m;
    while ((m = re.exec(text))) {
      const start = m.index;
      const prev = start > 0 ? text[start - 1] : "";
      if (/[A-Za-z0-9-]/.test(prev)) continue;
      push(m[0]);
    }
    return found;
  }

  function stockCodeVariants(raw) {
    const key = normalizeStockCode(raw);
    const out = [key];
    if (key.startsWith("C") && key.length > 1) out.push(key.slice(1));
    return out;
  }

  function statusLabel(code) {
    if (code == null || code === "") return "（无状态）";
    return STATUS_MAP[String(code)] || `未知(${code})`;
  }

  function statusColor(code) {
    const c = String(code);
    if (c === "1") return "#f82f53";
    if (c === "2") return "#fba42b";
    if (c === "3") return "#56b351";
    return "#666";
  }

  function parseApiResponse(http, text) {
    let json;
    try {
      json = JSON.parse(text);
    } catch (_) {
      throw new Error(`响应非 JSON HTTP ${http}: ${String(text).slice(0, 200)}`);
    }
    if (http === 460 || json.status === 460 || json.code === 460) {
      throw new Error(SESSION_EXPIRED_MSG);
    }
    if (http >= 400 && json.code !== 200) {
      throw new Error(json.message || `HTTP ${http}`);
    }
    return json;
  }

  function isSessionExpiredError(err) {
    const msg = String((err && err.message) || err || "");
    return msg.includes("460") || /会话失效/.test(msg);
  }

  const SESSION_EXPIRED_MSG =
    "会话失效(460)：请重新登录嘉立创（mh/nw 跳转均可）。油猴需能用 Cookie 调通 nw API；若刚登录请稍等或点「立即同步 Cookie」。";

  function isOnNwHost() {
    return /nw\.jlcerp\.com$/i.test(location.hostname);
  }

  function isOnMhHost() {
    return /mh\.jlcerp\.com$/i.test(location.hostname);
  }

  /** 本页能否接下载：nw 本机 credentials，或 mh 经 Cookie XHR 探测成功 */
  function canServeJlcDownload() {
    if (isOnNwHost()) return true;
    return nwProbeCache.ok === true;
  }

  /** Chrome / Edge 均可；同站点不要两个浏览器同时开（登录态不共用，会抢桥）。 */
  function browserKind() {
    const ua = String(navigator.userAgent || "");
    if (/Edg\//.test(ua)) return "edge";
    if (/Chrome\//.test(ua)) return "chrome";
    return "other";
  }

  function browserBridgeQs() {
    return (
      `&browser=${encodeURIComponent(browserKind())}` +
      `&visible=${document.hidden ? "0" : "1"}`
    );
  }

  function nwBridgeQs() {
    let nwQs = "";
    if (nwProbeCache.ok === true) nwQs = "&nw_ok=1";
    else if (nwProbeCache.ok === false) nwQs = "&nw_ok=0";
    // 上报 host+path，便于区分门户 mh 与机器库 smtbaseservice（Toolkit 据此决定是否再开标签）
    const pathHint = `${location.hostname}${location.pathname || "/"}${(location.hash || "").slice(0, 96)}`;
    return nwQs + `&page_host=${encodeURIComponent(pathHint)}`;
  }

  function pageFetch() {
    try {
      if (typeof unsafeWindow !== "undefined" && typeof unsafeWindow.fetch === "function") {
        return unsafeWindow.fetch.bind(unsafeWindow);
      }
    } catch (_) {}
    return fetch;
  }

  function invalidateAuthSession() {
    authGeneration += 1;
    authCache = { at: 0, map: null, header: "", restHeader: "", info: null };
    authInflight = null;
    nwProbeCache = { at: 0, ok: null, error: "" };
    nwProbeFailStreak = 0;
    nwProbeInflight = null;
  }

  /**
   * 真探测 nw REST。
   * nw 页：credentials；mh 页（被门户跳转后常见）：Cookie + GM_XHR 调 https://nw.jlcerp.com。
   */
  async function probeNwSession(force) {
    if (
      !force &&
      nwProbeCache.ok !== null &&
      Date.now() - nwProbeCache.at < NW_PROBE_TTL_MS
    ) {
      return nwProbeCache;
    }
    if (!force && nwProbeInflight) return nwProbeInflight;
    const run = (async () => {
      try {
        const { json, http } = await apiPost({
          pageNum: 1,
          pageSize: 1,
          sortFieldList: [],
        });
        if (http === 460 || (json && (json.status === 460 || json.code === 460))) {
          throw new Error(SESSION_EXPIRED_MSG);
        }
        nwProbeFailStreak = 0;
        nwProbeCache = { at: Date.now(), ok: true, error: "" };
        maybePersistLoginState(false).catch(() => {});
      } catch (e) {
        const msg = String((e && e.message) || e || SESSION_EXPIRED_MSG);
        if (isSessionExpiredError(e) || /460|会话失效|JWT/.test(msg)) {
          invalidateAuthSession();
          nwProbeFailStreak = NW_PROBE_SOFT_FAIL_MAX;
          nwProbeCache = { at: Date.now(), ok: false, error: SESSION_EXPIRED_MSG };
          hintStayOnNwTab();
        } else {
          nwProbeFailStreak += 1;
          // 曾成功过：瞬时失败保持 ok=true，避免 ERP「油猴掉线」闪烁
          if (nwProbeCache.ok === true && nwProbeFailStreak < NW_PROBE_SOFT_FAIL_MAX) {
            nwProbeCache = {
              at: Date.now(),
              ok: true,
              error: `soft-fail ${nwProbeFailStreak}/${NW_PROBE_SOFT_FAIL_MAX}: ${msg}`,
            };
          } else {
            nwProbeCache = { at: Date.now(), ok: false, error: msg };
          }
        }
      }
      return nwProbeCache;
    })();
    nwProbeInflight = run;
    try {
      return await run;
    } finally {
      if (nwProbeInflight === run) nwProbeInflight = null;
    }
  }

  async function ensureNwRestAlive() {
    const r = await probeNwSession(true);
    if (!r.ok) {
      hintStayOnNwTab();
      throw new Error(r.error || SESSION_EXPIRED_MSG);
    }
    return r;
  }

  /** 只提示，绝不 window.open 库位页；机器库 SPA 可点开一次 */
  function hintStayOnNwTab() {
    try {
      const mapHint = (() => {
        try {
          const m = authCache && authCache.map;
          if (m && !m.SMT_ERP_SESSION_ID) {
            return "缺 SMT_ERP_SESSION_ID：请打开机器库页 smtbaseservice";
          }
        } catch (_) {}
        return "";
      })();
      const where = isOnMhHost()
        ? "当前在 mh 门户首页不够，需进入贴片机机器库（smtbaseservice）"
        : "请保持机器库页已登录";
      updateBridgeUi(
        `本机桥：nw API 不可用 · ${mapHint || where} v${VERSION}${bridgeStatusSuffix()}`,
        false
      );
    } catch (_) {}
  }

  function machineLibUrl() {
    return isOnMhHost() ? URL_MACHINE_LIB_MH : URL_MACHINE_LIB_NW;
  }

  /** 进入机器库以领取 SMT 会话（非库位页） */
  function openMachineLibToRefreshSession() {
    try {
      location.assign(machineLibUrl());
    } catch (_) {
      try {
        window.open(URL_MACHINE_LIB_NW, "_blank");
      } catch (__) {}
    }
    hintStayOnNwTab();
  }

  function openNwLoginTabOnce() {
    openMachineLibToRefreshSession();
  }

  /** 给跨域 API 用的精简 Cookie（避免把无关域字段塞进 nw） */
  function cookieMapToRestHeader(map) {
    const keys = new Set(IMPORTANT_COOKIE_KEYS);
    Object.keys(map || {}).forEach((k) => {
      if (/^(ERP_|SMT_|JLC|DEVICE|GROUP_|FIN_|SSO)/i.test(k)) keys.add(k);
    });
    return [...keys]
      .filter((k) => map[k])
      .sort()
      .map((k) => `${k}=${map[k]}`)
      .join("; ");
  }

  /** 复用已登录 Cookie；force=true 时强制重采；并发调用合并 */
  async function getAuthSession(force) {
    if (
      !force &&
      authCache.map &&
      Date.now() - authCache.at < AUTH_CACHE_TTL_MS
    ) {
      return authCache;
    }
    if (!force && authInflight) return authInflight;

    const gen = authGeneration;
    const task = (async () => {
      const map = await collectCookieMap();
      // 采集期间若已 invalidate（如 460），勿把旧 Cookie 写回缓存
      if (gen !== authGeneration) {
        return getAuthSession(true);
      }
      const info = analyzeCookieMap(map);
      const header = cookieMapToHeader(map);
      const restHeader = cookieMapToRestHeader(map) || header;
      authCache = { at: Date.now(), map, header, restHeader, info };
      return authCache;
    })();

    if (!force) {
      authInflight = task.finally(() => {
        if (authGeneration === gen) authInflight = null;
      });
      return authInflight;
    }
    return task;
  }

  function readXsrfToken() {
    try {
      const m = String(document.cookie || "").match(
        /(?:^|;\s*)XSRF-TOKEN=([^;]+)/
      );
      return m ? decodeURIComponent(m[1]) : "";
    } catch (_) {
      return "";
    }
  }

  function buildErpHeaders(asBlob, cookieHeader) {
    const secretkey = GM_getValue("secretkey", "") || "";
    const headers = {
      "Content-Type": "application/json",
      Accept: asBlob ? "*/*" : "application/json, text/plain, */*",
    };
    if (secretkey) headers.secretkey = secretkey;
    const xsrf = readXsrfToken();
    if (xsrf) headers["X-XSRF-TOKEN"] = xsrf;
    // mh/sso 页走 GM 跨域时不会自动带 nw 登录态，显式复用 Cookie
    if (cookieHeader && !isOnNwHost()) {
      headers.Cookie = cookieHeader;
    }
    return headers;
  }

  async function blobOrSessionError(http, blob) {
    if (http === 460) throw new Error(SESSION_EXPIRED_MSG);
    if (!blob) return { http, blob };
    const ctype = String((blob && blob.type) || "");
    // 下载接口偶发用 JSON 报 460/业务错，勿当 zip
    if (ctype.includes("json") || ctype.includes("text") || blob.size < 512) {
      try {
        const text = await blob.text();
        if (/460|会话失效|JWT/i.test(text) || text.trim().startsWith("{")) {
          parseApiResponse(http, text); // 抛业务错 / 460
        }
        // 不是 JSON 错则还原不了，继续用原 blob 会丢内容；小体积再试一次解析
        if (text.trim().startsWith("{")) {
          throw new Error(text.slice(0, 200));
        }
      } catch (e) {
        if (e && e.message) throw e;
      }
    }
    return { http, blob };
  }

  function erpFetchOnce(url, headers, body, asBlob, timeout, useAnonymous) {
    if (isOnNwHost()) {
      return pageFetch()(url, {
        method: "POST",
        credentials: "include",
        headers,
        body: JSON.stringify(body),
      }).then(async (res) => {
        if (asBlob) {
          const blob = await res.blob();
          return blobOrSessionError(res.status, blob);
        }
        const text = await res.text();
        return { http: res.status, json: parseApiResponse(res.status, text) };
      });
    }
    return new Promise((resolve, reject) => {
      const opts = {
        method: "POST",
        url,
        headers,
        data: JSON.stringify(body),
        withCredentials: !useAnonymous,
        responseType: asBlob ? "blob" : "text",
        timeout: timeout || (asBlob ? 120000 : 30000),
        onload(res) {
          try {
            if (asBlob) {
              blobOrSessionError(res.status, res.response).then(resolve, reject);
            } else {
              resolve({
                http: res.status,
                json: parseApiResponse(res.status, res.responseText),
              });
            }
          } catch (err) {
            reject(err);
          }
        },
        onerror() {
          reject(
            new Error(
              asBlob
                ? "下载网络错误"
                : "网络错误，请确认已登录且可访问 nw.jlcerp.com"
            )
          );
        },
        ontimeout() {
          reject(new Error(asBlob ? "下载超时" : "请求超时"));
        },
      };
      // Tampermonkey：自定义 Cookie 头需 anonymous，否则会被浏览器 Cookie 覆盖/忽略
      if (useAnonymous) opts.anonymous = true;
      GM_xmlhttpRequest(opts);
    });
  }

  /**
   * 统一 ERP POST：同页 credentials；跨域复用缓存 Cookie；460 清缓存后按场景重试
   */
  async function erpRequest(path, body, opt) {
    opt = opt || {};
    const asBlob = !!opt.asBlob;
    const timeout = opt.timeout || (asBlob ? 120000 : 30000);
    const onNw = isOnNwHost();
    const url = onNw
      ? path
      : path.indexOf("http") === 0
        ? path
        : "https://nw.jlcerp.com" + path;

    const run = async (forceAuth) => {
      let cookieHeader = "";
      let useAnonymous = false;
      if (!onNw) {
        const auth = await getAuthSession(forceAuth);
        cookieHeader = (auth && (auth.restHeader || auth.header)) || "";
        // 首次与重试都校验：有 Cookie 但无 JWT/SESSION 时勿匿名硬打
        if (auth && auth.info && !auth.info.okForRest) {
          throw new Error(
            "会话不完整：缺少 JWT/SESSION，请重新登录 ERP 后点「导出 Cookie」"
          );
        }
        useAnonymous = !!cookieHeader;
      }
      const headers = buildErpHeaders(asBlob, cookieHeader);
      return erpFetchOnce(url, headers, body, asBlob, timeout, useAnonymous);
    };

    try {
      return await run(false);
    } catch (err) {
      if (!isSessionExpiredError(err)) throw err;
      invalidateAuthSession();
      if (onNw) {
        try {
          const auth = await getAuthSession(true);
          const cookieHeader = (auth && (auth.restHeader || auth.header)) || "";
          if (auth && auth.info && auth.info.okForRest && cookieHeader) {
            const headers = buildErpHeaders(asBlob, cookieHeader);
            headers.Cookie = cookieHeader;
            return await erpFetchOnce(url, headers, body, asBlob, timeout, true);
          }
        } catch (e2) {
          if (!isSessionExpiredError(e2)) throw e2;
        }
        throw new Error(SESSION_EXPIRED_MSG);
      }
      return await run(true);
    }
  }

  function apiPost(body) {
    return erpRequest(API_PATH, body, { timeout: 30000 });
  }

  function apiPostRaw(path, body, asBlob) {
    return erpRequest(path, body, { asBlob: !!asBlob });
  }

  /** GET JSON（私有库选料等接口） */
  async function erpGet(path, query, opt) {
    opt = opt || {};
    const timeout = opt.timeout || 30000;
    const onNw = isOnNwHost();
    const qs = Object.keys(query || {})
      .filter((k) => query[k] != null && String(query[k]).trim() !== "")
      .map(
        (k) =>
          encodeURIComponent(k) + "=" + encodeURIComponent(String(query[k]))
      )
      .join("&");
    const pathWithQs = qs ? path + (path.indexOf("?") >= 0 ? "&" : "?") + qs : path;
    const url = onNw
      ? pathWithQs
      : pathWithQs.indexOf("http") === 0
        ? pathWithQs
        : "https://nw.jlcerp.com" + pathWithQs;

    const run = async (forceAuth) => {
      let cookieHeader = "";
      let useAnonymous = false;
      if (!onNw) {
        const auth = await getAuthSession(forceAuth);
        cookieHeader = (auth && (auth.restHeader || auth.header)) || "";
        if (auth && auth.info && !auth.info.okForRest) {
          throw new Error(
            "会话不完整：缺少 JWT/SESSION，请重新登录 ERP 后点「导出 Cookie」"
          );
        }
        useAnonymous = !!cookieHeader;
      }
      const headers = buildErpHeaders(false, cookieHeader);
      delete headers["Content-Type"];
      if (onNw) {
        const res = await pageFetch()(url, {
          method: "GET",
          credentials: "include",
          headers,
        });
        const text = await res.text();
        return { http: res.status, json: parseApiResponse(res.status, text) };
      }
      return new Promise((resolve, reject) => {
        const opts = {
          method: "GET",
          url,
          headers,
          withCredentials: !useAnonymous,
          responseType: "text",
          timeout,
          onload(res) {
            try {
              resolve({
                http: res.status,
                json: parseApiResponse(res.status, res.responseText),
              });
            } catch (err) {
              reject(err);
            }
          },
          onerror() {
            reject(new Error("网络错误，请确认已登录且可访问 nw.jlcerp.com"));
          },
          ontimeout() {
            reject(new Error("请求超时"));
          },
        };
        if (useAnonymous) opts.anonymous = true;
        GM_xmlhttpRequest(opts);
      });
    };

    try {
      return await run(false);
    } catch (err) {
      if (!isSessionExpiredError(err)) throw err;
      invalidateAuthSession();
      return await run(true);
    }
  }

  /** 找到贴片机机器库列表 Vue 实例（含勾选行） */
  function findMachineListVm() {
    const roots = [
      document.querySelector(".SMTMachineBaseList"),
      document.querySelector(".mainContent"),
      ...document.querySelectorAll("[class*='SMTMachine']"),
    ].filter(Boolean);
    for (const el of roots) {
      let cur = el;
      for (let i = 0; i < 8 && cur; i++) {
        const vm = cur.__vue__;
        if (vm) {
          const cand = [vm, vm.$parent, vm.$children && vm.$children[0]].filter(
            Boolean
          );
          for (const v of cand) {
            if (
              v &&
              Array.isArray(v.multipleSelection) &&
              typeof v.handleDownload === "function"
            ) {
              return v;
            }
            if (v && Array.isArray(v.multipleSelection)) return v;
          }
        }
        cur = cur.parentElement;
      }
    }
    // 宽松扫描
    const all = document.querySelectorAll("*");
    for (const el of all) {
      const vm = el.__vue__;
      if (
        vm &&
        Array.isArray(vm.multipleSelection) &&
        Array.isArray(vm.tableData)
      ) {
        return vm;
      }
    }
    return null;
  }

  function getSelectedRowsFromPage() {
    const vm = findMachineListVm();
    if (vm && vm.multipleSelection && vm.multipleSelection.length) {
      return vm.multipleSelection.slice();
    }
    return [];
  }

  function accessIdsFromRows(rows) {
    const ids = [];
    const labels = [];
    (rows || []).forEach((r) => {
      const id = r.componentLibAccessId || r.id;
      if (id) {
        ids.push(id);
        labels.push(r.stockCode || r.componentName || String(id));
      }
    });
    return { ids, labels };
  }

  async function resolveAccessIdsByStockCode(stockCode) {
    const code = normalizeStockCode(stockCode);
    let hit = null;
    for (const v of stockCodeVariants(code)) {
      const { json } = await apiPost({
        pageNum: 1,
        pageSize: 20,
        sortFieldList: [],
        stockCode: v,
      });
      if (json.code !== 200) continue;
      const { rows } = extractRows(json);
      hit = pickExactRow(rows, v);
      if (hit) break;
    }
    if (!hit) throw new Error(`未找到 ${code}，无法下载`);
    const id = hit.componentLibAccessId || hit.id;
    if (!id) {
      throw new Error(
        `${code} 无 componentLibAccessId（可能是克隆料，需页面重新扫描）`
      );
    }
    return {
      ids: [id],
      labels: [hit.stockCode || code],
      hit,
      missed: [],
    };
  }

  /** 批量解析多个 C 编码 → accessId；部分失败不中断 */
  async function resolveAccessIdsByStockCodes(rawOrList) {
    const codes = Array.isArray(rawOrList)
      ? rawOrList.map(normalizeStockCode).filter((c) => /^C\d+$/.test(c))
      : parseStockCodes(rawOrList);
    if (!codes.length) {
      throw new Error("未解析到 C 编码（可用空格/逗号/换行分隔多个）");
    }
    const ids = [];
    const labels = [];
    const missed = [];
    const hits = [];
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i];
      try {
        const r = await resolveAccessIdsByStockCode(code);
        ids.push(...r.ids);
        labels.push(...r.labels);
        if (r.hit) hits.push(r.hit);
      } catch (e) {
        missed.push(code + ": " + (e && e.message ? e.message : e));
        if (isSessionExpiredError(e)) {
          throw new Error(SESSION_EXPIRED_MSG);
        }
      }
      if (i > 0 && i % 3 === 0) {
        bridgeHeartbeatOnce().catch(() => {});
      }
    }
    if (!ids.length) {
      throw new Error("全部 C 编码均无法下载:\n" + missed.join("\n"));
    }
    return { ids, labels, missed, hits, requested: codes };
  }

  function triggerBlobDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    if (typeof GM_download === "function") {
      GM_download({ url, name: filename, saveAs: true });
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      return;
    }
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  /** 分页列出旧机器库（与 ERP 列表接口一致；dump 时可拉大批） */
  async function listMachCmpLibs(opt) {
    opt = opt || {};
    const pageSize = Math.min(Math.max(Number(opt.pageSize) || 100, 1), 200);
    // 全量云目录同步：单次最多 200 页 × 200 = 4 万行；ERP 循环翻页至 ~81 万
    const maxPages = Math.min(Math.max(Number(opt.maxPages) || 5, 1), 200);
    const maxRows = Math.min(Math.max(Number(opt.maxRows) || 200, 1), 50000);
    const startPage = Math.max(Number(opt.pageNum) || 1, 1);
    const skipSet = new Set(
      (Array.isArray(opt.skipCodes) ? opt.skipCodes : parseStockCodes(opt.skipCodes || "")).map(
        (c) => normalizeStockCode(c)
      )
    );
    const stockFilter = opt.stockCode ? normalizeStockCode(opt.stockCode) : "";

    const out = [];
    const seen = new Set();
    let total = null;
    let page = startPage;
    let pagesFetched = 0;

    while (pagesFetched < maxPages && out.length < maxRows) {
      const body = {
        pageNum: page,
        pageSize,
        sortFieldList: [],
      };
      if (stockFilter) body.stockCode = stockFilter;
      const { json } = await apiPost(body);
      if (json.code !== 200 && json.code !== 0 && json.code !== "200") {
        throw new Error(json.message || `列表失败 code=${json.code}`);
      }
      const extracted = extractRows(json);
      if (total == null) total = extracted.total;
      const rows = extracted.rows || [];
      if (!rows.length) break;

      for (const r of rows) {
        const sc = normalizeStockCode(r.stockCode || "");
        const aid = r.componentLibAccessId || r.id;
        if (!sc || !aid) continue;
        if (skipSet.has(sc)) continue;
        if (seen.has(sc)) continue;
        seen.add(sc);
        out.push({
          stockCode: sc,
          componentLibAccessId: aid,
          componentName: r.componentName || "",
          componentSpec: r.componentSpec || "",
          proofreadStatus: r.proofreadStatus,
        });
        if (out.length >= maxRows) break;
      }

      pagesFetched += 1;
      if (pagesFetched % 2 === 0) {
        bridgeHeartbeatOnce().catch(() => {});
      }
      if (out.length >= maxRows) break;
      if (typeof total === "number" && page * pageSize >= total) break;
      if (rows.length < pageSize) break;
      page += 1;
    }

    return {
      count: out.length,
      total: total,
      pagesFetched,
      pageSize,
      rows: out,
      ids: out.map((r) => r.componentLibAccessId),
      codes: out.map((r) => r.stockCode),
    };
  }

  /** 把 Cookie 字符串推到本机桥，写入 config/jlc_cookie.txt */
  function pushCookieToBridge(cookie, info) {
    const cfg = bridgeConfig();
    if (!cfg.enabled) {
      return Promise.resolve({ ok: false, skipped: true, error: "bridge disabled" });
    }
    const url = bridgeBaseUrl() + "/jlc/bridge/cookie";
    return gmHttpJson(
      "POST",
      url,
      {
        cookie: cookie || "",
        info: info || null,
        version: VERSION,
        href: location.href,
        ts: new Date().toISOString(),
      },
      { "X-Bridge-Token": cfg.token }
    )
      .then((res) => {
        if (res.http >= 200 && res.http < 300 && res.json && res.json.ok) {
          return Object.assign({ ok: true }, res.json);
        }
        return {
          ok: false,
          error:
            (res.json && res.json.error) ||
            `cookie sync HTTP ${res.http}`,
        };
      })
      .catch((e) => ({
        ok: false,
        error: String(e && e.message ? e.message : e),
      }));
  }

  const COOKIE_PERSIST_MS = 180000;
  const PERSIST_COOKIE_KEYS = ["ERP_SSO_JWT","SMT_ERP_SESSION_ID","JLCWORK_SESSION_ID","ERP_SSO_SESSION_ID"];

  function parseCookieHeader(header) {
    const map = {};
    String(header || "").split(";").forEach((part) => {
      const i = part.indexOf("=");
      if (i > 0) {
        const k = part.slice(0, i).trim();
        const v = part.slice(i + 1).trim();
        if (k) map[k] = v;
      }
    });
    return map;
  }

  function gmCookieSet(opts) {
    return new Promise((resolve) => {
      try {
        if (typeof GM_cookie === "function") {
          GM_cookie("set", opts, (error) => resolve(!error));
          return;
        }
      } catch (_) {}
      try {
        if (typeof GM !== "undefined" && GM.cookie && typeof GM.cookie.set === "function") {
          Promise.resolve(GM.cookie.set(opts)).then(() => resolve(true)).catch(() => resolve(false));
          return;
        }
      } catch (_) {}
      resolve(false);
    });
  }

  async function fetchCookieFromBridge() {
    const cfg = bridgeConfig();
    if (!cfg.enabled) return null;
    const url = bridgeBaseUrl() + "/jlc/bridge/cookie?token=" + encodeURIComponent(cfg.token);
    const res = await gmHttpJson("GET", url, null, { "X-Bridge-Token": cfg.token });
    if (res.http === 200 && res.json && res.json.ok && res.json.cookie) return res.json;
    return null;
  }

  async function applyPersistedCookies(cookieHeader) {
    const map = parseCookieHeader(cookieHeader);
    let n = 0;
    const exp = Math.floor(Date.now() / 1000) + 86400 * 7;
    for (const name of PERSIST_COOKIE_KEYS) {
      if (!map[name]) continue;
      const ok = await gmCookieSet({ name, value: map[name], domain: ".jlcerp.com", path: "/", secure: true, httpOnly: true, expirationDate: exp });
      if (ok) n += 1;
    }
    return n;
  }

  async function maybePersistLoginState(force) {
    const last = Number(GM_getValue("jlc_cookie_persist_at", 0) || 0);
    if (!force && Date.now() - last < COOKIE_PERSIST_MS) return false;
    try {
      const auth = await getAuthSession(false);
      if (!auth || !auth.info || !auth.info.okForRest) return false;
      const saved = await pushCookieToBridge(auth.header, auth.info);
      if (saved && saved.ok) {
        GM_setValue("jlc_cookie_persist_at", Date.now());
        GM_setValue("jlc_login_persist_meta", JSON.stringify({ at: Date.now(), hasSmt: !!auth.info.hasSmtSession, host: location.hostname, ver: VERSION }));
        return true;
      }
    } catch (_) {}
    return false;
  }

  async function tryRestoreLoginFromDisk() {
    try {
      const auth = await getAuthSession(true);
      if (auth && auth.info && auth.info.okForRest) return { ok: true, restored: false };
      const disk = await fetchCookieFromBridge();
      if (!disk || !disk.cookie) return { ok: false, restored: false, error: "no disk cookie" };
      const n = await applyPersistedCookies(disk.cookie);
      invalidateAuthSession();
      const again = await getAuthSession(true);
      const ok = !!(again && again.info && again.info.okForRest);
      if (ok) updateBridgeUi(`本机桥：已从磁盘恢复登录态 v${VERSION}（${n} cookies）`, true);
      return { ok, restored: n > 0, applied: n };
    } catch (e) {
      return { ok: false, restored: false, error: String((e && e.message) || e) };
    }
  }

  /**
   * 登录态统一入口：优先复用缓存，缺 JWT/SESSION 才强制重采；
   * 保证返回 { cookie, info }，cookie 过短时抛错。
   */
  async function getFreshLoginState() {
    let auth = await getAuthSession(false);
    if (!auth.info || !auth.info.okForRest) {
      auth = await getAuthSession(true);
    }
    const cookie = (auth && auth.header) || "";
    const info = auth.info || analyzeCookieMap((auth && auth.map) || {});
    if (!cookie || cookie.length < 20) {
      throw new Error("未读到 jlcerp Cookie，请确认已登录 nw.jlcerp.com，并允许 GM_cookie");
    }
    return { cookie, info };
  }

  async function syncCookieToBridge() {
    const { cookie, info } = await getFreshLoginState();
    const saved = await pushCookieToBridge(cookie, info);
    return {
      cookie,
      info,
      length: cookie.length,
      saved,
      message: saved.ok
        ? `Cookie 已写入本机 ${saved.path || "config/jlc_cookie.txt"}（${info.count} 字段）`
        : `Cookie 已采集但写入失败: ${saved.error || "unknown"}`,
    };
  }

  /** 把 zip 推到本机桥，解压入库 `_old_libs/{C编码}/` */
  function ingestZipToOldLibs(blob, filename, codes) {
    const cfg = bridgeConfig();
    if (!cfg.enabled) {
      return Promise.resolve({ ok: false, skipped: true, error: "bridge disabled" });
    }
    const codeList = Array.isArray(codes)
      ? codes
      : parseStockCodes(codes || "");
    const q =
      `token=${encodeURIComponent(cfg.token)}` +
      `&filename=${encodeURIComponent(filename || "lib.zip")}` +
      (codeList.length
        ? `&codes=${encodeURIComponent(codeList.join(","))}`
        : "");
    const url = bridgeBaseUrl() + "/jlc/bridge/ingest?" + q;
    bridgeHeartbeatOnce().catch(() => {});
    return blob.arrayBuffer().then(
      (buf) =>
        new Promise((resolve) => {
          GM_xmlhttpRequest({
            method: "POST",
            url,
            data: buf,
            binary: true,
            headers: {
              "Content-Type": "application/zip",
              "X-Bridge-Token": cfg.token,
              Accept: "application/json",
            },
            timeout: 120000,
            onload(res) {
              let json = null;
              try {
                json = res.responseText ? JSON.parse(res.responseText) : null;
              } catch (_) {
                json = null;
              }
              if (res.status >= 200 && res.status < 300 && json && json.ok) {
                resolve(Object.assign({ ok: true }, json));
              } else {
                resolve({
                  ok: false,
                  error:
                    (json && json.error) ||
                    `ingest HTTP ${res.status}: ${(res.responseText || "").slice(0, 160)}`,
                });
              }
            },
            onerror() {
              resolve({
                ok: false,
                error: "本机桥离线（请先启动 SMT 元件库 ERP）",
              });
            },
            ontimeout() {
              resolve({ ok: false, error: "ingest 超时" });
            },
          });
        })
    );
  }

  /** 优先入库 `_old_libs`；桥离线时回退浏览器下载 */
  async function saveMachineLibZip(blob, filename, codes) {
    const ingest = await ingestZipToOldLibs(blob, filename, codes);
    if (ingest && ingest.ok) {
      return {
        via: "old_libs",
        filename,
        bytes: blob.size,
        ingest,
      };
    }
    triggerBlobDownload(blob, filename);
    return {
      via: "browser_download",
      filename,
      bytes: blob.size,
      ingestError: ingest && ingest.error,
    };
  }

  /**
   * 下载选中/指定元件到本地（对齐页面「下载为 csv/json」与「批量校对」）
   * @param {"json"|"csv"|"proofread"} format
   * @param {{ids?: any[], labels?: string[], stockCode?: string, stockCodes?: string[]}} opt
   */
  async function downloadComponents(format, opt) {
    opt = opt || {};
    let ids = opt.ids || [];
    let labels = opt.labels || [];
    let missed = [];
    let requested = [];

    if (!ids.length && (opt.stockCodes || opt.stockCode || opt.codes)) {
      const r = await resolveAccessIdsByStockCodes(
        opt.stockCodes || opt.codes || opt.stockCode
      );
      ids = r.ids;
      labels = r.labels;
      missed = r.missed || [];
      requested = r.requested || [];
    }
    if (!ids.length) {
      const rows = getSelectedRowsFromPage();
      const r = accessIdsFromRows(rows);
      ids = r.ids;
      labels = r.labels;
    }
    if (!ids.length) {
      throw new Error(
        "请先在表格勾选元件，或在面板输入一个/多个 C 编码后再下载"
      );
    }

    const stamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .slice(0, 19);
    const nameHint =
      labels.length === 1
        ? String(labels[0]).replace(/[^\w\-C]/g, "_")
        : `batch_${ids.length}`;
    const codeHints = parseStockCodes(
      (labels || []).join(" ") +
        " " +
        (requested || []).join(" ") +
        " " +
        (opt.stockCodes
          ? Array.isArray(opt.stockCodes)
            ? opt.stockCodes.join(" ")
            : String(opt.stockCodes)
          : "") +
        " " +
        (opt.stockCode || "")
    );

    if (format === "json") {
      const { json } = await apiPostRaw(API_DOWNLOAD_JSON, ids, false);
      const url = json && json.data && json.data.downloadUrl;
      if (!url) throw new Error(json.message || "JSON 下载未返回 downloadUrl");
      const absUrl = /^https?:/i.test(url)
        ? url
        : "https://nw.jlcerp.com" + (url.startsWith("/") ? url : "/" + url);
      const resp = await fetch(absUrl, { credentials: "include" });
      if (!resp.ok) throw new Error(`拉取下载链接失败 HTTP ${resp.status}`);
      const remoteBlob = await resp.blob();
      if (!remoteBlob || remoteBlob.size < 10) {
        throw new Error("下载文件为空");
      }
      const fname = `贴片机机器库_${nameHint}_${stamp}.zip`;
      const saved = await saveMachineLibZip(remoteBlob, fname, codeHints);
      return {
        format,
        count: ids.length,
        labels,
        missed,
        requested,
        via: saved.via,
        bytes: remoteBlob.size,
        filename: fname,
        ingest: saved.ingest || null,
        ingestError: saved.ingestError || null,
      };
    }

    const path =
      format === "proofread" ? API_DOWNLOAD_PROOFREAD : API_DOWNLOAD_CSV;
    const fname =
      format === "proofread"
        ? `批量校对元器件_${nameHint}_${stamp}.zip`
        : `贴片机机器库_csv_${nameHint}_${stamp}.zip`;
    const { blob, http } = await apiPostRaw(path, ids, true);
    if (!blob || blob.size < 10) {
      throw new Error(`下载失败 HTTP ${http}，文件为空`);
    }
    if (blob.type && blob.type.includes("json")) {
      const text = await blob.text();
      throw new Error(text.slice(0, 200));
    }
    const saved = await saveMachineLibZip(blob, fname, codeHints);
    return {
      format,
      count: ids.length,
      labels,
      missed,
      requested,
      via: saved.via,
      bytes: blob.size,
      filename: fname,
      ingest: saved.ingest || null,
      ingestError: saved.ingestError || null,
    };
  }

  function parseDocumentCookie() {
    const map = {};
    String(document.cookie || "")
      .split(";")
      .forEach((part) => {
        const i = part.indexOf("=");
        if (i <= 0) return;
        const name = part.slice(0, i).trim();
        const value = part.slice(i + 1).trim();
        if (name) map[name] = value;
      });
    return map;
  }

  function listCookiesViaGmCookie(opts) {
    return new Promise((resolve) => {
      try {
        if (typeof GM !== "undefined" && GM.cookie && typeof GM.cookie.list === "function") {
          Promise.resolve(GM.cookie.list(opts || {}))
            .then((list) => resolve(list || []))
            .catch(() => resolve([]));
          return;
        }
        if (typeof GM_cookie === "function") {
          GM_cookie("list", opts || {}, (cookies) => resolve(cookies || []));
          return;
        }
      } catch (_) {}
      resolve([]);
    });
  }

  /**
   * 汇总多域名 Cookie，尽量拿到 JWT / SESSION。
   * 仅 document.cookie 往往只有 2～3 个，不够 REST。
   * 查询并行 + 结果进 authCache（见 getAuthSession）。
   */
  async function collectCookieMap() {
    const map = { ...parseDocumentCookie() };
    const add = (list) => {
      (list || []).forEach((c) => {
        if (c && c.name) map[c.name] = c.value;
      });
    };

    const queries = [
      { domain: ".jlcerp.com" },
      { url: "https://mh.jlcerp.com/" },
      { url: "https://sso.jlcerp.com/" },
      { url: "https://nw.jlcerp.com/" },
    ];
    const lists = await Promise.all(queries.map((q) => listCookiesViaGmCookie(q)));
    lists.forEach(add);
    add(await listCookiesViaGmCookie({ url: "https://nw.jlcerp.com/" }));
    return map;
  }

  function cookieMapToHeader(map) {
    return Object.keys(map)
      .sort()
      .map((k) => `${k}=${map[k]}`)
      .join("; ");
  }

  function analyzeCookieMap(map) {
    const keys = Object.keys(map);
    const present = IMPORTANT_COOKIE_KEYS.filter((k) => map[k]);
    const missing = IMPORTANT_COOKIE_KEYS.filter((k) => !map[k]);
    const hasJwt = !!map.ERP_SSO_JWT;
    const hasSession = !!(
      map.SMT_ERP_SESSION_ID ||
      map.JLCWORK_SESSION_ID ||
      map.ERP_SSO_SESSION_ID
    );
    const hasSmtSession = !!map.SMT_ERP_SESSION_ID;
    // 机器库 REST 实测需要 SMT_ERP_SESSION_ID；仅有 JWT/JLCWORK 仍会 460
    const okForRest = hasJwt && hasSmtSession;
    return {
      count: keys.length,
      present,
      missing,
      hasJwt,
      hasSession,
      hasSmtSession,
      okForRest,
      keys,
    };
  }

  async function exportRestCookieString() {
    const auth = await getAuthSession(false);
    return auth.header;
  }

  function setClipboardText(text) {
    if (typeof GM_setClipboard === "function") {
      GM_setClipboard(text, "text");
      return Promise.resolve();
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise((resolve, reject) => {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;left:-9999px;top:0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        resolve();
      } catch (e) {
        reject(e);
      } finally {
        ta.remove();
      }
    });
  }

  async function copyRestCookieToClipboard() {
    const { cookie, info } = await getFreshLoginState();
    await setClipboardText(cookie);
    return { cookie, info };
  }

  function downloadCookieFile(cookie) {
    const blobUrl =
      "data:text/plain;charset=utf-8," + encodeURIComponent(cookie);
    if (typeof GM_download === "function") {
      GM_download({
        url: blobUrl,
        name: "jlc_cookie.txt",
        saveAs: true,
      });
      return;
    }
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = "jlc_cookie.txt";
    a.click();
  }

  async function exportCookieForGui(autoDownload = true) {
    const { cookie, info } = await copyRestCookieToClipboard();
    let saved = null;
    try {
      saved = await pushCookieToBridge(cookie, info);
    } catch (_) {
      saved = null;
    }
    if (autoDownload && info.okForRest) {
      try {
        downloadCookieFile(cookie);
      } catch (_) {}
    }
    const lines = [
      `已复制完整 Cookie：${info.count} 个字段，${cookie.length} 字符`,
      "",
      info.okForRest
        ? "✅ 含 JWT/SESSION，可用于 GUI/CLI REST"
        : "⚠️ 缺少 JWT/SESSION，GUI 仍可能 460",
      info.present.length
        ? `已有: ${info.present.join(", ")}`
        : "已有关键字段: （无）",
      info.missing.length ? `缺少: ${info.missing.join(", ")}` : "",
      "",
      "剪贴板已写入真实 Cookie（请勿再复制本段提示文字）。",
      saved && saved.ok
        ? `✅ 已通过本机桥写入: ${saved.path || "config/jlc_cookie.txt"}`
        : saved
          ? `本机桥写入失败: ${saved.error || "unknown"}（可手动下载文件）`
          : "本机桥未写入（桥离线时可点「下载 cookie 文件」）",
      autoDownload && info.okForRest
        ? "已同时触发下载 jlc_cookie.txt → 请保存到 yamaha_migrate_gui\\config\\"
        : "或点「下载 cookie 文件」保存到 config 目录",
      "",
      "下一步：保持 ERP 页打开 + 本机桥在线，即可 --bridge-call download / list_mach_libs",
    ].filter(Boolean);

    return { cookie, info, message: lines.join("\n"), saved };
  }

  function pickExactRow(rows, stockCode) {
    const key = String(stockCode || "").toUpperCase();
    const digits = key.startsWith("C") ? key.slice(1) : key;
    return rows.find((r) => {
      const sc = String(r.stockCode || "").toUpperCase();
      return sc === key || sc === digits || sc === "C" + digits;
    });
  }

  function extractRows(json) {
    const data = json && json.data;
    if (!data) return { rows: [], total: 0 };
    const rows =
      data.data || data.list || data.records || data.rows || [];
    const total =
      data.totalRows || data.total || data.totalCount || rows.length;
    return { rows: Array.isArray(rows) ? rows : [], total };
  }

  async function queryOldLib(stockCode) {
    let last = { mode: "old", total: 0, rows: [], hit: null };
    for (const code of stockCodeVariants(stockCode)) {
      const { json } = await apiPost({
        pageNum: 1,
        pageSize: 20,
        sortFieldList: [],
        stockCode: code,
      });
      if (json.code !== 200) {
        throw new Error(json.message || `接口失败 code=${json.code}`);
      }
      const { rows, total } = extractRows(json);
      const hit = pickExactRow(rows, code);
      if (hit) return { mode: "old", total, rows, hit };
      last = { mode: "old", total, rows, hit: null };
    }
    return last;
  }

  async function queryNewLib(stockCode) {
    let lastTotal = 0;
    for (const code of stockCodeVariants(stockCode)) {
      const { json } = await apiPost({
        pageNum: 1,
        pageSize: 20,
        sortFieldList: [],
        stockCode: code,
        proofreadStatus: "3",
      });
      if (json.code !== 200) {
        throw new Error(json.message || `接口失败 code=${json.code}`);
      }
      const { rows, total } = extractRows(json);
      lastTotal = total;
      const hit = pickExactRow(rows, code);
      if (hit) {
        return { mode: "new", total, rows, hit, foundInProofread: true };
      }
    }
    return {
      mode: "new",
      total: lastTotal,
      rows: [],
      hit: null,
      foundInProofread: false,
    };
  }

  function formatOldResult(r, code) {
    if (!r.hit) {
      return { found: false, total: r.total, code };
    }
    return {
      found: true,
      total: r.total,
      stockCode: r.hit.stockCode,
      componentName: r.hit.componentName,
      componentSpecification: r.hit.componentSpecification,
      packaging: r.hit.packaging || r.hit.packageType || r.hit.footprint || "",
      proofreadStatus: r.hit.proofreadStatus,
      proofreadLabel: statusLabel(r.hit.proofreadStatus),
      lastUploadTime: r.hit.lastUploadTime,
    };
  }

  function formatNewResult(r) {
    if (!r.foundInProofread) {
      return { foundInProofread: false, total: r.total, label: "未校对" };
    }
    return {
      foundInProofread: true,
      total: r.total,
      label: "已校对",
      stockCode: r.hit.stockCode,
      componentName: r.hit.componentName,
      componentSpecification: r.hit.componentSpecification,
      proofreadStatus: r.hit.proofreadStatus,
      lastUploadTime: r.hit.lastUploadTime,
    };
  }

  async function queryProofread(raw, mode = "old") {
    const code = normalizeStockCode(raw);
    if (!/^C\d+$/i.test(code)) {
      throw new Error("无法解析 C 编码，请检查输入");
    }
    const result = { code, mode, old: null, new: null };
    if (mode === "both") {
      const [oldR, newR] = await Promise.all([
        queryOldLib(code),
        queryNewLib(code),
      ]);
      result.old = formatOldResult(oldR, code);
      result.new = formatNewResult(newR);
    } else if (mode === "old") {
      result.old = formatOldResult(await queryOldLib(code), code);
    } else {
      result.new = formatNewResult(await queryNewLib(code));
    }
    return result;
  }


  /** yyyy-MM-dd */
  function bindFmtDate(d) {
    const x = d instanceof Date ? d : new Date(d);
    const y = x.getFullYear();
    const m = String(x.getMonth() + 1).padStart(2, "0");
    const day = String(x.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function bindDefaultDateRange() {
    const end = new Date();
    const start = new Date(Date.now() - BIND_LOOKBACK_MS);
    return {
      updateStartTime: bindFmtDate(start),
      updateEndTime: bindFmtDate(end),
    };
  }

  function summarizeBindRow(row) {
    if (!row || typeof row !== "object") return null;
    return {
      componentCode: row.componentCode || "",
      stockCode: row.stockCode || "",
      templateName: row.templateName || "",
      firstTemplateName: row.firstTemplateName || "",
      templateType: row.templateType || "",
      componentName: row.componentName || "",
      componentSpecification: row.componentSpecification || "",
      currentVersion: row.currentVersion || "",
      bindStatus: row.bindStatus,
      produceStatus: row.produceStatus,
      footprintLibraryExist: row.footprintLibraryExist,
    };
  }

  async function queryBindPage(opt) {
    const dates = bindDefaultDateRange();
    const page = Number(opt.page || 1) || 1;
    const pageSize = Number(opt.pageSize || BIND_PAGE_SIZE) || BIND_PAGE_SIZE;
    const startDate =
      opt.updateStartTime != null && String(opt.updateStartTime).trim()
        ? String(opt.updateStartTime).trim()
        : dates.updateStartTime + " 00:00:00";
    const endDate =
      opt.updateEndTime != null && String(opt.updateEndTime).trim()
        ? String(opt.updateEndTime).trim()
        : dates.updateEndTime + " 23:59:59";
    const body = {
      componentCode: opt.componentCode ? String(opt.componentCode).trim() : "",
      templateName: opt.templateName ? String(opt.templateName).trim() : "",
      updateStartTime: startDate,
      updateEndTime: endDate,
      bindStatus: "",
      produceStatus: "",
      updateStatus: "",
      shelvesFlag: "",
      errorCorrectionStatus: "",
      assemblyProcess:
        opt.assemblyProcess != null ? String(opt.assemblyProcess).trim() : "",
      footprintLibraryExist: "",
      updateUserName: "",
      currePage: page,
      pageSize,
    };
    if (opt.templateType != null && String(opt.templateType).trim()) {
      body.templateType = String(opt.templateType).trim();
    }
    const { http, json } = await apiPostRaw(API_BIND_QUERY, body, false);
    if (http === 460 || (json && (json.status === 460 || json.code === 460))) {
      throw new Error("会话失效(460)，请重新登录 ERP 后再查模板");
    }
    if (!json || json.code !== 200) {
      throw new Error(
        (json && (json.message || json.msg)) ||
          `绑定页查询失败 HTTP ${http} code=${json && json.code}`
      );
    }
    const data = json.data || {};
    const rows = data.list || data.data || data.records || [];
    const total = data.total || data.totalRows || data.totalCount || rows.length;
    return {
      rows: Array.isArray(rows) ? rows : [],
      total: Number(total) || 0,
      page,
      pageSize,
    };
  }

  async function lookupBindByComponentCode(rawCode) {
    const code = normalizeStockCode(rawCode);
    let last = { code, hit: null, rows: [], total: 0 };
    for (const variant of stockCodeVariants(code)) {
      const { rows, total } = await queryBindPage({
        componentCode: variant,
        page: 1,
        pageSize: 50,
      });
      const key = String(variant).toUpperCase();
      const digits = key.startsWith("C") ? key.slice(1) : key;
      const hit =
        rows.find((r) => {
          const cc = String(r.componentCode || "").toUpperCase();
          const sc = String(r.stockCode || "").toUpperCase();
          return (
            cc === key ||
            cc === digits ||
            cc === "C" + digits ||
            sc === key ||
            sc === digits ||
            sc === "C" + digits
          );
        }) ||
        rows[0] ||
        null;
      if (hit) {
        return {
          code,
          hit: summarizeBindRow(hit),
          rows: rows.map(summarizeBindRow),
          total,
        };
      }
      last = { code, hit: null, rows: rows.map(summarizeBindRow), total };
    }
    return last;
  }

  async function listBindByTemplateName(templateName, opt) {
    const name = String(templateName || "").trim();
    if (!name) throw new Error("模板名称为空");
    const maxPages = Number((opt && opt.maxPages) || BIND_MAX_PAGES) || BIND_MAX_PAGES;
    const pageSize =
      Number((opt && opt.pageSize) || BIND_PAGE_SIZE) || BIND_PAGE_SIZE;
    const all = [];
    let total = 0;
    for (let page = 1; page <= maxPages; page++) {
      const r = await queryBindPage({ templateName: name, page, pageSize });
      total = r.total;
      all.push(...r.rows);
      if (all.length >= total || r.rows.length === 0) break;
      if (r.rows.length < pageSize) break;
    }
    const members = [];
    const seen = new Set();
    for (const row of all) {
      const s = summarizeBindRow(row);
      if (!s) continue;
      // 接口 templateName 为前缀匹配，只保留等值
      if (String(s.templateName || "").trim() !== name) continue;
      const key = String(s.componentCode || s.stockCode || "").toUpperCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      members.push(s);
    }
    return {
      templateName: name,
      total,
      fetched: all.length,
      memberCount: members.length,
      members,
      codes: members
        .map((m) => normalizeStockCode(m.componentCode || m.stockCode))
        .filter((c) => /^C\d+$/i.test(c)),
    };
  }

  /** 绑定页：按查询条件翻页，收集去重模板名称（默认组装工艺=贴片料） */
  async function listUniqueBindTemplates(opt) {
    opt = opt || {};
    const pageSize = Number(opt.pageSize || 200) || 200;
    const maxPages = Number(opt.maxPages || 8000) || 8000;
    const assemblyProcess =
      opt.assemblyProcess != null
        ? String(opt.assemblyProcess).trim()
        : "贴片料";
    const templateType =
      opt.templateType != null ? String(opt.templateType).trim() : "";
    const updateStartTime = opt.updateStartTime || "2020-01-01 00:00:00";
    const updateEndTime =
      opt.updateEndTime ||
      (() => {
        const d = new Date();
        const m = String(d.getMonth() + 1).padStart(2, "0");
        const day = String(d.getDate()).padStart(2, "0");
        return `${d.getFullYear()}-${m}-${day} 23:59:59`;
      })();

    async function probe(extra) {
      const r = await queryBindPage(
        Object.assign(
          {
            page: 1,
            pageSize: 5,
            updateStartTime,
            updateEndTime,
          },
          extra || {}
        )
      );
      return { total: r.total, n: r.rows.length, sample: summarizeBindRow(r.rows[0]) };
    }

    const probes = {
      assemblyProcess: await probe({ assemblyProcess }),
      templateType: templateType
        ? await probe({ templateType })
        : await probe({ templateType: assemblyProcess }),
      none: await probe({ assemblyProcess: "", templateType: "" }),
    };

    let filter = { assemblyProcess };
    let filterName = "assemblyProcess";
    if (!(probes.assemblyProcess.total > 0) && probes.templateType.total > 0) {
      filter = { templateType: templateType || assemblyProcess };
      filterName = "templateType";
    } else if (!(probes.assemblyProcess.total > 0) && !(probes.templateType.total > 0)) {
      // 都空：仍按贴片料字段打，避免误拉全库
      filter = { assemblyProcess };
      filterName = "assemblyProcess";
    }

    const names = new Set();
    let total = 0;
    let fetched = 0;
    let pages = 0;
    for (let page = 1; page <= maxPages; page++) {
      const r = await queryBindPage(
        Object.assign(
          {
            page,
            pageSize,
            updateStartTime,
            updateEndTime,
          },
          filter
        )
      );
      pages = page;
      total = r.total;
      for (const row of r.rows) {
        const tn = String((row && row.templateName) || "").trim();
        if (tn) names.add(tn);
      }
      fetched += r.rows.length;
      if (!r.rows.length || fetched >= total || r.rows.length < pageSize) break;
    }
    const templates = Array.from(names).sort((a, b) =>
      a.localeCompare(b, "zh")
    );
    return {
      filterName,
      filter,
      probes,
      totalRows: total,
      fetched,
      pages,
      uniqueTemplates: templates.length,
      templates,
    };
  }

  /** C码→模板名→同模板成员（ERP 首页首次查询会写入本地索引） */
  async function classifyByOldTemplate(rawOrList, opt) {
    const codes = Array.isArray(rawOrList)
      ? rawOrList.map(normalizeStockCode).filter((c) => /^C\d+$/i.test(c))
      : parseStockCodes(rawOrList);
    if (!codes.length) throw new Error("template_classify 需要 --codes C编码");
    const results = [];
    for (const code of codes) {
      const lookup = await lookupBindByComponentCode(code);
      if (!lookup.hit || !lookup.hit.templateName) {
        results.push({
          code,
          found: false,
          templateName: "",
          message: lookup.total
            ? "找到绑定记录但无模板名称"
            : "绑定页未找到该元件编号",
          lookup,
          group: null,
        });
        continue;
      }
      const templateName = String(lookup.hit.templateName).trim();
      const group = await listBindByTemplateName(templateName, opt);
      results.push({
        code,
        found: true,
        templateName,
        seed: lookup.hit,
        group,
        message: `模板「${templateName}」共 ${group.memberCount} 个元件（接口 total=${group.total}）`,
      });
    }
    return {
      count: results.length,
      results,
      note: "返回模板名称与同模板成员；ERP 首页首次查询会写入本地索引",
    };
  }

  function bridgeConfig() {
    return {
      enabled: GM_getValue("bridge_enabled", true) !== false,
      port: Number(GM_getValue("bridge_port", BRIDGE_DEFAULT_PORT)) || BRIDGE_DEFAULT_PORT,
      token: String(GM_getValue("bridge_token", BRIDGE_DEFAULT_TOKEN) || BRIDGE_DEFAULT_TOKEN),
    };
  }

  function bridgeBaseUrl() {
    const { port } = bridgeConfig();
    return `http://127.0.0.1:${port}`;
  }

  function gmHttpJson(method, url, bodyObj, headers, timeoutMs) {
    return new Promise((resolve, reject) => {
      const opts = {
        method,
        url,
        headers: Object.assign(
          { Accept: "application/json" },
          headers || {}
        ),
        timeout: timeoutMs || 8000,
        onload(res) {
          let json = null;
          try {
            json = res.responseText ? JSON.parse(res.responseText) : null;
          } catch (_) {
            json = null;
          }
          resolve({ http: res.status, json, text: res.responseText || "" });
        },
        onerror() {
          reject(new Error("bridge 网络错误（本机桥未启动？）"));
        },
        ontimeout() {
          reject(new Error("bridge 超时"));
        },
      };
      if (bodyObj != null) {
        opts.headers["Content-Type"] = "application/json; charset=utf-8";
        opts.data = JSON.stringify(bodyObj);
      }
      GM_xmlhttpRequest(opts);
    });
  }

  async function executeBridgeCommand(cmd) {
    const action = String((cmd && cmd.action) || "");
    const args = (cmd && cmd.args) || {};
    switch (action) {
      case "ping": {
        let authInfo = null;
        let nwInfo = { ok: null, error: "" };
        try {
          const auth = await getAuthSession(false);
          const cookieOk = !!(auth && auth.info && auth.info.okForRest);
          // mh/nw 都探测：现场 nw 常被跳到 mh，靠 Cookie XHR 验证可下载
          nwInfo = await probeNwSession(false);
          authInfo = auth && auth.info
            ? {
                count: auth.info.count,
                hasJwt: !!auth.info.hasJwt,
                hasSession: !!auth.info.hasSession,
                cookieOk,
                nwRestOk: nwInfo.ok === true,
                okForRest: cookieOk && nwInfo.ok === true,
              }
            : null;
        } catch (_) {}
        return {
          version: VERSION,
          href: location.href,
          host: location.hostname,
          on_nw: isOnNwHost(),
          on_mh: isOnMhHost(),
          redirect_ok: isOnMhHost(),
          browser: browserKind(),
          edge_skips_poll: false,
          auth: authInfo,
          nw_rest_ok: nwInfo.ok,
          nw_rest_error: nwInfo.error || null,
          can_download: canServeJlcDownload(),
          ts: new Date().toISOString(),
        };
      }
      case "query": {
        await ensureNwRestAlive();
        const codes = parseStockCodes(args.codes || args.code || "");
        if (!codes.length) throw new Error("query 需要 --codes C编码");
        const mode = args.mode || "both";
        // 有界并发：页内 XHR 并行（桥仍单命令）；默认 6，上限 8
        const concurrency = Math.max(
          1,
          Math.min(Number(args.concurrency) || 6, 8, codes.length)
        );
        const results = new Array(codes.length);
        let cursor = 0;
        async function worker() {
          while (cursor < codes.length) {
            const i = cursor++;
            results[i] = await queryProofread(codes[i], mode);
          }
        }
        await Promise.all(
          Array.from({ length: concurrency }, () => worker())
        );
        return { count: results.length, mode, concurrency, results };
      }
      case "list_mach_libs":
      case "list": {
        await ensureNwRestAlive();
        return await listMachCmpLibs({
          pageNum: args.pageNum || args.page || 1,
          pageSize: args.pageSize || args.limit || 100,
          maxPages: args.maxPages || 5,
          maxRows: args.maxRows || args.limit || 100,
          skipCodes: args.skipCodes || args.skip || "",
          stockCode: args.stockCode || "",
        });
      }
      case "download": {
        await ensureNwRestAlive();
        const format = args.format || "proofread";
        const ids = Array.isArray(args.ids)
          ? args.ids
          : String(args.ids || "")
              .split(/[,;\s]+/)
              .map((s) => s.trim())
              .filter(Boolean);
        const labels = Array.isArray(args.labels)
          ? args.labels
          : parseStockCodes(args.labels || args.codes || "");
        const codes = parseStockCodes(args.codes || args.code || "");
        if (ids.length) {
          return await downloadComponents(format, {
            ids,
            labels: labels.length ? labels : codes,
            stockCodes: codes,
          });
        }
        if (codes.length) {
          return await downloadComponents(format, { stockCodes: codes });
        }
        return await downloadComponents(format, {});
      }
      case "export_cookie":
      case "sync_cookie": {
        const { cookie, info, message, saved } = await exportCookieForGui(false);
        // 再强制 sync 一次，保证桥收到
        const synced = saved && saved.ok ? saved : await pushCookieToBridge(cookie, info);
        return {
          cookie,
          info,
          message,
          length: cookie ? cookie.length : 0,
          saved: synced,
          path: synced && synced.path,
        };
      }
      case "get_selection": {
        const rows = getSelectedRowsFromPage();
        const r = accessIdsFromRows(rows);
        return {
          count: r.ids.length,
          ids: r.ids,
          labels: r.labels,
        };
      }
      case "template_classify":
      case "classify_template":
      case "query_template": {
        await ensureNwRestAlive();
        const codes = parseStockCodes(args.codes || args.code || "");
        const templateName = String(args.templateName || args.template || "").trim();
        if (templateName && !codes.length) {
          const group = await listBindByTemplateName(templateName, {
            maxPages: args.maxPages,
            pageSize: args.pageSize,
          });
          return {
            mode: "by_template",
            templateName,
            group,
            note: "按模板名称直接列出成员",
          };
        }
        return await classifyByOldTemplate(codes.length ? codes : args.codes, {
          maxPages: args.maxPages,
          pageSize: args.pageSize,
        });
      }
      case "list_unique_templates":
      case "dump_templates": {
        await ensureNwRestAlive();
        return await listUniqueBindTemplates({
          assemblyProcess:
            args.assemblyProcess != null
              ? args.assemblyProcess
              : args.q != null
                ? args.q
                : "贴片料",
          templateType: args.templateType,
          pageSize: args.pageSize,
          maxPages: args.maxPages,
          updateStartTime: args.updateStartTime,
          updateEndTime: args.updateEndTime,
        });
      }
      case "private_pick_lookup": {
        await ensureNwRestAlive();
        const codes = parseStockCodes(args.codes || args.code || "");
        if (!codes.length) throw new Error("private_pick_lookup 需要 --codes C编码");
        const results = [];
        for (const c of codes) {
          results.push(await lookupMaterialLocationByComponent(c));
        }
        return { count: results.length, results };
      }
      case "private_pick_fill": {
        await ensureNwRestAlive();
        const codes = parseStockCodes(args.codes || args.code || "");
        if (!codes.length) throw new Error("private_pick_fill 需要 --codes C编码");
        if (codes.length > 1) {
          throw new Error("private_pick_fill 一次只支持 1 个 C 编码");
        }
        return await runPrivatePickFillFlow(codes[0], {
          navigate: args.navigate !== false && args.navigate !== "false",
          qty: args.qty != null ? args.qty : args.quantity,
          packageCode: args.packageCode || args.package || "",
          remark: args.remark || PRIVATE_PICK_DEFAULT_REMARK,
        });
      }
      default:
        throw new Error(
          "未知 action: " +
            action +
            "（支持 ping|query|list_mach_libs|download|export_cookie|sync_cookie|get_selection|template_classify|list_unique_templates|private_pick_lookup|private_pick_fill）"
        );
    }
  }

  function updateBridgeUi(text, ok) {
    const el = document.getElementById("jlc-pr-bridge");
    if (!el) return;
    el.textContent = text;
    el.style.color = ok ? "#0a7a2f" : "#888";
  }

  function bridgeStatusSuffix() {
    const parts = [];
    if (!bridgeIsLeader()) parts.push("副标签");
    if (lastHeartbeatOk) {
      const sec = Math.round((Date.now() - lastHeartbeatOk) / 1000);
      if (sec >= 0) parts.push(`${sec}s`);
    }
    return parts.length ? " · " + parts.join(" · ") : "";
  }

  function readBridgeLeader() {
    let cur = GM_getValue(BRIDGE_LEADER_KEY, null);
    if (typeof cur === "string") {
      try {
        cur = JSON.parse(cur);
      } catch (_) {
        cur = null;
      }
    }
    return cur && typeof cur === "object" ? cur : null;
  }

  function bridgeIsLeader() {
    const cur = readBridgeLeader();
    return !!(
      cur &&
      cur.id === TAB_ID &&
      Date.now() - (cur.ts || 0) <= BRIDGE_LEADER_TTL_MS
    );
  }

  function bridgeTryLeadPoll() {
    // mh/nw 均可争 leader 并 poll。下载/查询仍由 ensureNwRestAlive 拦截。
    // 旧逻辑：mh 必须先 nwProbe 成功才 poll → 一旦 460，命令永久积压，
    // 也无法走 export_cookie/ping 自愈（鸡生蛋）。
    const now = Date.now();
    if (!isOnNwHost() && nwProbeCache.ok !== true) {
      // 后台继续探，但不挡 poll
      probeNwSession(false).catch(() => {});
    }
    const cur = readBridgeLeader();
    // nw=3 优先于 mh=2，避免双开时 mh 抢命令
    const myRank = isOnNwHost() ? 3 : 2;
    if (
      cur &&
      cur.id &&
      cur.id !== TAB_ID &&
      now - (cur.ts || 0) <= BRIDGE_LEADER_TTL_MS &&
      (cur.rank || 1) < myRank
    ) {
      GM_setValue(BRIDGE_LEADER_KEY, {
        id: TAB_ID,
        ts: now,
        host: location.hostname,
        rank: myRank,
      });
      return true;
    }
    if (
      !cur ||
      !cur.id ||
      now - (cur.ts || 0) > BRIDGE_LEADER_TTL_MS ||
      cur.id === TAB_ID
    ) {
      GM_setValue(BRIDGE_LEADER_KEY, {
        id: TAB_ID,
        ts: now,
        host: location.hostname,
        rank: myRank,
      });
      return readBridgeLeader()?.id === TAB_ID;
    }
    if (cur.id === TAB_ID) {
      GM_setValue(BRIDGE_LEADER_KEY, {
        id: TAB_ID,
        ts: now,
        host: location.hostname,
        rank: myRank,
      });
      return true;
    }
    return false;
  }

  let bridgeBusy = false;
  let bridgeBusySince = 0;
  let bridgeTimer = null;
  let bridgeHeartbeatTimer = null;
  let bridgeWatchdogTimer = null;
  let bridgeBusyAction = null;
  let spaWatchTimer = null;
  let bridgeIdlePolls = 0;
  let bridgeWakeLock = null;
  let lastHeartbeatOk = 0;
  let lastHeartbeatFail = 0;
  let busyKeepAliveTimer = null;
  let audioKeepCtx = null;

  function heartbeatIntervalMs() {
    return document.hidden ? BRIDGE_HEARTBEAT_MS_HIDDEN : BRIDGE_HEARTBEAT_MS_VISIBLE;
  }

  function stopBusyKeepAlive() {
    if (busyKeepAliveTimer) {
      clearTimeout(busyKeepAliveTimer);
      busyKeepAliveTimer = null;
    }
  }

  function startBusyKeepAlive() {
    stopBusyKeepAlive();
    const tick = () => {
      bridgeHeartbeatOnce().catch(() => {});
      busyKeepAliveTimer = setTimeout(tick, heartbeatIntervalMs());
    };
    busyKeepAliveTimer = setTimeout(tick, heartbeatIntervalMs());
  }

  function stopBridgeTimers() {
    if (bridgeTimer) {
      clearTimeout(bridgeTimer);
      bridgeTimer = null;
    }
    if (bridgeHeartbeatTimer) {
      clearTimeout(bridgeHeartbeatTimer);
      bridgeHeartbeatTimer = null;
    }
    stopBusyKeepAlive();
  }

  function stopBridgeWatchdog() {
    if (bridgeWatchdogTimer) {
      clearInterval(bridgeWatchdogTimer);
      bridgeWatchdogTimer = null;
    }
  }

  function scheduleHeartbeat() {
    if (bridgeHeartbeatTimer) {
      clearTimeout(bridgeHeartbeatTimer);
      bridgeHeartbeatTimer = null;
    }
    const loop = () => {
      bridgeHeartbeatOnce()
        .catch(() => {})
        .finally(() => {
          if (!bridgeConfig().enabled) return;
          bridgeHeartbeatTimer = setTimeout(loop, heartbeatIntervalMs());
        });
    };
    bridgeHeartbeatTimer = setTimeout(loop, 0);
  }

  function onBridgeTabWake(reason) {
    const cfg = bridgeConfig();
    if (!cfg.enabled) return;
    if (reason) {
      console.info("[JLC校对快查] bridge wake:", reason);
    }
    scheduleHeartbeat();
    bridgeHeartbeatOnce().catch(() => {});
    requestBridgeWakeLock().catch(() => {});
    startAudioKeepAlive();
    const stale =
      !lastHeartbeatOk || Date.now() - lastHeartbeatOk > BRIDGE_STALE_MS;
    if (!bridgeTimer || stale) {
      restartBridgeServices(reason || "wake");
    }
  }

  function restartBridgeServices(reason) {
    const cfg = bridgeConfig();
    if (!cfg.enabled) return;
    if (reason) {
      console.info("[JLC校对快查] bridge restart:", reason);
    }
    stopBridgeTimers();
    bridgeBusy = false;
    bridgeBusySince = 0;
    const tick = () => {
      const isLeader = bridgeTryLeadPoll();
      const delay = isLeader ? BRIDGE_POLL_MS : 3000;
      if (isLeader) {
        bridgePollOnce().finally(() => {
          bridgeTimer = setTimeout(tick, delay);
        });
      } else {
        bridgeTimer = setTimeout(tick, delay);
      }
    };
    tick();
    scheduleHeartbeat();
    requestBridgeWakeLock().catch(() => {});
    startAudioKeepAlive();
  }

  function ensureBridgeWatchdog() {
    if (bridgeWatchdogTimer) return;
    bridgeWatchdogTimer = setInterval(() => {
      if (!bridgeConfig().enabled) return;
      const stale =
        !lastHeartbeatOk || Date.now() - lastHeartbeatOk > BRIDGE_STALE_MS;
      if (stale) {
        restartBridgeServices("watchdog stale");
        return;
      }
      // busy 卡死：上一命令没 finally，会让 ERP 空等 180s
      if (
        bridgeBusy &&
        bridgeBusySince &&
        Date.now() - bridgeBusySince >
        bridgeBusyWatchdogMs(bridgeBusyAction)
      ) {
        console.warn("[JLC校对快查] bridgeBusy watchdog reset");
        updateBridgeUi(`本机桥：命令超时已复位 v${VERSION}`, false);
        restartBridgeServices("busy watchdog");
      }
    }, BRIDGE_WATCHDOG_MS);
  }

  function ensureSpaBridgeWatch() {
    if (spaWatchTimer) return;
    let lastHref = location.href;
    spaWatchTimer = setInterval(() => {
      if (location.href === lastHref) return;
      lastHref = location.href;
      onBridgeTabWake("spa-nav");
      // 子应用 hash 切换到容器列表时续跑勾选
      if (readCtuPending()) {
        setTimeout(() => {
          resumeCtuPendingIfAny().catch(() => {});
        }, 1000);
      }
      if (readPrivatePickPending()) {
        setTimeout(() => {
          resumePrivatePickPendingIfAny().catch(() => {});
        }, 1000);
      }
    }, 1500);
  }

  async function bridgeHeartbeatOnce(retry) {
    const cfg = bridgeConfig();
    if (!cfg.enabled) return false;
    heartbeatProbeCounter += 1;
    // probe nw on every heartbeat: visible=2s (unchanged), hidden=30s (was %15 => 7.5min, too sparse)
    try {
      await probeNwSession(heartbeatProbeCounter === 1);
    } catch (_) {}
    const url =
      bridgeBaseUrl() +
      `/jlc/bridge/heartbeat?token=${encodeURIComponent(cfg.token)}&version=${encodeURIComponent(
        VERSION
      )}&site=${SITE}${browserBridgeQs()}${nwBridgeQs()}`;
    try {
      const res = await gmHttpJson("GET", url, null, {
        "X-Bridge-Token": cfg.token,
      });
      if (res.http === 200 && res.json && res.json.ok) {
        const wasDown = lastHeartbeatFail > 0 || lastHeartbeatOk === 0;
        lastHeartbeatOk = Date.now();
        lastHeartbeatFail = 0;
        // ERP/桥刚重启后：强制再探 nw，避免带着旧 460 缓存假离线
        if (wasDown) {
          try {
            await probeNwSession(true);
          } catch (_) {}
        }
        if (!bridgeBusy) {
          if (nwProbeCache.ok === false) {
            const missSmt =
              authCache &&
              authCache.map &&
              !authCache.map.SMT_ERP_SESSION_ID;
            updateBridgeUi(
              missSmt
                ? `本机桥：已连桥 v${VERSION} · 缺 SMT 会话，请打开机器库 smtbaseservice（菜单可点）${bridgeStatusSuffix()}`
                : `本机桥：已连桥 v${VERSION} · 机器库 REST 460，请退出再登录并进机器库页${bridgeStatusSuffix()}`,
              false
            );
            // 仅停在 mh 门户首页且缺 SMT 时自动跳机器库；已在 nw/其它业务页不抢焦点
            if (missSmt && isOnMhHost()) {
              const hash = String(location.hash || "");
              const portalHome =
                !hash || hash === "#" || hash === "#/" || /^#\/?(\?|$)/.test(hash);
              if (portalHome) {
                const last = Number(GM_getValue("jlc_autogen_machine_lib_at", 0) || 0);
                if (Date.now() - last > 600000) {
                  GM_setValue("jlc_autogen_machine_lib_at", Date.now());
                  try {
                    location.assign(URL_MACHINE_LIB_NW);
                  } catch (_) {}
                }
              }
            }
          } else {
            const role = bridgeIsLeader() ? "在线" : "在线(副标签)";
            updateBridgeUi(
              `本机桥：${role} v${VERSION} · 等待命令${bridgeStatusSuffix()}`,
              true
            );
          }
        }
        return true;
      }
    } catch (_) {
      /* 旧桥无 /heartbeat 时需重启 ERP/start.bat */
    }
    if (!retry) {
      await new Promise((r) => setTimeout(r, 400));
      return bridgeHeartbeatOnce(true);
    }
    lastHeartbeatFail = Date.now();
    if (!bridgeBusy) {
      updateBridgeUi(
        "本机桥：离线（请运行 bridge_serve.bat 或 ERP start.bat）",
        false
      );
    }
    return false;
  }

  function startBridgeHeartbeat() {
    scheduleHeartbeat();
  }

  function startAudioKeepAlive() {
    // default ON: silent audio keeps the tab from being frozen by Chrome,
    // which otherwise kills the heartbeat loop in background tabs
    if (GM_getValue("bridge_audio_keepalive", true) === false) return;
    try {
      if (audioKeepCtx && audioKeepCtx.state !== "closed") {
        if (audioKeepCtx.state === "suspended") audioKeepCtx.resume().catch(() => {});
        return;
      }
      audioKeepCtx = new AudioContext();
      const osc = audioKeepCtx.createOscillator();
      const gain = audioKeepCtx.createGain();
      gain.gain.value = 0.0001;
      osc.connect(gain);
      gain.connect(audioKeepCtx.destination);
      osc.start();
      audioKeepCtx.resume().catch(() => {});
    } catch (_) {
      audioKeepCtx = null;
    }
  }

  function stopAudioKeepAlive() {
    if (!audioKeepCtx) return;
    try {
      audioKeepCtx.close();
    } catch (_) {}
    audioKeepCtx = null;
  }

  async function requestBridgeWakeLock() {
    if (!GM_getValue("bridge_wake_lock", true)) return;
    try {
      if (!navigator.wakeLock) return;
      if (bridgeWakeLock && !bridgeWakeLock.released) return;
      bridgeWakeLock = await navigator.wakeLock.request("screen");
      bridgeWakeLock.addEventListener("release", () => {
        bridgeWakeLock = null;
      });
    } catch (_) {
      bridgeWakeLock = null;
    }
  }

  function releaseBridgeWakeLock() {
    if (bridgeWakeLock && !bridgeWakeLock.released) {
      bridgeWakeLock.release().catch(() => {});
    }
    bridgeWakeLock = null;
  }

  document.addEventListener("visibilitychange", () => {
    scheduleHeartbeat();
    if (document.hidden) {
      if (bridgeBusy) startBusyKeepAlive();
      return;
    }
    onBridgeTabWake("visibility visible");
  });
  window.addEventListener("pageshow", (ev) => {
    onBridgeTabWake(ev && ev.persisted ? "pageshow-bfcache" : "pageshow");
  });
  window.addEventListener("focus", () => onBridgeTabWake("focus"));
  window.addEventListener("online", () => onBridgeTabWake("online"));

  async function bridgePollOnce() {
    const cfg = bridgeConfig();
    if (!cfg.enabled || bridgeBusy) return;
    if (!bridgeTryLeadPoll()) {
      if (lastHeartbeatOk && Date.now() - lastHeartbeatOk < BRIDGE_STALE_MS) {
        updateBridgeUi(
          `本机桥：在线(副标签) v${VERSION} · ${browserKind()} · 仅心跳${bridgeStatusSuffix()}`,
          true
        );
      }
      return;
    }
    const url =
      bridgeBaseUrl() +
      `/jlc/bridge/poll?token=${encodeURIComponent(cfg.token)}&version=${encodeURIComponent(
        VERSION
      )}&site=${SITE}&capable=${encodeURIComponent(BRIDGE_CAPABLE)}${browserBridgeQs()}${nwBridgeQs()}`;
    let res;
    try {
      res = await gmHttpJson("GET", url, null, {
        "X-Bridge-Token": cfg.token,
      });
    } catch (_) {
      updateBridgeUi("本机桥：离线（请运行 bridge_serve.bat）", false);
      return;
    }
    if (res.http === 401) {
      updateBridgeUi("本机桥：token 不匹配", false);
      return;
    }
    if (res.http !== 200 || !res.json || !res.json.ok) {
      updateBridgeUi("本机桥：异常", false);
      return;
    }
    updateBridgeUi(
      `本机桥：在线 v${VERSION} · 等待命令${bridgeStatusSuffix()}`,
      true
    );
    const cmd = res.json.command;
    if (!cmd || !cmd.id) {
      bridgeIdlePolls += 1;
      // 空闲时周期性同步 Cookie，避免本机 REST 过期
      if (bridgeIdlePolls >= BRIDGE_COOKIE_SYNC_EVERY) {
        bridgeIdlePolls = 0;
        try {
          await syncCookieToBridge();
        } catch (_) {}
      }
      return;
    }

    bridgeIdlePolls = 0;
    bridgeBusy = true;
    bridgeBusySince = Date.now();
    bridgeBusyAction = cmd.action;
    startBusyKeepAlive();
    updateBridgeUi(`本机桥：执行 ${cmd.action}…`, true);
    let resultBody;
    try {
      const data = await Promise.race([
        executeBridgeCommand(cmd),
        new Promise((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  `桥命令 ${cmd.action} 超时（${Math.round(
                    bridgeCmdTimeoutMs(cmd.action) / 1000
                  )}s），已中止以免 ERP 空等`
                )
              ),
            bridgeCmdTimeoutMs(cmd.action)
          )
        ),
      ]);
      resultBody = {
        id: cmd.id,
        ok: true,
        data,
        error: null,
        ts: new Date().toISOString(),
      };
    } catch (err) {
      resultBody = {
        id: cmd.id,
        ok: false,
        data: null,
        error: String(err && err.message ? err.message : err),
        ts: new Date().toISOString(),
      };
    }
    try {
      await gmHttpJson(
        "POST",
        bridgeBaseUrl() + "/jlc/bridge/result",
        resultBody,
        { "X-Bridge-Token": cfg.token },
        60000
      );
      updateBridgeUi(
        resultBody.ok
          ? `本机桥：完成 ${cmd.action}`
          : `本机桥：失败 ${cmd.action}`,
        !!resultBody.ok
      );
    } catch (e) {
      updateBridgeUi("本机桥：回传结果失败", false);
      console.warn("[JLC校对快查] bridge result post failed", e);
    } finally {
      stopBusyKeepAlive();
      bridgeBusy = false;
      bridgeBusySince = 0;
      bridgeBusyAction = null;
    }
  }

  function startBridgeLoop() {
    restartBridgeServices("startBridgeLoop");
  }

  function exposeGlobals() {
    const api = {
      query: queryProofread,
      exportCookie: exportRestCookieString,
      copyCookie: copyRestCookieToClipboard,
      exportForGui: exportCookieForGui,
      syncCookieToBridge,
      getAuthSession,
      invalidateAuthSession,
      erpRequest,
      listMachCmpLibs,
      downloadComponents,
      getSelectedRowsFromPage,
      classifyByOldTemplate,
      lookupBindByComponentCode,
      listBindByTemplateName,
      lookupCtuContainersByStockCode,
      queryCtuContainerList,
      pickPreferredContainer,
      selectContainerOnPage,
      runCtuLocateFlow,
      ctuCalloutEnabled: () => CTU_CALLOUT_ENABLED,
      bridgeConfig,
      version: VERSION,
    };
    window.__jlcProofreadQueryRaw = queryProofread;
    window.__jlcExportRestCookie = exportRestCookieString;
    window.__jlcCopyRestCookie = async () => {
      const { cookie } = await copyRestCookieToClipboard();
      return cookie;
    };
    window.__jlcExportCookieForGui = exportCookieForGui;
    window.__jlcSyncCookieToBridge = syncCookieToBridge;
    window.__jlcListMachCmpLibs = listMachCmpLibs;
    window.__jlcDownloadComponents = downloadComponents;
    window.__jlcClassifyByOldTemplate = classifyByOldTemplate;
    window.__jlcCtuLookup = lookupCtuContainersByStockCode;
    window.__jlcCtuLocate = runCtuLocateFlow;
    window.__jlcProofreadApi = api;
    if (typeof unsafeWindow !== "undefined") {
      unsafeWindow.__jlcProofreadQueryRaw = queryProofread;
      unsafeWindow.__jlcExportRestCookie = exportRestCookieString;
      unsafeWindow.__jlcCopyRestCookie = window.__jlcCopyRestCookie;
      unsafeWindow.__jlcExportCookieForGui = exportCookieForGui;
      unsafeWindow.__jlcSyncCookieToBridge = syncCookieToBridge;
      unsafeWindow.__jlcListMachCmpLibs = listMachCmpLibs;
      unsafeWindow.__jlcDownloadComponents = downloadComponents;
      unsafeWindow.__jlcClassifyByOldTemplate = classifyByOldTemplate;
      unsafeWindow.__jlcCtuLookup = lookupCtuContainersByStockCode;
      unsafeWindow.__jlcCtuLocate = runCtuLocateFlow;
      unsafeWindow.__jlcProofreadApi = api;
    }
  }

  // ---------- CTU：物料位置 → 容器号 → 容器列表勾选（默认不呼出） ----------

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function setNativeInputValue(input, value) {
    if (!input) return;
    const proto =
      input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value");
    if (setter && setter.set) setter.set.call(input, value);
    else input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Enter" }));
  }

  function setCtuPanelOut(htmlOrText, asHtml) {
    try {
      const root = getInjectRoot() || document;
      const out = root.getElementById("jlc-pr-out");
      if (!out) return;
      if (asHtml) out.innerHTML = String(htmlOrText || "");
      else out.textContent = String(htmlOrText || "");
    } catch (_) {}
  }

  /** 顶层 document + 可访问 iframe contentDocument（mh 子应用常挂在 iframe） */
  function getAppDocuments() {
    const docs = [];
    const seen = new Set();
    const push = (d) => {
      if (!d || seen.has(d)) return;
      seen.add(d);
      docs.push(d);
    };
    push(document);
    try {
      if (document.defaultView && document.defaultView.frames) {
        const frames = document.defaultView.frames;
        for (let i = 0; i < frames.length; i++) {
          try {
            const fd = frames[i] && frames[i].document;
            push(fd);
          } catch (_) {}
        }
      }
    } catch (_) {}
    try {
      const iframes = document.querySelectorAll("iframe");
      for (const fr of iframes) {
        try {
          push(fr.contentDocument);
        } catch (_) {}
      }
    } catch (_) {}
    return docs;
  }

  function ctuUrlContainerList() {
    return isOnNwHost() ? URL_CONTAINER_LIST_NW : URL_CONTAINER_LIST;
  }

  function decodeSubAppPageParam(href) {
    try {
      const m = String(href || "").match(/[?&#]page=([^&#]+)/i);
      if (!m) return "";
      let raw = m[1];
      try {
        raw = decodeURIComponent(raw);
      } catch (_) {}
      try {
        raw = decodeURIComponent(raw);
      } catch (_) {}
      return String(raw || "");
    } catch (_) {
      return "";
    }
  }

  function isOnContainerListPage() {
    const href = String(location.href || "");
    const hash = String(location.hash || "");
    const page = decodeSubAppPageParam(href) || decodeSubAppPageParam(hash);
    const blob = href + "\n" + hash + "\n" + page;
    return (
      /ctuManage\/containerList/i.test(blob) ||
      /ctuManage%2FcontainerList/i.test(blob) ||
      /ctuManage%252FcontainerList/i.test(blob)
    );
  }

  function readCtuPending() {
    try {
      const raw = sessionStorage.getItem(CTU_PENDING_KEY);
      if (!raw) return null;
      const o = JSON.parse(raw);
      if (!o || !o.at || Date.now() - o.at > 10 * 60 * 1000) {
        sessionStorage.removeItem(CTU_PENDING_KEY);
        return null;
      }
      return o;
    } catch (_) {
      return null;
    }
  }

  function writeCtuPending(obj) {
    sessionStorage.setItem(
      CTU_PENDING_KEY,
      JSON.stringify(Object.assign({ at: Date.now() }, obj || {}))
    );
  }

  function clearCtuPending() {
    try {
      sessionStorage.removeItem(CTU_PENDING_KEY);
    } catch (_) {}
  }

  /** 解析 CTU 货位/容器列表接口返回 */
  function extractCtuListPayload(json) {
    if (!json || typeof json !== "object") return { list: [], total: 0, code: null };
    const code = json.code != null ? json.code : json.status;
    const data = json.data != null ? json.data : json.value;
    let list = [];
    let total = 0;
    if (Array.isArray(data)) {
      list = data;
      total = data.length;
    } else if (data && typeof data === "object") {
      list = data.list || data.records || data.rows || data.data || [];
      total = data.total != null ? data.total : list.length;
    }
    return { list: Array.isArray(list) ? list : [], total, code, message: json.message };
  }

  function collectContainersFromRows(rows) {
    const containers = [];
    for (const r of rows || []) {
      const no = String((r && r.containerNo) || "").trim();
      if (no && containers.indexOf(no) < 0) containers.push(no);
    }
    return containers;
  }

  function exactMatchShelvesRows(list, stockCode, field) {
    const want = String(stockCode || "")
      .trim()
      .toUpperCase();
    if (!want) return [];
    return (list || []).filter((r) => {
      const v = String((r && r[field]) || "")
        .trim()
        .toUpperCase();
      return v === want;
    });
  }

  function formatLocalYmd(d) {
    const x = d instanceof Date ? d : new Date();
    const y = x.getFullYear();
    const m = String(x.getMonth() + 1).padStart(2, "0");
    const day = String(x.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  /** 与 CTU 货位筛选「最近入库时间」对齐（页面默认近 7 天，这里放宽到 2020-01-01～今天） */
  function ctuShelvesInStockDateFilter() {
    const start = CTU_SHELVES_IN_STOCK_START;
    const end = formatLocalYmd(new Date());
    return {
      lastInStockTimeStart: start,
      lastInStockTimeEnd: end,
      // 兼容其它 tab / 后端别名
      beginLastInStockTime: start,
      endLastInStockTime: end,
    };
  }

  /**
   * 按料号查 CTU 货位绑定 → 容器号
   * - 页面「编号」多为元器件编号 componentCode（如 C14867）；库存号常为 C14867K4
   * - 必须带最近入库时间起点 2020-01-01，否则默认近 7 天会查不到
   */
  async function lookupCtuContainersByStockCode(rawCode) {
    const stockCode = normalizeStockCode(rawCode);
    if (!stockCode) throw new Error("请输入有效料号/C 编码");
    const dateFilter = ctuShelvesInStockDateFilter();
    const rawU = String(rawCode || "").trim().toUpperCase();
    const kMatch = rawU.match(/C\d+K[A-Z0-9]*/);
    const stockCodeExact = kMatch ? kMatch[0] : stockCode;

    const tryQuery = async (bodyExtra) => {
      const body = Object.assign(
        { currePage: 1, pageSize: 100 },
        dateFilter,
        bodyExtra || {}
      );
      const json = await erpRequest(API_CTU_SHELVES_LIST, body, { timeout: 30000 });
      const { list, total, code, message } = extractCtuListPayload(json);
      if (code != null && Number(code) !== 200) {
        throw new Error(message || `CTU 货位查询失败 code=${code}`);
      }
      return { list, total };
    };

    let fetched = { list: [], total: 0 };
    let rows = [];
    let via = null;

    // 1) 优先元器件编号（CTU 货位页「元器件编号」）
    fetched = await tryQuery({ componentCode: stockCode });
    rows = exactMatchShelvesRows(fetched.list, stockCode, "componentCode");
    if (rows.length) via = "componentCode";

    // 2) 再试库存编号（C14867 或 C14867K4）
    if (!rows.length) {
      fetched = await tryQuery({ stockCode: stockCodeExact });
      rows = exactMatchShelvesRows(fetched.list, stockCodeExact, "stockCode");
      if (!rows.length && stockCodeExact !== stockCode) {
        rows = exactMatchShelvesRows(fetched.list, stockCode, "componentCode");
      }
      if (rows.length) via = "stockCode";
    }

    const containers = collectContainersFromRows(rows);
    return {
      stockCode,
      containers,
      rows,
      total: fetched.total,
      via,
      dateFilter,
    };
  }

  /** 容器列表 API 校验 */
  async function queryCtuContainerList(containerNo) {
    const no = String(containerNo || "").trim();
    if (!no) throw new Error("容器号为空");
    const json = await erpRequest(
      API_CTU_CONTAINER_LIST,
      { currePage: 1, pageSize: 20, containerNo: no },
      { timeout: 30000 }
    );
    const { list, total, code, message } = extractCtuListPayload(json);
    if (code != null && Number(code) !== 200) {
      throw new Error(message || `容器列表查询失败 code=${code}`);
    }
    const hit =
      list.find(
        (r) =>
          String((r && r.containerNo) || "").trim().toUpperCase() === no.toUpperCase()
      ) || null;
    return { containerNo: no, hit, list, total };
  }

  /**
   * 多容器优选：优先 scheduleStatus===2（可呼出），否则有 hit 的，否则第一个。
   * 最多查询 8 个容器。
   */
  async function pickPreferredContainer(containers) {
    const list = (containers || []).map((c) => String(c || "").trim()).filter(Boolean);
    const details = [];
    const n = Math.min(list.length, 8);
    for (let i = 0; i < n; i++) {
      const no = list[i];
      try {
        const v = await queryCtuContainerList(no);
        const st = v.hit ? v.hit.scheduleStatus : null;
        details.push({
          containerNo: no,
          hit: v.hit,
          scheduleStatus: st,
          callable: Number(st) === 2,
          total: v.total,
          error: null,
        });
      } catch (err) {
        details.push({
          containerNo: no,
          hit: null,
          scheduleStatus: null,
          callable: false,
          total: 0,
          error: String(err && err.message ? err.message : err),
        });
      }
    }
    const callable = details.find((d) => d.callable && d.hit);
    const anyHit = details.find((d) => d.hit);
    const preferred =
      (callable && callable.containerNo) ||
      (anyHit && anyHit.containerNo) ||
      list[0] ||
      null;
    const prefDetail = details.find((d) => d.containerNo === preferred) || null;
    return {
      preferred,
      details,
      callable: !!(prefDetail && prefDetail.callable),
      scheduleStatus: prefDetail ? prefDetail.scheduleStatus : null,
      reason: callable
        ? "scheduleStatus===2"
        : anyHit
          ? "firstHit"
          : list.length
            ? "first"
            : "none",
    };
  }

  function matchContainerListVm(vm) {
    if (!vm) return false;
    if (
      Array.isArray(vm.tableData) &&
      Array.isArray(vm.multipleSelection) &&
      typeof vm.handleCallout === "function"
    ) {
      return true;
    }
    if (
      Array.isArray(vm.tableData) &&
      Array.isArray(vm.multipleSelection) &&
      (vm.calloutContainerId !== undefined ||
        (vm.screenData && "containerNo" in (vm.screenData || {})))
    ) {
      return true;
    }
    return false;
  }

  /** 在全部 app docs 中找容器列表 Vue；返回 {vm, doc, el} */
  function findCtuContainerListVm(preferredDoc) {
    const docs = [];
    if (preferredDoc) docs.push(preferredDoc);
    for (const d of getAppDocuments()) {
      if (docs.indexOf(d) < 0) docs.push(d);
    }
    for (const doc of docs) {
      try {
        const all = doc.querySelectorAll("*");
        for (const el of all) {
          const vm = el.__vue__;
          if (matchContainerListVm(vm)) {
            return { vm, doc, el };
          }
        }
      } catch (_) {}
    }
    return null;
  }

  function findContainerSearchInput(doc) {
    const root = doc || document;
    const form = root.querySelector("form");
    const scope = form || root;
    const inputs = scope.querySelectorAll(
      'input[type="text"], input:not([type]), .el-input__inner'
    );
    for (const inp of inputs) {
      const ph = String(inp.placeholder || "");
      const label =
        (inp.closest(".el-form-item") &&
          inp.closest(".el-form-item").querySelector(".el-form-item__label")) ||
        null;
      const lab = label ? String(label.textContent || "") : "";
      if (/容器/.test(ph + lab) || /container/i.test(ph)) return inp;
    }
    if (inputs.length) return inputs[0];
    return null;
  }

  function selectionHasContainer(vm, containerNo) {
    const no = String(containerNo || "")
      .trim()
      .toUpperCase();
    if (!vm || !no) return false;
    const sel = vm.multipleSelection || [];
    return sel.some(
      (r) =>
        String((r && r.containerNo) || "")
          .trim()
          .toUpperCase() === no
    );
  }

  function findTableRowElByContainer(doc, containerNo) {
    const no = String(containerNo || "").trim();
    if (!doc || !no) return null;
    const rows = doc.querySelectorAll(
      ".el-table__body-wrapper tbody tr, .el-table__body tbody tr"
    );
    for (const tr of rows) {
      const text = String(tr.textContent || "");
      if (text.indexOf(no) >= 0) return tr;
    }
    return null;
  }

  async function waitVmNotLoading(vm, doc, deadline) {
    while (Date.now() < deadline) {
      const loadingFlag =
        !!(vm && (vm.loading || vm.tableLoading || vm.listLoading)) ||
        !!(doc && doc.querySelector(".el-loading-mask"));
      if (!loadingFlag) return;
      await sleep(200);
    }
  }

  /**
   * 在容器列表页：填容器号 → 查询 → 勾选目标行（不点呼出）
   * 穿透 iframe；勾选后校验 multipleSelection。
   */
  async function selectContainerOnPage(containerNo, opt) {
    opt = opt || {};
    const no = String(containerNo || "").trim();
    if (!no) throw new Error("容器号为空");
    const deadline = Date.now() + (opt.timeoutMs || 25000);

    let found = null;
    while (Date.now() < deadline) {
      found = findCtuContainerListVm();
      if (found && found.vm) break;
      await sleep(400);
    }
    if (!found || !found.vm) {
      throw new Error("未找到容器列表页 Vue 实例（请确认已打开容器列表/子应用已加载）");
    }
    const { vm, doc } = found;

    if (!vm.screenData) vm.screenData = {};
    vm.$set
      ? vm.$set(vm.screenData, "containerNo", no)
      : (vm.screenData.containerNo = no);
    const inp = findContainerSearchInput(doc);
    if (inp) setNativeInputValue(inp, no);
    if (typeof vm.fetch === "function") vm.fetch();
    else if (typeof vm.query === "function") vm.query();
    else if (typeof vm.getList === "function") vm.getList();

    await waitVmNotLoading(vm, doc, deadline);

    let row = null;
    while (Date.now() < deadline) {
      await waitVmNotLoading(vm, doc, deadline);
      const data = vm.tableData || [];
      row =
        data.find(
          (r) =>
            String((r && r.containerNo) || "").trim().toUpperCase() === no.toUpperCase()
        ) || (data.length === 1 ? data[0] : null);
      if (row) break;
      await sleep(400);
    }
    if (!row) {
      throw new Error(`容器列表未找到容器号 ${no}（可先点页面查询确认）`);
    }

    // 使用 tableData 中的同一引用勾选（ElementUI 靠引用相等）
    const rowRef =
      (vm.tableData || []).find(
        (r) =>
          String((r && r.containerNo) || "").trim().toUpperCase() ===
          String((row && row.containerNo) || "")
            .trim()
            .toUpperCase()
      ) || row;

    let selectMethod = "none";
    try {
      const table = doc.querySelector(".el-table");
      const tableVm = table && table.__vue__;
      if (tableVm && typeof tableVm.toggleRowSelection === "function") {
        if (typeof tableVm.clearSelection === "function") tableVm.clearSelection();
        tableVm.toggleRowSelection(rowRef, true);
        selectMethod = "toggleRowSelection";
      } else {
        vm.multipleSelection = [rowRef];
        if (typeof vm.handleSelectionChange === "function") {
          vm.handleSelectionChange([rowRef]);
        }
        selectMethod = "multipleSelection";
      }
    } catch (e) {
      vm.multipleSelection = [rowRef];
      selectMethod = "directAssign";
    }

    if (!selectionHasContainer(vm, no)) {
      // DOM 兜底：点含容器号的行 checkbox
      const tr = findTableRowElByContainer(doc, no);
      if (tr) {
        const cb = tr.querySelector(
          ".el-checkbox__input, .el-checkbox span, .el-checkbox__inner, td .el-checkbox"
        );
        if (cb) {
          cb.click();
          selectMethod = "domClick";
        } else {
          tr.click();
          selectMethod = "domRowClick";
        }
        await sleep(200);
      }
    }

    if (!selectionHasContainer(vm, no)) {
      throw new Error(
        `勾选未生效：multipleSelection 未包含容器号 ${no}（method=${selectMethod}）`
      );
    }

    const st = rowRef.scheduleStatus;
    const callable = Number(st) === 2;
    const selected = (vm.multipleSelection || []).map((r) => r && r.containerNo);
    const noteParts = [
      `已勾选 ${no}`,
      `method=${selectMethod}`,
      `scheduleStatus=${st}`,
      callable ? "可呼出(status=2)" : "当前不可呼出(需status=2)",
      CTU_CALLOUT_ENABLED
        ? "呼出开关=开"
        : "呼出已禁用（CTU_CALLOUT_ENABLED=false）",
    ];
    return {
      ok: true,
      containerNo: no,
      row: rowRef,
      selected,
      scheduleStatus: st,
      callable,
      selectMethod,
      calloutEnabled: CTU_CALLOUT_ENABLED,
      note: noteParts.join("；"),
    };
  }

  /** 呼出 API — 默认禁用 */
  async function calloutCtuContainer(payload) {
    if (!CTU_CALLOUT_ENABLED) {
      throw new Error("呼出已禁用：请先验收查容器/勾选，再打开 CTU_CALLOUT_ENABLED");
    }
    return erpRequest(API_CTU_CONTAINER_CALLOUT, payload || {}, { timeout: 30000 });
  }

  /**
   * 完整流程：查容器号 → 优选 →（可选）跳转容器列表勾选。永不自动呼出。
   * @param {string} rawCode
   * @param {{ navigate?: boolean, select?: boolean }} opt
   */
  async function runCtuLocateFlow(rawCode, opt) {
    // 默认不导航：仓库未用 CTU 时禁止乱跳 SPA；显式菜单才 navigate:true
    opt = Object.assign({ navigate: false, select: true }, opt || {});
    const looked = await lookupCtuContainersByStockCode(rawCode);
    if (!looked.containers.length) {
      return {
        ok: false,
        stage: "lookup",
        stockCode: looked.stockCode,
        message: `未查到容器号（货位 ${looked.total} 条；via=${looked.via || "无精确匹配"}）`,
        looked,
      };
    }

    const pick = await pickPreferredContainer(looked.containers);
    const containerNo = pick.preferred || looked.containers[0];
    let verified = null;
    const prefDetail = (pick.details || []).find((d) => d.containerNo === containerNo);
    if (prefDetail && prefDetail.hit) {
      verified = {
        containerNo,
        hit: prefDetail.hit,
        total: prefDetail.total,
      };
    } else {
      try {
        verified = await queryCtuContainerList(containerNo);
      } catch (err) {
        verified = { error: String(err && err.message ? err.message : err) };
      }
    }

    if (!opt.navigate && !opt.select) {
      return {
        ok: true,
        stage: "lookup",
        stockCode: looked.stockCode,
        containerNo,
        containers: looked.containers,
        looked,
        pick,
        verified,
        calloutEnabled: CTU_CALLOUT_ENABLED,
      };
    }

    writeCtuPending({
      step: "select",
      stockCode: looked.stockCode,
      containerNo,
      containers: looked.containers,
      select: !!opt.select,
      callout: false,
      pickReason: pick.reason,
    });

    if (opt.navigate && !isOnContainerListPage()) {
      location.href = ctuUrlContainerList();
      return {
        ok: true,
        stage: "navigating",
        stockCode: looked.stockCode,
        containerNo,
        containers: looked.containers,
        looked,
        pick,
        verified,
        message: `已跳转容器列表，到达后自动勾选（不呼出；优选=${pick.reason}）`,
        calloutEnabled: CTU_CALLOUT_ENABLED,
      };
    }

    if (opt.select) {
      const sel = await selectContainerOnPage(containerNo);
      clearCtuPending();
      return {
        ok: true,
        stage: "selected",
        stockCode: looked.stockCode,
        containerNo,
        containers: looked.containers,
        looked,
        pick,
        verified,
        select: sel,
        calloutEnabled: CTU_CALLOUT_ENABLED,
      };
    }

    return {
      ok: true,
      stage: "ready",
      stockCode: looked.stockCode,
      containerNo,
      containers: looked.containers,
      looked,
      pick,
      verified,
      calloutEnabled: CTU_CALLOUT_ENABLED,
    };
  }

  async function resumeCtuPendingIfAny() {
    const pending = readCtuPending();
    if (!pending || pending.step !== "select") return null;
    if (!isOnContainerListPage()) return null;
    const no = pending.containerNo;
    if (!no) {
      clearCtuPending();
      return null;
    }

    const maxTries = 4;
    let lastErr = null;
    for (let i = 1; i <= maxTries; i++) {
      setCtuPanelOut(
        `CTU 自动勾选中… (${i}/${maxTries}) 容器 ${no}`,
        false
      );
      await sleep(i === 1 ? 800 : 600);
      try {
        const sel = await selectContainerOnPage(no, { timeoutMs: 20000 });
        clearCtuPending();
        setCtuPanelOut(
          [
            `<b>CTU 定位完成（未呼出）</b>`,
            `料号: ${escapeHtml(pending.stockCode || "")}`,
            `容器号: ${escapeHtml(no)}`,
            escapeHtml(sel.note || ""),
            `调度状态 scheduleStatus=${escapeHtml(String(sel.scheduleStatus))}`,
            `可呼出标志 callable=${sel.callable ? "是" : "否"}`,
          ].join("<br>"),
          true
        );
        return sel;
      } catch (err) {
        lastErr = err;
        setCtuPanelOut(
          `CTU 自动勾选重试 ${i}/${maxTries} 失败: ${String(
            err && err.message ? err.message : err
          )}`,
          false
        );
      }
    }
    setCtuPanelOut(
      "CTU 自动勾选失败: " +
        String(lastErr && lastErr.message ? lastErr.message : lastErr),
      false
    );
    return null;
  }

  function privatePickAddUrl() {
    return isOnMhHost() ? URL_PRIVATE_PICK_ADD_MH : URL_PRIVATE_PICK_ADD_NW;
  }

  function isOnPrivatePickAddPage() {
    const href = String(location.href || "");
    const hash = String(location.hash || "");
    const page = decodeSubAppPageParam(href) || decodeSubAppPageParam(hash);
    const blob = href + "\n" + hash + "\n" + page;
    return (
      /smtCustomerPrivateStockDeliveryreqAdd/i.test(blob) ||
      /smtCustomerPrivateStockDeliveryreqAdd/i.test(
        decodeURIComponent(blob.replace(/%25/g, "%"))
      )
    );
  }

  function readPrivatePickPending() {
    try {
      const raw = sessionStorage.getItem(PRIVATE_PICK_PENDING_KEY);
      if (!raw) return null;
      const o = JSON.parse(raw);
      if (!o || !o.at || Date.now() - o.at > 10 * 60 * 1000) {
        sessionStorage.removeItem(PRIVATE_PICK_PENDING_KEY);
        return null;
      }
      return o;
    } catch (_) {
      return null;
    }
  }

  function writePrivatePickPending(obj) {
    sessionStorage.setItem(
      PRIVATE_PICK_PENDING_KEY,
      JSON.stringify(Object.assign({ at: Date.now() }, obj || {}))
    );
  }

  function clearPrivatePickPending() {
    try {
      sessionStorage.removeItem(PRIVATE_PICK_PENDING_KEY);
    } catch (_) {}
  }

  function normalizePrivatePickRow(row, via) {
    if (!row || typeof row !== "object") return null;
    const componentCode = String(
      row.componentCode || row.stockCode || ""
    ).trim();
    const customerCode = String(row.customerCode || "").trim();
    const totalStock = Number(
      row.totalStockNumber != null
        ? row.totalStockNumber
        : row.stockNum != null
          ? row.stockNum
          : row.presaleStockNum != null
            ? row.presaleStockNum
            : NaN
    );
    return {
      via: via || "",
      componentCode,
      stockCode: String(row.stockCode || "").trim(),
      customerCode,
      totalStockNumber: Number.isFinite(totalStock) ? totalStock : null,
      goodsSources: row.goodsSources,
      goodsShelvesName: row.goodsShelvesName || "",
      raw: row,
    };
  }

  function extractShelvesRoot(json) {
    if (!json || typeof json !== "object") {
      return { list: [], total: 0, code: null, message: "" };
    }
    const code = json.code != null ? json.code : json.status;
    const data = json.data != null ? json.data : json.value;
    let list = [];
    let total = 0;
    if (Array.isArray(data)) {
      list = data;
      total = data.length;
    } else if (data && typeof data === "object") {
      list = data.root || data.list || data.records || data.rows || data.data || [];
      total = data.total != null ? data.total : list.length;
    }
    return {
      list: Array.isArray(list) ? list : [],
      total,
      code,
      message: json.message || "",
    };
  }

  /**
   * 按元器件编号查库位页（API，不打开 materialLocation 页）：客编 + 库存总量。
   * 依次试 normal / mix / ctu。
   */
  async function lookupMaterialLocationByComponent(rawCode) {
    const stockCode = normalizeStockCode(rawCode);
    if (!stockCode) throw new Error("请输入有效料号/C 编码");
    const want = stockCode.toUpperCase();
    const bodyBase = { currePage: 1, pageSize: 100, componentCode: stockCode };
    const tries = [
      { via: "normal", path: API_SHELVES_BIND_LIST, body: bodyBase },
      { via: "mix", path: API_MIX_SHELVES_BIND_LIST, body: bodyBase },
      {
        via: "ctu",
        path: API_CTU_SHELVES_LIST,
        body: Object.assign({}, bodyBase, ctuShelvesInStockDateFilter()),
      },
    ];
    const attempts = [];
    let best = [];
    for (const t of tries) {
      try {
        const { json } = await erpRequest(t.path, t.body, { timeout: 30000 });
        const { list, total, code, message } = extractShelvesRoot(json);
        if (code != null && Number(code) !== 200) {
          attempts.push({ via: t.via, ok: false, error: message || `code=${code}` });
          continue;
        }
        const rows = (list || [])
          .map((r) => normalizePrivatePickRow(r, t.via))
          .filter((r) => r && r.customerCode);
        const exact = rows.filter(
          (r) =>
            String(r.componentCode || "").toUpperCase() === want ||
            String(r.stockCode || "").toUpperCase() === want
        );
        const hit = exact.length ? exact : rows;
        attempts.push({
          via: t.via,
          ok: true,
          total,
          hit: hit.length,
        });
        if (hit.length) {
          best = hit;
          break;
        }
      } catch (err) {
        attempts.push({
          via: t.via,
          ok: false,
          error: String(err && err.message ? err.message : err),
        });
      }
    }
    const primary = best[0] || null;
    const customerCodes = [];
    for (const r of best) {
      if (r.customerCode && customerCodes.indexOf(r.customerCode) < 0) {
        customerCodes.push(r.customerCode);
      }
    }
    return {
      stockCode,
      customerCode: primary ? primary.customerCode : "",
      totalStockNumber: primary ? primary.totalStockNumber : null,
      rows: best,
      customerCodes,
      attempts,
      ok: !!primary,
      message: primary
        ? null
        : `未在库位查到 ${stockCode} 的客编（已试 normal/mix/ctu）`,
    };
  }

  /** 提货选料列表（需已有客编 + 物料来源） */
  async function pagePrivatePickComponents(query) {
    const q = Object.assign({ currePage: 1, pageSize: 50 }, query || {});
    const { json } = await erpGet(API_PRIVATE_PICK_COMPONENTS, q, {
      timeout: 30000,
    });
    const code = json && (json.code != null ? json.code : json.status);
    if (code != null && Number(code) !== 200) {
      throw new Error((json && json.message) || `选料查询失败 code=${code}`);
    }
    const value = (json && (json.value || json.data)) || {};
    const list = (value && (value.list || value.root || value.records)) || [];
    return {
      list: Array.isArray(list) ? list : [],
      total: value && value.total != null ? value.total : list.length,
    };
  }

  async function findPrivatePickComponentRows(customerCode, componentCode) {
    const code = normalizeStockCode(componentCode);
    const cust = String(customerCode || "").trim();
    if (!cust) throw new Error("客编为空，无法选料");
    if (!code) throw new Error("元件编号为空");
    const hits = [];
    const tried = [];
    for (const source of PRIVATE_PICK_COMPONENT_SOURCES) {
      try {
        const r = await pagePrivatePickComponents({
          customerCode: cust,
          componentCode: code,
          componentSource: source,
          stockFlag: "",
        });
        tried.push({ source, total: r.total, n: r.list.length });
        for (const row of r.list) {
          const cc = String((row && row.componentCode) || "").trim().toUpperCase();
          if (cc === code.toUpperCase() || !cc) {
            hits.push(Object.assign({ componentSource: source }, row));
          }
        }
        if (hits.length) break;
      } catch (err) {
        tried.push({
          source,
          error: String(err && err.message ? err.message : err),
        });
      }
    }
    return { hits, tried };
  }

  function matchPrivatePickAddVm(vm) {
    if (!vm) return false;
    return !!(
      vm.FillInListObj &&
      typeof vm.FillInListObj === "object" &&
      Array.isArray(vm.addTableData)
    );
  }

  function findPrivatePickAddVm(preferredDoc) {
    const docs = [];
    if (preferredDoc) docs.push(preferredDoc);
    for (const d of getAppDocuments()) {
      if (docs.indexOf(d) < 0) docs.push(d);
    }
    for (const doc of docs) {
      try {
        const all = doc.querySelectorAll("*");
        for (const el of all) {
          const vm = el.__vue__;
          if (matchPrivatePickAddVm(vm)) return { vm, doc, el };
          if (vm && vm.$parent && matchPrivatePickAddVm(vm.$parent)) {
            return { vm: vm.$parent, doc, el };
          }
        }
      } catch (_) {}
    }
    return null;
  }

  /**
   * 在新增私有库提货申请页填表（不提交）。
   * usePurpose 固定 3=重新入库；备注默认「校对」。
   */
  async function fillPrivatePickAddForm(payload, opt) {
    opt = Object.assign({ timeoutMs: 25000 }, opt || {});
    const customerCode = String((payload && payload.customerCode) || "").trim();
    const remark = String(
      (payload && payload.remark) || PRIVATE_PICK_DEFAULT_REMARK
    ).trim();
    const packageCode = String((payload && payload.packageCode) || "").trim();
    const usePurpose =
      payload && payload.usePurpose != null
        ? Number(payload.usePurpose)
        : PRIVATE_PICK_USE_PURPOSE_RE_INBOUND;
    const pickingTime =
      String((payload && payload.pickingTime) || "").trim() ||
      formatLocalYmd(new Date());
    const qty =
      payload && payload.qty != null && payload.qty !== ""
        ? Number(payload.qty)
        : null;
    const componentCode = String((payload && payload.componentCode) || "").trim();

    if (!customerCode) throw new Error("客户编号为空");
    const deadline = Date.now() + (opt.timeoutMs || 25000);
    let found = null;
    while (Date.now() < deadline) {
      found = findPrivatePickAddVm();
      if (found) break;
      await sleep(400);
    }
    if (!found) throw new Error("未找到新增提货申请页 Vue（请确认已打开新增页）");

    const vm = found.vm;
    vm.$set(vm.FillInListObj, "customerCode", customerCode);
    vm.$set(vm.FillInListObj, "usePurpose", usePurpose);
    vm.$set(vm.FillInListObj, "remark", remark);
    vm.$set(vm.FillInListObj, "pickingTime", pickingTime);
    if (packageCode) vm.$set(vm.FillInListObj, "packageCode", packageCode);
    if (typeof vm.usePurposeChange === "function") {
      try {
        vm.usePurposeChange(usePurpose);
      } catch (_) {}
    }
    if (typeof vm.customerCodeChange === "function") {
      try {
        vm.customerCodeChange();
      } catch (_) {}
    }

    let detail = null;
    if (componentCode) {
      const picked = await findPrivatePickComponentRows(customerCode, componentCode);
      if (picked.hits.length) {
        const rows = picked.hits.slice(0, 1);
        if (typeof vm.selectData === "function") {
          vm.selectData(rows);
        } else {
          vm.addTableData = [];
          vm.selectData(rows);
        }
        if (qty != null && Number.isFinite(qty) && vm.addTableData.length) {
          const row0 = vm.addTableData[0];
          vm.$set(row0, "pickingNum", qty);
          if (typeof vm.pickingNumChange === "function") {
            try {
              vm.pickingNumChange(row0, 0);
            } catch (_) {}
          } else if (typeof vm.getPickingNumChange === "function") {
            try {
              const fixed = vm.getPickingNumChange(row0);
              vm.$set(vm.addTableData, 0, fixed);
            } catch (_) {}
          }
        }
        detail = {
          source: rows[0].componentSource,
          added: vm.addTableData.length,
          pickingNum: vm.addTableData[0] && vm.addTableData[0].pickingNum,
          tried: picked.tried,
        };
      } else {
        detail = { added: 0, tried: picked.tried, message: "选料接口未命中，请手工选料" };
      }
    }

    return {
      ok: true,
      filled: {
        customerCode,
        usePurpose,
        remark,
        packageCode: packageCode || null,
        pickingTime,
        packageRequired: usePurpose === 3 && !packageCode,
      },
      detail,
      submitEnabled: PRIVATE_PICK_SUBMIT_ENABLED,
      note: PRIVATE_PICK_SUBMIT_ENABLED
        ? "可提交"
        : "已填单未提交：请人工上传附件并点保存；包裹号/附件策略待确认",
    };
  }

  /**
   * 查库位客编/库存 →（可选）跳转新增页填单。永不自动提交。
   */
  async function runPrivatePickFillFlow(rawCode, opt) {
    opt = Object.assign(
      {
        navigate: true,
        qty: null,
        packageCode: "",
        remark: PRIVATE_PICK_DEFAULT_REMARK,
      },
      opt || {}
    );
    const looked = await lookupMaterialLocationByComponent(rawCode);
    if (!looked.ok) {
      return {
        ok: false,
        stage: "lookup",
        stockCode: looked.stockCode,
        message: looked.message,
        looked,
      };
    }
    const qty =
      opt.qty != null && opt.qty !== "" ? Number(opt.qty) : null;
    if (
      qty != null &&
      Number.isFinite(qty) &&
      looked.totalStockNumber != null &&
      Number(looked.totalStockNumber) < qty
    ) {
      return {
        ok: false,
        stage: "stock",
        stockCode: looked.stockCode,
        customerCode: looked.customerCode,
        totalStockNumber: looked.totalStockNumber,
        qty,
        message: `库存总量 ${looked.totalStockNumber} < 提货数量 ${qty}`,
        looked,
      };
    }

    const payload = {
      customerCode: looked.customerCode,
      componentCode: looked.stockCode,
      qty,
      packageCode: String(opt.packageCode || "").trim(),
      remark: String(opt.remark || PRIVATE_PICK_DEFAULT_REMARK).trim(),
      usePurpose: PRIVATE_PICK_USE_PURPOSE_RE_INBOUND,
      pickingTime: formatLocalYmd(new Date()),
    };

    if (!opt.navigate) {
      return {
        ok: true,
        stage: "lookup",
        stockCode: looked.stockCode,
        customerCode: looked.customerCode,
        totalStockNumber: looked.totalStockNumber,
        looked,
        payload,
        message: "仅查询，未跳转填单",
      };
    }

    if (!isOnPrivatePickAddPage()) {
      writePrivatePickPending({
        step: "fill",
        stockCode: looked.stockCode,
        payload,
      });
      try {
        location.assign(privatePickAddUrl());
      } catch (_) {
        window.open(URL_PRIVATE_PICK_ADD_NW, "_blank");
      }
      return {
        ok: true,
        stage: "navigating",
        stockCode: looked.stockCode,
        customerCode: looked.customerCode,
        totalStockNumber: looked.totalStockNumber,
        looked,
        message: "已跳转新增提货申请页，到达后自动填单",
      };
    }

    const filled = await fillPrivatePickAddForm(payload);
    clearPrivatePickPending();
    return {
      ok: true,
      stage: "filled",
      stockCode: looked.stockCode,
      customerCode: looked.customerCode,
      totalStockNumber: looked.totalStockNumber,
      looked,
      filled,
    };
  }

  async function resumePrivatePickPendingIfAny() {
    const pending = readPrivatePickPending();
    if (!pending || pending.step !== "fill") return null;
    if (!isOnPrivatePickAddPage()) return null;
    const payload = pending.payload || {};
    const maxTries = 5;
    let lastErr = null;
    for (let i = 1; i <= maxTries; i++) {
      setPrivatePickPanelOut(
        `私有库提货自动填单中… (${i}/${maxTries}) 客编 ${payload.customerCode || ""}`,
        false
      );
      await sleep(i === 1 ? 900 : 700);
      try {
        const filled = await fillPrivatePickAddForm(payload);
        clearPrivatePickPending();
        setPrivatePickPanelOut(
          [
            `<b>私有库提货申请已填单（未提交）</b>`,
            `料号: ${escapeHtml(pending.stockCode || "")}`,
            `客编: ${escapeHtml(payload.customerCode || "")}`,
            `用途: 重新入库(3)`,
            `备注: ${escapeHtml(payload.remark || PRIVATE_PICK_DEFAULT_REMARK)}`,
            payload.packageCode
              ? `包裹号: ${escapeHtml(payload.packageCode)}`
              : `包裹号: <span style="color:#b54708">未填（待确认，保存前必填）</span>`,
            filled.detail && filled.detail.added
              ? `提货明细: 已加入 ${filled.detail.added} 行`
              : `提货明细: ${escapeHtml(
                  (filled.detail && filled.detail.message) || "请手工选料"
                )}`,
            escapeHtml(filled.note || ""),
          ].join("<br>"),
          true
        );
        return filled;
      } catch (err) {
        lastErr = err;
      }
    }
    setPrivatePickPanelOut(
      "私有库提货自动填单失败: " +
        String(lastErr && lastErr.message ? lastErr.message : lastErr),
      false
    );
    return null;
  }

  function setPrivatePickPanelOut(html, ok) {
    const el = document.getElementById("jlc-pr-out");
    if (!el) return;
    el.innerHTML = html;
    el.style.borderColor = ok ? "#0a7a2f" : "#d0d7de";
  }

  function rowSummary(row) {
    if (!row) return "";
    return [
      escapeHtml(row.stockCode),
      escapeHtml(row.componentName),
      escapeHtml(row.componentSpecification),
      escapeHtml(statusLabel(row.proofreadStatus)),
    ]
      .filter(Boolean)
      .join(" | ");
  }

  function getInjectRoot() {
    const host = location.hostname;
    if (/nw\.jlcerp\.com$/i.test(host)) return document;
    if (/mh\.jlcerp\.com$/i.test(host) && window === window.top) return document;
    return null;
  }

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    GM_addStyle(`
      #${PANEL_ID}{
        position:fixed; right:16px; bottom:16px; z-index:2147483646;
        width:380px; max-height:75vh; overflow:auto;
        background:#fff; color:#222; border:1px solid #d0d7de;
        border-radius:10px; box-shadow:0 8px 28px rgba(0,0,0,.18);
        font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
      }
      #${PANEL_ID} .hd{
        display:flex; align-items:center; justify-content:space-between;
        padding:10px 12px; background:#1f6feb; color:#fff; border-radius:10px 10px 0 0;
        cursor:move; user-select:none;
      }
      #${PANEL_ID} .hd b{font-size:14px}
      #${PANEL_ID} .hd button{
        background:transparent;border:0;color:#fff;cursor:pointer;font-size:16px;padding:0 4px
      }
      #${PANEL_ID} .bd{padding:12px}
      #${PANEL_ID} label{display:block;margin:0 0 4px;color:#555}
      #${PANEL_ID} input[type=text], #${PANEL_ID} select, #${PANEL_ID} textarea{
        width:100%; box-sizing:border-box; padding:8px 10px; margin-bottom:8px;
        border:1px solid #c9d1d9; border-radius:6px; font-size:14px;
      }
      #${PANEL_ID} textarea{min-height:64px; resize:vertical; font-family:inherit;}
      #${PANEL_ID} .row{display:flex; gap:8px; margin-bottom:8px}
      #${PANEL_ID} .row > *{flex:1}
      #${PANEL_ID} .actions{display:flex; gap:8px; flex-wrap:wrap}
      #${PANEL_ID} .actions button{
        flex:1; min-width:90px; padding:8px 0; border:0; border-radius:6px; cursor:pointer; font-size:13px;
      }
      #${PANEL_ID} .btn-go{background:#1f6feb;color:#fff}
      #${PANEL_ID} .btn-go:disabled{opacity:.55;cursor:wait}
      #${PANEL_ID} .btn-clr{background:#eef1f4;color:#333}
      #${PANEL_ID} .btn-ck{background:#0e8a16;color:#fff}
      #${PANEL_ID} .btn-dl{background:#6e40c9;color:#fff}
      #${PANEL_ID} .btn-lib{background:#bf8700;color:#fff}
      #${PANEL_ID} .btn-lib2{background:#0969da;color:#fff}
      #${PANEL_ID} .btn-tpl{background:#0550ae;color:#fff}
      #${PANEL_ID} .btn-ctu{background:#8250df;color:#fff}
      #${PANEL_ID} .btn-ctu2{background:#6639ba;color:#fff}
      #${PANEL_ID} .btn-pick{background:#1a7f37;color:#fff}
      #${PANEL_ID} .btn-pick2{background:#116329;color:#fff}
      #${PANEL_ID} .out{
        margin-top:10px; padding:10px; background:#f6f8fa; border-radius:6px;
        white-space:pre-wrap; word-break:break-all; min-height:48px;
      }
      #${PANEL_ID} .badge{
        display:inline-block; padding:2px 8px; border-radius:999px; color:#fff; font-weight:600;
      }
      #${PANEL_ID}.collapsed .bd{display:none}
      #${PANEL_ID} .hint{color:#888;font-size:12px;margin-top:6px}
      #jlc-proofread-fab{
        position:fixed; right:16px; bottom:16px; z-index:2147483645;
        padding:8px 14px; border:0; border-radius:8px;
        background:#1f6feb; color:#fff; cursor:pointer;
        box-shadow:0 4px 14px rgba(0,0,0,.2); font-size:13px;
      }
    `);
    const tag = document.createElement("meta");
    tag.id = STYLE_ID;
    document.head.appendChild(tag);
  }

  function ensurePanel() {
    const root = getInjectRoot();
    if (!root || root.getElementById(PANEL_ID)) return;

    ensureStyles();

    const el = document.createElement("div");
    el.id = PANEL_ID;
    el.innerHTML = `
      <div class="hd">
        <b>机器库校对快查 <small style="opacity:.85">v${VERSION}</small></b>
        <span>
          <button type="button" data-act="min" title="折叠">–</button>
          <button type="button" data-act="close" title="关闭">×</button>
        </span>
      </div>
      <div class="bd">
        <label>C 编码（可多个，空格/逗号/换行分隔）</label>
        <textarea id="jlc-pr-code" placeholder="例:&#10;C9900309663&#10;C53114047&#10;C2900739" rows="3"></textarea>
        <div class="row">
          <div>
            <label>查询模式</label>
            <select id="jlc-pr-mode">
              <option value="both" selected>新旧都查</option>
              <option value="old">旧库（直接查状态）</option>
              <option value="new">新库（只找已校对）</option>
            </select>
          </div>
        </div>
        <div class="actions">
          <button type="button" class="btn-go" id="jlc-pr-go">查询</button>
          <button type="button" class="btn-clr" id="jlc-pr-clr">清空</button>
        </div>
        <div class="actions" style="margin-top:8px">
          <button type="button" class="btn-lib" id="jlc-pr-dl-sel" title="用表格勾选行下载">下载选中</button>
          <button type="button" class="btn-lib2" id="jlc-pr-dl-code" title="按上方多个 C 编码批量下载">按C码下载</button>
          <button type="button" class="btn-tpl" id="jlc-pr-tpl" title="C码→模板名→同模板成员">查模板</button>
        </div>
        <div class="actions" style="margin-top:8px">
          <button type="button" class="btn-ctu" id="jlc-pr-ctu-lookup" title="CTU货位：料号→容器号（仅查询）">查容器号</button>
          <button type="button" class="btn-ctu2" id="jlc-pr-ctu-locate" title="查容器号并跳转容器列表勾选；不点呼出">定位容器(不呼出)</button>
        </div>
        <div class="row" style="margin-top:8px">
          <div>
            <label>提货数量（须 ≤ 库存总量）</label>
            <input type="text" id="jlc-pr-pick-qty" placeholder="例: 1" />
          </div>
          <div>
            <label>包裹编号（重新入库必填·待确认）</label>
            <input type="text" id="jlc-pr-pick-pkg" placeholder="待确认后填写" />
          </div>
        </div>
        <div class="actions" style="margin-top:4px">
          <button type="button" class="btn-pick" id="jlc-pr-pick-lookup" title="库位API查客编+库存总量（不开库位页）">查客编库存</button>
          <button type="button" class="btn-pick2" id="jlc-pr-pick-fill" title="查客编后跳转新增页：用途=重新入库，备注=校对；不自动提交">填提货申请</button>
        </div>
        <div class="row" style="margin-top:4px;margin-bottom:4px">
          <div>
            <label>下载格式</label>
            <select id="jlc-pr-dl-fmt">
              <option value="proofread" selected>批量校对 zip（默认）</option>
              <option value="json">JSON 元件库 zip</option>
              <option value="csv">CSV zip</option>
            </select>
          </div>
        </div>
        <div class="actions" style="margin-top:8px">
          <button type="button" class="btn-ck" id="jlc-pr-cookie">导出 Cookie</button>
          <button type="button" class="btn-dl" id="jlc-pr-download">下载 cookie 文件</button>
        </div>
        <div class="hint" id="jlc-pr-bridge">本机桥：检测中…（v1.16.19 私有库提货填单；请保持本页在前台或固定标签）</div>
        <div class="out" id="jlc-pr-out">可输入多个 C 码后「按C码下载」（默认批量校对）；或勾选表格「下载选中」。私有库提货：查客编库存→填申请（用途重新入库/备注校对；附件与提交仍人工）。CTU：查容器号带入库起点 2020-01-01。</div>
        <div class="hint">多码示例：C9900309663,C53114047。下载入库由本机 ERP 油猴桥写入 old_lib_data\{C编码}\。私有库提货一次 1 个 C 码。CTU 定位只勾选不呼出；库位仅 API 查询，不自动打开 materialLocation。</div>
      </div>
    `;
    (root.body || root.documentElement).appendChild(el);

    const fab = root.getElementById("jlc-proofread-fab");
    if (fab) fab.remove();

    const hd = el.querySelector(".hd");
    let dragging = false;
    let ox = 0;
    let oy = 0;
    const onMove = (e) => {
      if (!dragging) return;
      el.style.left = e.clientX - ox + "px";
      el.style.top = e.clientY - oy + "px";
    };
    const onUp = () => {
      dragging = false;
    };

    hd.addEventListener("mousedown", (e) => {
      if (e.target.closest("button")) return;
      dragging = true;
      const r = el.getBoundingClientRect();
      ox = e.clientX - r.left;
      oy = e.clientY - r.top;
      el.style.right = "auto";
      el.style.bottom = "auto";
      el.style.left = r.left + "px";
      el.style.top = r.top + "px";
    });
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);

    el.querySelector('[data-act="min"]').addEventListener("click", () => {
      el.classList.toggle("collapsed");
    });
    el.querySelector('[data-act="close"]').addEventListener("click", () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      el.remove();
      ensureFab(root);
    });

    const input = el.querySelector("#jlc-pr-code");
    const go = el.querySelector("#jlc-pr-go");
    const out = el.querySelector("#jlc-pr-out");
    let querying = false;

    async function runQuery() {
      if (querying) return;
      const codes = parseStockCodes(input.value);
      if (!codes.length) {
        out.textContent = "无法解析 C 编码；可输入多个，用逗号/换行分隔";
        return;
      }
      const mode = el.querySelector("#jlc-pr-mode").value;
      querying = true;
      go.disabled = true;
      out.textContent = `查询中… ${codes.length} 个编码`;
      try {
        const allLines = [];
        for (const code of codes) {
          if (codes.length > 1) {
            allLines.push(`── ${escapeHtml(code)} ──`);
          }
          if (mode === "both") {
            const [oldR, newR] = await Promise.all([
              queryOldLib(code),
              queryNewLib(code),
            ]);
            appendOldResult(allLines, oldR, code);
            appendNewResult(allLines, newR);
          } else if (mode === "old") {
            appendOldResult(allLines, await queryOldLib(code), code);
          } else {
            appendNewResult(allLines, await queryNewLib(code));
          }
        }
        out.innerHTML = allLines.join("<br>");
        document.title =
          "JLC|" +
          allLines
            .join(" ")
            .replace(/<[^>]+>/g, "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 180);
      } catch (err) {
        out.textContent = String(err && err.message ? err.message : err);
      } finally {
        querying = false;
        go.disabled = false;
        input.focus();
      }
    }

    function appendOldResult(lines, r, code) {
      if (!r.hit) {
        lines.push(
          `【旧库】未找到 ${escapeHtml(code)}（返回 ${r.total} 条，无精确匹配）`
        );
        return;
      }
      const st = r.hit.proofreadStatus;
      lines.push(
        `【旧库】<span class="badge" style="background:${statusColor(st)}">${escapeHtml(statusLabel(st))}</span>`
      );
      lines.push(rowSummary(r.hit));
      if (r.hit.lastUploadTime) {
        lines.push(`更新时间: ${escapeHtml(r.hit.lastUploadTime)}`);
      }
    }

    function appendNewResult(lines, r) {
      if (r.foundInProofread) {
        lines.push(
          `【新库】<span class="badge" style="background:${statusColor(3)}">已校对</span>（在已校对列表中找到）`
        );
        lines.push(rowSummary(r.hit));
      } else {
        lines.push(
          `【新库】<span class="badge" style="background:#f82f53">未校对</span>（已校对列表中未找到）`
        );
      }
    }

    go.addEventListener("click", runQuery);
    el.querySelector("#jlc-pr-clr").addEventListener("click", () => {
      input.value = "";
      out.textContent = "输入 C 编码后点查询；导出 Cookie 给 GUI REST 用";
      input.focus();
    });
    input.addEventListener("keydown", (e) => {
      // textarea：Ctrl+Enter 查询；普通 Enter 换行
      if (e.key === "Enter" && e.ctrlKey) {
        e.preventDefault();
        runQuery();
      }
    });


    el.querySelector("#jlc-pr-tpl").addEventListener("click", async () => {
      if (querying) return;
      const codes = parseStockCodes(input.value);
      if (!codes.length) {
        out.textContent = "请先输入 C 编码再点「查模板」";
        return;
      }
      querying = true;
      go.disabled = true;
      const tplBtn = el.querySelector("#jlc-pr-tpl");
      if (tplBtn) tplBtn.disabled = true;
      out.textContent = `查模板中… ${codes.length} 个编码`;
      try {
        const payload = await classifyByOldTemplate(codes);
        const lines = [];
        lines.push(`<b>模板查询</b>（C码→模板名称→同模板成员）`);
        for (const r of payload.results || []) {
          lines.push(`── ${escapeHtml(r.code)} ──`);
          if (!r.found) {
            lines.push(`❌ ${escapeHtml(r.message || "未找到模板")}`);
            continue;
          }
          lines.push(
            `模板名称: <span class="badge" style="background:#0550ae">${escapeHtml(r.templateName)}</span>`
          );
          lines.push(escapeHtml(r.message || ""));
          const codesList = (r.group && r.group.codes) || [];
          const show = codesList.slice(0, 40);
          lines.push(
            `同模板 C 码 (${codesList.length}): ${escapeHtml(show.join(", "))}${
              codesList.length > 40 ? " …" : ""
            }`
          );
        }
        out.innerHTML = lines.join("<br>");
        try {
          const allCodes = [];
          for (const r of payload.results || []) {
            if (r.group && Array.isArray(r.group.codes)) {
              for (const c of r.group.codes) {
                if (!allCodes.includes(c)) allCodes.push(c);
              }
            }
          }
          if (allCodes.length) GM_setClipboard(allCodes.join("\n"));
        } catch (_) {}
      } catch (err) {
        out.textContent = String(err && err.message ? err.message : err);
      } finally {
        querying = false;
        go.disabled = false;
        if (tplBtn) tplBtn.disabled = false;
        input.focus();
      }
    });

    async function runCtuLookupOnly() {
      if (querying) return;
      const codes = parseStockCodes(input.value);
      if (!codes.length) {
        out.textContent = "请先输入料号/C 编码再点「查容器号」";
        return;
      }
      querying = true;
      go.disabled = true;
      const btn1 = el.querySelector("#jlc-pr-ctu-lookup");
      const btn2 = el.querySelector("#jlc-pr-ctu-locate");
      if (btn1) btn1.disabled = true;
      if (btn2) btn2.disabled = true;
      const lines = [
        `<b>CTU 查容器号</b>（呼出=${CTU_CALLOUT_ENABLED ? "开" : "关"}）`,
        `最近入库时间: ${escapeHtml(CTU_SHELVES_IN_STOCK_START)} ～ ${escapeHtml(
          formatLocalYmd(new Date())
        )}（页面默认近7天，已自动放宽）`,
      ];
      out.innerHTML = "查询 CTU 货位中…";
      try {
        for (const code of codes) {
          lines.push(`── ${escapeHtml(code)} ──`);
          try {
            const r = await lookupCtuContainersByStockCode(code);
            lines.push(
              `匹配字段 via=${escapeHtml(String(r.via || "无"))}；货位条数=${r.total}`
            );
            if (!r.containers.length) {
              lines.push(`❌ 未找到容器号（精确匹配无结果）`);
            } else {
              lines.push(
                `全部容器号: <span class="badge" style="background:#8250df">${escapeHtml(
                  r.containers.join(", ")
                )}</span>`
              );
              const sample = (r.rows || []).slice(0, 3);
              for (const row of sample) {
                lines.push(
                  [
                    escapeHtml(row.stockCode || ""),
                    escapeHtml(row.componentCode || ""),
                    escapeHtml(row.containerNo || ""),
                    escapeHtml(row.gridNo || ""),
                    escapeHtml(row.goodsShelvesName || ""),
                  ]
                    .filter(Boolean)
                    .join(" | ")
                );
              }
              try {
                const pick = await pickPreferredContainer(r.containers);
                const pref = pick.preferred || "";
                lines.push(
                  `优选容器: <span class="badge" style="background:#0550ae">${escapeHtml(
                    pref || "无"
                  )}</span> reason=${escapeHtml(pick.reason || "")}`
                );
                lines.push(
                  `优选可呼出 callable=${pick.callable ? "是" : "否"} scheduleStatus=${escapeHtml(
                    String(pick.scheduleStatus)
                  )}`
                );
                for (const d of pick.details || []) {
                  lines.push(
                    [
                      escapeHtml(d.containerNo || ""),
                      d.hit ? "hit" : "miss",
                      `status=${escapeHtml(String(d.scheduleStatus))}`,
                      d.callable ? "callable" : "not-callable",
                      d.error ? `err=${escapeHtml(d.error)}` : "",
                    ]
                      .filter(Boolean)
                      .join(" | ")
                  );
                }
              } catch (pe) {
                lines.push(
                  `优选/校验失败: ${escapeHtml(
                    String(pe && pe.message ? pe.message : pe)
                  )}`
                );
              }
            }
          } catch (err) {
            lines.push(`❌ ${escapeHtml(String(err && err.message ? err.message : err))}`);
          }
        }
        out.innerHTML = lines.join("<br>");
      } finally {
        querying = false;
        go.disabled = false;
        if (btn1) btn1.disabled = false;
        if (btn2) btn2.disabled = false;
        input.focus();
      }
    }

    async function runCtuLocate() {
      if (querying) return;
      const codes = parseStockCodes(input.value);
      if (!codes.length) {
        out.textContent = "请先输入料号/C 编码再点「定位容器」";
        return;
      }
      if (codes.length > 1) {
        out.textContent = "定位容器一次只支持 1 个料号（可先查容器号看多个结果）";
        return;
      }
      querying = true;
      go.disabled = true;
      const btn1 = el.querySelector("#jlc-pr-ctu-lookup");
      const btn2 = el.querySelector("#jlc-pr-ctu-locate");
      if (btn1) btn1.disabled = true;
      if (btn2) btn2.disabled = true;
      out.textContent = "CTU 定位中（不会呼出）…";
      try {
        let wantNav = false;
        if (!isOnContainerListPage()) {
          wantNav = window.confirm(
            "将跳转到容器列表页（不是库位页）并勾选容器。取消则只查号不跳转。"
          );
        }
        const r = await runCtuLocateFlow(codes[0], {
          navigate: wantNav,
          select: true,
        });
        const lines = [
          `<b>CTU 定位</b> stage=${escapeHtml(r.stage || "")}`,
          `料号: ${escapeHtml(r.stockCode || codes[0])}`,
          r.looked && r.looked.via
            ? `匹配 via=${escapeHtml(String(r.looked.via))}`
            : "",
          r.containerNo
            ? `优选容器号: <span class="badge" style="background:#8250df">${escapeHtml(
                r.containerNo
              )}</span>`
            : "",
          r.pick
            ? `优选 reason=${escapeHtml(r.pick.reason || "")} callable=${
                r.pick.callable ? "是" : "否"
              } status=${escapeHtml(String(r.pick.scheduleStatus))}`
            : "",
          r.containers && r.containers.length
            ? `全部容器: ${escapeHtml(r.containers.join(", "))}`
            : "",
          r.message ? escapeHtml(r.message) : "",
          r.select ? escapeHtml(r.select.note || "已勾选") : "",
          `呼出开关: ${CTU_CALLOUT_ENABLED ? "开" : "关（本阶段禁止）"}`,
          r.ok ? "" : `❌ ${escapeHtml(r.message || "失败")}`,
        ].filter(Boolean);
        out.innerHTML = lines.join("<br>");
      } catch (err) {
        out.textContent = String(err && err.message ? err.message : err);
      } finally {
        querying = false;
        go.disabled = false;
        if (btn1) btn1.disabled = false;
        if (btn2) btn2.disabled = false;
        input.focus();
      }
    }

    el.querySelector("#jlc-pr-ctu-lookup").addEventListener("click", runCtuLookupOnly);
    el.querySelector("#jlc-pr-ctu-locate").addEventListener("click", runCtuLocate);

    async function runPrivatePickLookupOnly() {
      if (querying) return;
      const codes = parseStockCodes(input.value);
      if (!codes.length) {
        out.textContent = "请先输入 C 编码再点「查客编库存」";
        return;
      }
      querying = true;
      go.disabled = true;
      out.textContent = "库位查客编/库存中（不开库位页）…";
      try {
        const lines = [];
        for (const c of codes) {
          const r = await lookupMaterialLocationByComponent(c);
          lines.push(
            `<b>${escapeHtml(c)}</b> ` +
              (r.ok
                ? `客编=<span class="badge" style="background:#1a7f37">${escapeHtml(
                    r.customerCode
                  )}</span> 库存总量=${escapeHtml(
                    String(r.totalStockNumber)
                  )} via=${escapeHtml((r.rows[0] && r.rows[0].via) || "")}`
                : `❌ ${escapeHtml(r.message || "未找到")}`)
          );
          if (r.customerCodes && r.customerCodes.length > 1) {
            lines.push(
              `· 多客编: ${escapeHtml(r.customerCodes.join(", "))}`
            );
          }
        }
        out.innerHTML = lines.join("<br>");
      } catch (err) {
        out.textContent = String(err && err.message ? err.message : err);
      } finally {
        querying = false;
        go.disabled = false;
        input.focus();
      }
    }

    async function runPrivatePickFill() {
      if (querying) return;
      const codes = parseStockCodes(input.value);
      if (!codes.length) {
        out.textContent = "请先输入 1 个 C 编码再点「填提货申请」";
        return;
      }
      if (codes.length > 1) {
        out.textContent = "填提货申请一次只支持 1 个 C 编码";
        return;
      }
      const qtyEl = el.querySelector("#jlc-pr-pick-qty");
      const pkgEl = el.querySelector("#jlc-pr-pick-pkg");
      const qtyRaw = qtyEl ? String(qtyEl.value || "").trim() : "";
      const qty = qtyRaw ? Number(qtyRaw) : null;
      if (qtyRaw && (!Number.isFinite(qty) || qty <= 0)) {
        out.textContent = "提货数量须为正数";
        return;
      }
      querying = true;
      go.disabled = true;
      out.textContent = "私有库提货：查客编并填单中（不自动提交）…";
      try {
        let wantNav = true;
        if (!isOnPrivatePickAddPage()) {
          wantNav = window.confirm(
            "将跳转到「新增私有库提货申请」页并自动填单（用途=重新入库，备注=校对）。\n取消则只查客编/库存。"
          );
        }
        const r = await runPrivatePickFillFlow(codes[0], {
          navigate: wantNav,
          qty,
          packageCode: pkgEl ? pkgEl.value : "",
          remark: PRIVATE_PICK_DEFAULT_REMARK,
        });
        if (r.stage === "navigating") {
          out.innerHTML = [
            `<b>私有库提货</b> 正在跳转新增页…`,
            `料号: ${escapeHtml(r.stockCode || "")}`,
            `客编: ${escapeHtml(r.customerCode || "")}`,
            `库存总量: ${escapeHtml(String(r.totalStockNumber))}`,
          ].join("<br>");
          return;
        }
        const lines = [
          `<b>私有库提货</b> stage=${escapeHtml(r.stage || "")}`,
          `料号: ${escapeHtml(r.stockCode || codes[0])}`,
          r.customerCode
            ? `客编: <span class="badge" style="background:#1a7f37">${escapeHtml(
                r.customerCode
              )}</span>`
            : "",
          r.totalStockNumber != null
            ? `库存总量: ${escapeHtml(String(r.totalStockNumber))}`
            : "",
          qty != null ? `提货数量: ${escapeHtml(String(qty))}` : "",
          r.filled
            ? `已填: 用途=重新入库 备注=${escapeHtml(
                (r.filled.filled && r.filled.filled.remark) || "校对"
              )}`
            : "",
          r.filled && r.filled.note ? escapeHtml(r.filled.note) : "",
          r.message ? escapeHtml(r.message) : "",
          r.ok ? "" : `❌ ${escapeHtml(r.message || "失败")}`,
        ].filter(Boolean);
        out.innerHTML = lines.join("<br>");
      } catch (err) {
        out.textContent = String(err && err.message ? err.message : err);
      } finally {
        querying = false;
        go.disabled = false;
        input.focus();
      }
    }

    el.querySelector("#jlc-pr-pick-lookup").addEventListener(
      "click",
      runPrivatePickLookupOnly
    );
    el.querySelector("#jlc-pr-pick-fill").addEventListener(
      "click",
      runPrivatePickFill
    );

    el.querySelector("#jlc-pr-cookie").addEventListener("click", async () => {
      out.textContent = "正在收集 Cookie…";
      try {
        const { message, info } = await exportCookieForGui();
        out.textContent = message;
        if (!info.okForRest) {
          out.textContent +=
            "\n\n提示：Tampermonkey 需开启「允许访问 Cookie」权限；或 F12→Network 复制完整 Cookie 头。";
        }
      } catch (err) {
        out.textContent = String(err && err.message ? err.message : err);
      }
    });

    el.querySelector("#jlc-pr-download").addEventListener("click", async () => {
      out.textContent = "正在准备下载…";
      try {
        const { cookie, info, message } = await exportCookieForGui();
        downloadCookieFile(cookie);
        out.textContent =
          message +
          `\n\n已触发下载 jlc_cookie.txt（${info.count} 字段）\n请保存到 yamaha_migrate_gui\\config\\`;
      } catch (err) {
        out.textContent = String(err && err.message ? err.message : err);
      }
    });

    async function runLibDownload(useCode) {
      const fmt = el.querySelector("#jlc-pr-dl-fmt").value || "proofread";
      out.textContent = useCode
        ? `按 C 码批量下载中（${fmt}）…`
        : `下载勾选元件中（${fmt}）…`;
      try {
        let opt = {};
        if (useCode) {
          const codes = parseStockCodes(input.value || "");
          if (!codes.length) throw new Error("请先输入一个或多个 C 编码");
          out.textContent = `解析到 ${codes.length} 个 C 码，正在下载（${fmt}）…`;
          opt = { stockCodes: codes };
        }
        const r = await downloadComponents(fmt, opt);
        const ingestDirs =
          r.ingest && r.ingest.dirs
            ? r.ingest.dirs.join("\n")
            : r.ingest && r.ingest.codes
              ? (r.ingest.codes || [])
                  .map((c) => `D:\\auto\\yrm20\\_old_libs\\${c}`)
                  .join("\n")
              : "";
        out.textContent = [
          r.via === "old_libs"
            ? `✅ 已入库 _old_libs（${r.format}），成功 ${r.count} 个`
            : `⚠ 桥离线，已回退浏览器下载（${r.format}），成功 ${r.count} 个`,
          r.filename ? `文件: ${r.filename}` : "",
          r.labels && r.labels.length
            ? `元件: ${r.labels.slice(0, 12).join(", ")}${
                r.labels.length > 12 ? "…" : ""
              }`
            : "",
          r.missed && r.missed.length
            ? `⚠ 失败 ${r.missed.length} 个:\n${r.missed.join("\n")}`
            : "",
          r.bytes != null ? `大小约 ${r.bytes} 字节` : "",
          r.via === "old_libs"
            ? `目录:\n${ingestDirs || "D:\\auto\\yrm20\\_old_libs\\{C编码}"}`
            : `原因: ${r.ingestError || "未知"}\n请先运行 bridge_serve.bat，或在下载栏确认 zip。`,
        ]
          .filter(Boolean)
          .join("\n");
      } catch (err) {
        out.textContent = String(err && err.message ? err.message : err);
      }
    }

    el.querySelector("#jlc-pr-dl-sel").addEventListener("click", () =>
      runLibDownload(false)
    );
    el.querySelector("#jlc-pr-dl-code").addEventListener("click", () =>
      runLibDownload(true)
    );

    const api = async (raw, mode = "both") => {
      input.value = raw;
      el.querySelector("#jlc-pr-mode").value = mode;
      el.classList.remove("collapsed");
      await runQuery();
    };
    window.__jlcProofreadQuery = api;
    if (typeof unsafeWindow !== "undefined") {
      unsafeWindow.__jlcProofreadQuery = api;
    }
  }

  function ensureFab(root) {
    if (
      !root ||
      root.getElementById(PANEL_ID) ||
      root.getElementById("jlc-proofread-fab")
    ) {
      return;
    }
    ensureStyles();
    const btn = document.createElement("button");
    btn.id = "jlc-proofread-fab";
    btn.type = "button";
    btn.textContent = `JLC桥 v${VERSION}`;
    btn.title = "点开校对面板；日常下载只需保持本页在 nw 且桥在线";
    btn.addEventListener("click", () => {
      btn.remove();
      ensurePanel();
    });
    (root.body || root.documentElement).appendChild(btn);
  }

  function boot() {
    const root = getInjectRoot();
    if (!root) return;

    console.info("[JLC校对快查]", VERSION, location.href);
    exposeGlobals();
    // 默认只挂 FAB + 桥；不强制展开校对面板（仓库主流程不靠面板）
    ensureFab(root);
    if (root.getElementById(PANEL_ID)) {
      /* 用户已打开过则保留 */
    }
    startBridgeLoop();
    ensureBridgeWatchdog();
    ensureSpaBridgeWatch();
    // 启动：缺 SMT 时先从磁盘 cookie 恢复，再探测 nw
    setTimeout(() => {
      tryRestoreLoginFromDisk().catch(() => ({})).then(() => probeNwSession(true))
        .then((p) => {
          if (p && p.ok === false) {
            updateBridgeUi(
              `本机桥：假在线 v${VERSION} · 请停留任意 nw.jlcerp.com 标签重新登录（不自动开页）`,
              false
            );
          }
        })
        .catch(() => {});
    }, 1800);
    // 仅当用户曾触发 CTU 并留下 pending 时才续跑（不会无故跳转）
    setTimeout(() => {
      resumeCtuPendingIfAny().catch(() => {});
    }, 1200);
    setTimeout(() => {
      resumePrivatePickPendingIfAny().catch(() => {});
    }, 1400);
  }

  if (window === window.top) {
    GM_registerMenuCommand("打开贴片机机器库页（领 SMT 会话）", () => {
      try {
        location.assign(URL_MACHINE_LIB_NW);
      } catch (_) {
        window.open(URL_MACHINE_LIB_NW, "_blank");
      }
    });
    GM_registerMenuCommand("下载勾选元件（批量校对 zip）", async () => {
      try {
        const r = await downloadComponents("proofread", {});
        alert(`已触发下载 ${r.count} 个元件（批量校对）`);
      } catch (err) {
        alert(String(err && err.message ? err.message : err));
      }
    });
    GM_registerMenuCommand("按输入框多 C 码下载（批量校对）", async () => {
      try {
        const ta = document.querySelector("#jlc-pr-code");
        const codes = parseStockCodes(ta ? ta.value : "");
        if (!codes.length) throw new Error("面板输入框无 C 编码");
        const r = await downloadComponents("proofread", { stockCodes: codes });
        alert(
          `成功 ${r.count} 个` +
            (r.missed && r.missed.length
              ? `\n失败:\n${r.missed.join("\n")}`
              : "")
        );
      } catch (err) {
        alert(String(err && err.message ? err.message : err));
      }
    });
    GM_registerMenuCommand("【REST】导出完整 Cookie → 剪贴板+本机桥", async () => {
      try {
        const { message, info } = await exportCookieForGui();
        alert(message);
        if (!info.okForRest) {
          alert(
            "警告：未检测到 JWT/SESSION。\n请在 Tampermonkey 脚本设置中允许 Cookie 访问，或从 F12 Network 复制完整 Cookie。"
          );
        }
      } catch (err) {
        alert(String(err && err.message ? err.message : err));
      }
    });
    GM_registerMenuCommand("【REST】下载 jlc_cookie.txt", async () => {
      try {
        const { cookie, info } = await exportCookieForGui();
        downloadCookieFile(cookie);
        alert(
          `已触发下载（${info.count} 字段，${cookie.length} 字符）\n并尝试写入本机桥 config\\jlc_cookie.txt`
        );
      } catch (err) {
        alert(String(err && err.message ? err.message : err));
      }
    });
    GM_registerMenuCommand("本机桥：立即同步 Cookie", async () => {
      try {
        const r = await syncCookieToBridge();
        alert(r.message);
      } catch (err) {
        alert(String(err && err.message ? err.message : err));
      }
    });
    GM_registerMenuCommand("本机桥：切换防休眠（Wake Lock）", () => {
      const on = GM_getValue("bridge_wake_lock", true) !== false;
      GM_setValue("bridge_wake_lock", !on);
      if (!on) {
        requestBridgeWakeLock().catch(() => {});
        alert("已开启防休眠（减少后台节流导致断连）");
      } else {
        releaseBridgeWakeLock();
        alert("已关闭防休眠");
      }
    });
    GM_registerMenuCommand("本机桥：切换静音保活（AudioContext）", () => {
      const on = GM_getValue("bridge_audio_keepalive", false) === true;
      GM_setValue("bridge_audio_keepalive", !on);
      if (!on) {
        startAudioKeepAlive();
        alert("已开启静音保活（部分浏览器可减少后台节流，默认关闭）");
      } else {
        stopAudioKeepAlive();
        alert("已关闭静音保活");
      }
    });
    GM_registerMenuCommand("本机桥：立即重连", () => {
      restartBridgeServices("manual");
      alert("已触发桥接重连（请确认 ERP/start.bat 已运行）");
    });
    GM_registerMenuCommand("本机桥：诊断信息", () => {
      const cfg = bridgeConfig();
      const leader = readBridgeLeader();
      alert(
        [
          `版本: ${VERSION}`,
          `标签 ID: ${TAB_ID}`,
          `主标签: ${bridgeIsLeader() ? "是" : "否"}`,
          `leader: ${leader ? leader.id + " @ " + new Date(leader.ts).toLocaleTimeString() : "无"}`,
          `bridgeBusy: ${bridgeBusy}`,
          `lastHeartbeatOk: ${lastHeartbeatOk ? new Date(lastHeartbeatOk).toLocaleTimeString() : "无"}`,
          `lastHeartbeatFail: ${lastHeartbeatFail ? new Date(lastHeartbeatFail).toLocaleTimeString() : "无"}`,
          `hidden: ${document.hidden}`,
          `port: ${cfg.port}`,
          `wakeLock: ${GM_getValue("bridge_wake_lock", true) !== false}`,
          `audioKeepalive: ${GM_getValue("bridge_audio_keepalive", false) === true}`,
        ].join("\n")
      );
    });
    GM_registerMenuCommand("本机桥：开/关", () => {
      const on = GM_getValue("bridge_enabled", true) !== false;
      GM_setValue("bridge_enabled", !on);
      if (!on) {
        startBridgeLoop();
        ensureBridgeWatchdog();
        ensureSpaBridgeWatch();
        alert("已开启本机桥轮询（需先运行 bridge_serve.bat 或 ERP start.bat）");
        updateBridgeUi("本机桥：已开启，检测中…", true);
      } else {
        stopBridgeTimers();
        stopBridgeWatchdog();
        if (spaWatchTimer) {
          clearInterval(spaWatchTimer);
          spaWatchTimer = null;
        }
        releaseBridgeWakeLock();
        stopAudioKeepAlive();
        alert("已关闭本机桥轮询");
        updateBridgeUi("本机桥：已关闭", false);
      }
    });
    GM_registerMenuCommand("本机桥：设置端口/token", () => {
      const cfg = bridgeConfig();
      const port = prompt("桥接端口（默认 18765）", String(cfg.port));
      if (port === null) return;
      const token = prompt("桥接 token", cfg.token);
      if (token === null) return;
      GM_setValue("bridge_port", Number(port) || BRIDGE_DEFAULT_PORT);
      GM_setValue("bridge_token", String(token || BRIDGE_DEFAULT_TOKEN).trim());
      alert("已保存。请保持嘉立创 ERP 页打开，并运行 bridge_serve.bat");
    });
    GM_registerMenuCommand("打开校对快查面板", () => {
      const root = getInjectRoot() || document;
      const fab = root.getElementById("jlc-proofread-fab");
      if (fab) fab.remove();
      ensurePanel();
    });
    GM_registerMenuCommand("查模板（C码→模板名→同模板）", async () => {
      ensurePanel();
      const root = getInjectRoot() || document;
      const btn = root.getElementById("jlc-pr-tpl");
      if (btn) {
        btn.click();
        return;
      }
      const codes = parseStockCodes(
        prompt("输入要查询的 C 编码（可多个）", "C53114047") || ""
      );
      if (!codes.length) return;
      try {
        const r = await classifyByOldTemplate(codes);
        alert(JSON.stringify(r, null, 2).slice(0, 1800));
      } catch (e) {
        alert(String(e && e.message ? e.message : e));
      }
    });
    GM_registerMenuCommand("设置 secretkey（可选）", () => {
      const cur = GM_getValue("secretkey", "") || "";
      const v = prompt(
        "若接口报鉴权相关错误，可从浏览器请求头复制 secretkey 填入（可留空）：",
        cur
      );
      if (v !== null) GM_setValue("secretkey", v.trim());
    });
    GM_registerMenuCommand("测试 C53114047（新旧都查）", async () => {
      try {
        const r = await queryProofread("C53114047", "both");
        alert(JSON.stringify(r, null, 2));
      } catch (err) {
        alert(String(err && err.message ? err.message : err));
      }
    });
    GM_registerMenuCommand("CTU：查容器号（不呼出）", async () => {
      const code = prompt("输入料号/C 编码", "C53114047");
      if (!code) return;
      try {
        const r = await lookupCtuContainersByStockCode(code);
        alert(JSON.stringify(r, null, 2).slice(0, 1800));
      } catch (err) {
        alert(String(err && err.message ? err.message : err));
      }
    });
    GM_registerMenuCommand("CTU：定位容器勾选（不呼出）", async () => {
      const code = prompt("输入料号/C 编码（可选跳转容器列表并勾选）", "C53114047");
      if (!code) return;
      try {
        const wantNav = window.confirm(
          "是否跳转到容器列表页？（不是库位页；取消=只查号）"
        );
        const r = await runCtuLocateFlow(code, {
          navigate: wantNav,
          select: true,
        });
        if (r.stage !== "navigating") {
          alert(JSON.stringify(r, null, 2).slice(0, 1800));
        }
      } catch (err) {
        alert(String(err && err.message ? err.message : err));
      }
    });
    GM_registerMenuCommand("私有库：查客编库存（C编码）", async () => {
      const code = prompt("输入 C 编码", "C710631");
      if (!code) return;
      try {
        const r = await lookupMaterialLocationByComponent(code);
        alert(JSON.stringify(r, null, 2).slice(0, 1800));
      } catch (err) {
        alert(String(err && err.message ? err.message : err));
      }
    });
    GM_registerMenuCommand("私有库：填提货申请（重新入库/校对）", async () => {
      const code = prompt("输入 C 编码（将跳转新增页填单，不自动提交）", "C710631");
      if (!code) return;
      const qtyStr = prompt("提货数量（可留空）", "1");
      const pkg = prompt("包裹编号（重新入库必填，可先留空待确认）", "") || "";
      try {
        const r = await runPrivatePickFillFlow(code, {
          navigate: true,
          qty: qtyStr ? Number(qtyStr) : null,
          packageCode: pkg,
          remark: PRIVATE_PICK_DEFAULT_REMARK,
        });
        if (r.stage !== "navigating") {
          alert(JSON.stringify(r, null, 2).slice(0, 1800));
        }
      } catch (err) {
        alert(String(err && err.message ? err.message : err));
      }
    });
    GM_registerMenuCommand("测试 C9900308591（新旧都查）", async () => {
      try {
        const r = await queryProofread("C9900308591", "both");
        alert(JSON.stringify(r, null, 2));
      } catch (err) {
        alert(String(err && err.message ? err.message : err));
      }
    });
  }

  try {
    boot();
  } catch (e) {
    console.error("[JLC校对快查] init failed", e);
  }
})();