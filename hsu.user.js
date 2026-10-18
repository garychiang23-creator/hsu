// ==UserScript==
// @name         許氏注音（Safari 就地輸入）
// @namespace    hsu_ime
// @version      1.7
// @description  在 Safari 的任何輸入框裡用許氏注音打中文。引擎＝小麥注音網頁版（MIT）。
// @author       Gary + Claude
// @match        *://*/*
// @exclude      https://garychiang23-creator.github.io/hsu/*
// @noframes
// @require      https://garychiang23-creator.github.io/hsu/vendor/mcbopomofo.bundle.js
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/* 為什麼是單一檔案（v1.5，別再拆）
 * v1.4 試過拆成「殼 + @require 核心」，想讓改版不必在 iPad 重裝。
 * **實測失敗**：第二條 @require 的核心沒有被載入，浮動列完全不出現。
 * 結論：這個環境下 userscript 只能是單檔，邏輯必須全部寫在這裡。
 * 代價認了——改這支就是要在 iPad 重裝一次。
 *
 * 為什麼有 @noframes（2026-08-05 實測後加的，別拿掉）
 * 沒有它的話，5.2MB 引擎會在**每一個 iframe** 各解析一次。
 * claude.ai 實測：腳本跑進 a.claude.ai/isolated-segment.html 這個 innerHeight=0 的
 * 隱藏分析 iframe，白燒一次 323ms，還在看不見的地方建了一條浮動列。
 * 代價：iframe 裡的輸入框用不到。可接受——claude.ai 和 Google 的輸入框都在頂層。
 */

/* 設計筆記（改之前先讀）
 *
 * 1. root-window preedit：組字中的字只畫在浮動列上，**不寫進目標輸入框**。
 *    只有 commitString 才注入。這樣就不必每次組字都去改別人的（可能是 React 控制的）
 *    輸入框，少掉整類打架。
 *
 * 2. 注入用三段瀑布：execCommand insertText → native setter + input 事件 → Range。
 *    第一個成功就停。按 ⌃⇧K 會回報當下這個輸入框吃哪一種（診斷用）。
 *
 * 3. keydown 一律在 capture 階段攔；引擎吃掉的鍵要 preventDefault + stopImmediatePropagation，
 *    否則網站自己的快捷鍵會同時被觸發。
 *
 * 4. 焦點不在可編輯元素時完全不作用，網站原本的快捷鍵照常。
 *
 * 5. ⌘ 組合鍵一律放行（⌘C/⌘V/⌘A/⌘Enter）。
 *
 * 6. 前提：iPad 的系統輸入來源必須停在 ABC。停在注音時系統會先吃掉按鍵，
 *    腳本會偵測到並在浮動列上提示。
 *
 * 7. 個人詞庫：localStorage 是按網域分開的，所以這裡加的詞**只在當下這個網站有效**，
 *    跟寫字台／便條那份也不相通。跨網站共用要先 probe Userscripts 的 GM 儲存（未驗證，別直接改 @grant）。
 *    種子詞跟 pad.js 同一份，smoke test U19 守著。
 */

(function () {
  "use strict";

  if (window.__hsu_ime_loaded) return;
  window.__hsu_ime_loaded = true;

  var VERSION = "1.7";   // 跟 @version 一致，smoke test U18 守著

  var mcb = window.mcbopomofo;
  if (!mcb || !mcb.InputController) {
    console.warn("[hsu] 注音引擎沒載到，@require 可能失敗");
    return;
  }

  /* ================= 目標元素 ================= */

  function activeEditable() {
    var el = document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    if (!el) return null;
    var tag = el.tagName;
    if (tag === "TEXTAREA") return el;
    if (tag === "INPUT") {
      var t = (el.type || "text").toLowerCase();
      // 不含 password：密碼框裡轉成中文只會打錯，浮動列還會把打的字明碼顯示出來
      var okTypes = ["text", "search", "url", "email", "tel", ""];
      return okTypes.indexOf(t) >= 0 ? el : null;
    }
    if (el.isContentEditable) return el;
    return null;
  }

  /* ================= 注入（三段瀑布） ================= */

  function readVal(el) { return el.value != null ? el.value : el.textContent; }

  function byExecCommand(el, s) {
    if (!document.execCommand) return false;
    var before = readVal(el);
    var r = document.execCommand("insertText", false, s);
    return !!r && readVal(el) !== before;
  }

  function byNativeSetter(el, s) {
    if (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA") return false;
    var proto = el.tagName === "INPUT" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    var d = Object.getOwnPropertyDescriptor(proto, "value");
    if (!d || !d.set) return false;
    var a = el.selectionStart == null ? el.value.length : el.selectionStart;
    var b = el.selectionEnd == null ? el.value.length : el.selectionEnd;
    var before = el.value;
    d.set.call(el, before.slice(0, a) + s + before.slice(b));
    try { el.setSelectionRange(a + s.length, a + s.length); } catch (e) {}
    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: s, inputType: "insertText" }));
    return el.value !== before;
  }

  function byRange(el, s) {
    if (!el.isContentEditable) return false;
    var sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return false;
    var before = el.textContent;
    var range = sel.getRangeAt(0);
    range.deleteContents();
    var node = document.createTextNode(s);
    range.insertNode(node);
    range.setStartAfter(node); range.setEndAfter(node);
    sel.removeAllRanges(); sel.addRange(range);
    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: s, inputType: "insertText" }));
    return el.textContent !== before;
  }

  var METHODS = [
    ["execCommand", byExecCommand],
    ["nativeSetter", byNativeSetter],
    ["range", byRange],
  ];

  var lastMethod = null;

  function inject(text) {
    var el = activeEditable();
    if (!el) return false;
    // 上次成功的方法先試，省得每次都從頭走
    var order = METHODS.slice();
    if (lastMethod) {
      order.sort(function (a, b) { return (b[0] === lastMethod) - (a[0] === lastMethod); });
    }
    for (var i = 0; i < order.length; i++) {
      try {
        if (order[i][1](el, text)) { lastMethod = order[i][0]; return true; }
      } catch (e) { /* 換下一招 */ }
    }
    console.warn("[hsu] 三種注入方法都失敗", el);
    return false;
  }

  /* ================= 浮動列 ================= */

  var bar, preedit, tipEl, cands, badge;

  function buildBar() {
    bar = document.createElement("div");
    bar.id = "__hsu_bar";
    // 位置由 placeBar() 用 visualViewport 算，不用 bottom 釘死——
    // iPad 接實體鍵盤時底部那條系統快捷列是疊在畫面上的，釘在底部會被它蓋住。
    bar.style.cssText = [
      "position:fixed", "left:50%", "transform:translateX(-50%)", "top:0",
      "z-index:2147483647", "display:none", "align-items:center", "gap:10px",
      "max-width:min(92vw,760px)", "padding:8px 12px", "border-radius:12px",
      "background:rgba(24,26,32,.96)", "color:#eef1f7",
      "box-shadow:0 8px 30px rgba(0,0,0,.45)",
      "font:17px/1.4 -apple-system,'PingFang TC',sans-serif",
      "-webkit-backdrop-filter:blur(12px)", "backdrop-filter:blur(12px)",
      "overflow-x:auto", "white-space:nowrap",
    ].join(";");

    // 徽章可以點 —— Shift 單擊之外的第二條路（誤觸 Shift 時的救命索）
    badge = document.createElement("button");
    badge.id = "__hsu_badge";
    badge.title = "切換中文／英文（也可以按 Shift）";
    badge.style.cssText = "flex:0 0 auto;font:inherit;font-size:12px;font-weight:700;" +
      "padding:4px 11px;border-radius:99px;border:0;cursor:pointer;" +
      "background:#7fb2ff;color:#181a20";
    badge.textContent = "中";
    badge.addEventListener("click", function (e) {
      e.stopPropagation();
      setChinese(!chinese);
    });

    preedit = document.createElement("span");
    preedit.style.cssText = "flex:0 0 auto;font-size:19px;border-bottom:2px solid #7fb2ff;padding-bottom:1px;min-width:1px";

    // 引擎提示（標記時的「按下 Enter 加入詞彙」、排除選單的問句）與我方通知
    tipEl = document.createElement("span");
    tipEl.style.cssText = "flex:0 0 auto;font-size:13px;color:#98a2b6;display:none";

    cands = document.createElement("span");
    cands.style.cssText = "flex:0 0 auto;display:inline-flex;gap:2px;align-items:center";

    var flip = document.createElement("button");
    flip.id = "__hsu_flip";
    flip.textContent = "⇅";
    flip.title = "把這條列翻到上面／下面";
    flip.style.cssText = "flex:0 0 auto;margin-left:auto;font:inherit;font-size:15px;" +
      "padding:2px 9px;border-radius:8px;border:1px solid #3a4150;background:transparent;" +
      "color:#98a2b6;cursor:pointer";
    flip.addEventListener("click", function (e) {
      e.stopPropagation();
      barPos = barPos === "top" ? "bottom" : "top";
      try { localStorage.setItem(POS_KEY, barPos); } catch (err) {}
      placeBar();
      logViewport("flip");
    });

    bar.appendChild(badge); bar.appendChild(preedit); bar.appendChild(tipEl);
    bar.appendChild(cands); bar.appendChild(flip);
    // 點浮動列不能搶走輸入框的 focus
    bar.addEventListener("pointerdown", function (e) { e.preventDefault(); });
    bar.addEventListener("click", function (e) {
      var t = e.target.closest ? e.target.closest("[data-k]") : null;
      if (t) { try { controller.simpleKeyboardEvent(t.getAttribute("data-k"), false, false); } catch (err) {} }
    });
    (document.body || document.documentElement).appendChild(bar);
  }

  /* 位置：預設放上面。iPad 的系統快捷列固定在下面，上面保證不會被蓋。
   * 想放下面就按 ⇅，會記住。 */
  var POS_KEY = "__hsu_bar_pos";
  var barPos = "top";
  try { barPos = localStorage.getItem(POS_KEY) || "top"; } catch (e) {}

  function placeBar() {
    var vv = window.visualViewport;
    var vh = vv ? vv.height : window.innerHeight;
    var voff = vv ? vv.offsetTop : 0;
    var h = bar.offsetHeight || 46;
    var topY = voff + 12, botY = voff + vh - h - 12;
    var y = barPos === "top" ? topY : botY, other = barPos === "top" ? botY : topY;
    // 偏好的位置會蓋到正在打字的那個框（例如 Google 結果頁頂端的搜尋框）就換到另一邊；
    // 兩邊都會蓋到（佔滿畫面的編輯區）就照偏好。
    var el = activeEditable();
    if (el && el.getBoundingClientRect) {
      var r = el.getBoundingClientRect();
      var covers = function (t) { return t < r.bottom && t + h > r.top; };
      if (covers(y) && !covers(other)) y = other;
    }
    bar.style.top = y + "px";
  }

  // 把實際數字印出來，才知道那條系統快捷列到底吃掉多少高度（diff）。
  // diff = 0 代表 iPadOS 沒有為它縮小網頁視窗，網頁量不到它 → 只能靠放上面避開。
  function logViewport(tag) {
    var vv = window.visualViewport;
    console.log("[hsu] viewport(" + tag + ")", JSON.stringify({
      innerHeight: window.innerHeight,
      vvHeight: vv ? Math.round(vv.height) : null,
      vvOffsetTop: vv ? Math.round(vv.offsetTop) : null,
      diff: vv ? Math.round(window.innerHeight - vv.height) : null,
      barHeight: bar.offsetHeight,
      barPos: barPos,
    }));
  }

  function showBar(on) {
    bar.style.display = on ? "flex" : "none";
    if (on) placeBar();
  }

  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", function () { placeBar(); logViewport("resize"); });
    window.visualViewport.addEventListener("scroll", placeBar);
  }
  window.addEventListener("resize", placeBar);
  // 頁面捲動時輸入框會移動，重新判斷要不要讓開（capture 才收得到內層捲動容器的 scroll）
  window.addEventListener("scroll", function () {
    if (bar.style.display !== "none") placeBar();
  }, { capture: true, passive: true });

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  function toast(msg, good) {
    var t = document.createElement("div");
    t.style.cssText = [
      "position:fixed", "right:16px", "bottom:calc(70px + env(safe-area-inset-bottom))",
      "z-index:2147483647", "max-width:70vw", "padding:11px 15px", "border-radius:10px",
      "font:14px/1.5 -apple-system,'PingFang TC',sans-serif", "color:#fff",
      "white-space:pre-wrap", "pointer-events:none",
      "box-shadow:0 6px 24px rgba(0,0,0,.35)",
      "background:" + (good ? "#1f7a3d" : "#8c2020"),
    ].join(";");
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 5000);
  }

  /* ================= 引擎 ================= */

  var composing = "";
  var noticeMsg = "", noticeTimer = null, engineTip = "";

  function paintTip() {
    var t = engineTip || noticeMsg;
    tipEl.textContent = t;
    tipEl.style.color = engineTip ? "#98a2b6" : "#6ee39a";
    tipEl.style.display = t ? "" : "none";
  }

  function notice(msg) {
    noticeMsg = msg; paintTip(); showBar(true);
    if (noticeTimer) clearTimeout(noticeTimer);
    noticeTimer = setTimeout(function () { noticeMsg = ""; paintTip(); refreshBar(); }, 2500);
  }

  // 組字列：標記（Shift+←→）的字段反白；游標不在最後時畫一條插入線，方向鍵移進去選字時看得到位置
  function renderPreedit(segs, cursor) {
    var html = "", off = 0, total = 0, marked = false;
    var caret = '<span style="border-left:2px solid #7fb2ff;margin:0 -1px"></span>';
    segs.forEach(function (s) { total += (s.text || "").length; if (s.style === "highlighted") marked = true; });
    var showCaret = !marked && cursor < total;
    segs.forEach(function (s) {
      var t = s.text || "";
      if (s.style === "highlighted") {
        html += '<span style="background:#2d4a7c;border-radius:4px">' + esc(t) + "</span>";
      } else if (showCaret && cursor >= off && cursor < off + t.length) {
        html += esc(t.slice(0, cursor - off)) + caret + esc(t.slice(cursor - off));
      } else {
        html += esc(t);
      }
      off += t.length;
    });
    return html;
  }

  var ui = {
    reset: function () {
      composing = ""; engineTip = ""; preedit.textContent = ""; cands.innerHTML = ""; paintTip(); refreshBar();
    },
    commitString: function (text) {
      if (!text) return;
      if (!inject(text)) toast("✗ 這個輸入框塞不進去\n按 ⌃⇧K 看細節", false);
      composing = ""; engineTip = ""; preedit.textContent = ""; cands.innerHTML = ""; paintTip(); refreshBar();
    },
    update: function (json) {
      var st;
      try { st = JSON.parse(json); } catch (e) { return; }
      var segs = st.composingBuffer || [];
      composing = segs.map(function (x) { return x.text || ""; }).join("");
      preedit.innerHTML = renderPreedit(segs, st.cursorIndex | 0);
      engineTip = st.tooltip || "";
      paintTip();
      var list = st.candidates || [];
      cands.innerHTML = list.map(function (w) {
        var c = w.candidate || {};
        var text = c.displayedText || c.value || "";
        return '<span data-k="' + esc(w.keyCap) + '" style="padding:3px 8px;border-radius:7px;cursor:pointer;' +
          (w.selected ? "background:#2d4a7c;" : "") + '"><span style="font-size:11px;color:#98a2b6;margin-right:4px">' +
          esc(w.keyCap) + "</span>" + esc(text) + "</span>";
      }).join("");
      refreshBar();
    },
  };

  var controller = new mcb.InputController(ui);
  controller.setKeyboardLayout("Hsu");
  controller.setLanguageCode("zh-TW");
  controller.setUserVerticalCandidates(false);
  if (controller.setOnError) controller.setOnError(function () {});

  /* ================= 個人詞庫（只在這個網站，見設計筆記 7） ================= */

  var PHRASES_KEY = "__hsu_phrases", EXCLUDED_KEY = "__hsu_excluded";
  // 跟 pad.js 的 SEED 同一份（smoke test U19 比對）。讀音鍵必須是連字號串起的注音。
  var SEED = [
    ["ㄒㄧㄣ-ㄏㄨㄚˊ", ["昕樺"]],
    ["ㄧ-ㄏㄜˊ", ["一盒"]],
    ["ㄨㄛˇ-ㄌㄞˊ-ㄉㄧㄥˋ", ["我來訂"]],
    ["ㄐㄧㄥ-ㄏㄨㄥˊ", ["晶宏"]],
    ["ㄓㄜˋ-ㄉㄤˇ", ["這檔"]]
  ];

  function loadMap(key, seed) {
    var raw = null;
    try { raw = localStorage.getItem(key); } catch (e) {}
    if (raw === null) return new Map(seed || []);
    var m = new Map();
    try {
      JSON.parse(raw).forEach(function (p) {
        if (typeof p[0] !== "string" || !Array.isArray(p[1])) return;
        var ws = p[1].filter(function (w) { return typeof w === "string" && w; });
        if (ws.length) m.set(p[0], ws);
      });
    } catch (e) {}
    return m;
  }
  function saveMap(key, m) {
    var arr = [];
    m.forEach(function (ws, r) { if (ws.length) arr.push([r, ws.slice()]); });
    try { localStorage.setItem(key, JSON.stringify(arr)); } catch (e) {}
  }

  controller.setUserPhrases(loadMap(PHRASES_KEY, SEED));
  controller.setExcludedPhrases(loadMap(EXCLUDED_KEY));
  controller.setOnPhraseChange(function (m) { saveMap(PHRASES_KEY, m); notice("✓ 已加入詞庫（只在這個網站）"); });
  controller.setOnExcludedPhraseChange(function (m) { saveMap(EXCLUDED_KEY, m); notice("✓ 已排除（只在這個網站）"); });

  /* ================= 模式與按鍵 ================= */

  /* 模式：**預設英文**。
   * @match 開到全站之後，預設中文是危險的——你在任何陌生網站的搜尋框打 hotel
   * 會直接變注音亂碼。所以預設不攔，你在哪個網域按過 Shift 切中文，
   * 那個網域才記住（localStorage 本來就是按 origin 分開的，天然就是「按網域記住」）。
   */
  var MODE_KEY = "__hsu_mode";
  var chinese = false;
  try { chinese = localStorage.getItem(MODE_KEY) === "zh"; } catch (e) {}
  var shiftAlone = false;
  var warnShown = false;   // 目前浮動列上是不是掛著「請切 ABC」的警示

  function refreshBar() {
    var focused = !!activeEditable();
    badge.textContent = chinese ? "中" : "英";
    badge.style.background = chinese ? "#7fb2ff" : "#4a5162";
    badge.style.color = chinese ? "#181a20" : "#c8cfdd";
    // 焦點在輸入框就顯示。英文模式也要顯示，否則切過去之後沒有任何東西告訴你現在是英文。
    showBar(focused);
  }

  function setChinese(on) {
    chinese = on;
    try { localStorage.setItem(MODE_KEY, on ? "zh" : "en"); } catch (e) {}
    controller.reset();
    composing = ""; preedit.textContent = ""; cands.innerHTML = "";
    refreshBar();
  }

  function intercepted(e) {
    return e.isComposing === true || e.keyCode === 229 || e.key === "Process";
  }

  document.addEventListener("keydown", function (e) {
    // 診斷熱鍵：不管什麼模式都要能按
    if (e.ctrlKey && e.shiftKey && (e.key === "K" || e.key === "k")) {
      e.preventDefault(); e.stopImmediatePropagation();
      diagnose(); return;
    }

    var el = activeEditable();
    if (!el) { shiftAlone = false; return; }          // 焦點不在輸入框：完全不管
    // ⌘ 組合鍵一律放行。按下 ⌘ 的當下先把組字送進輸入框：
    // 不然 claude.ai 按 ⌘Enter 送出時，浮動列上還沒送的字不會跟著送出去。
    if (e.metaKey || e.key === "Meta") {
      shiftAlone = false;
      if (composing) controller.reset();
      return;
    }

    if (intercepted(e)) {                              // 系統注音在吃鍵
      warnShown = true;
      preedit.textContent = "⚠️ 請把輸入來源切成 ABC（🌐 或 ⌃-空白）";
      showBar(true);
      return;
    }
    if (warnShown) {                                   // 已經切回 ABC，把警示收掉
      warnShown = false;
      preedit.textContent = composing;
    }

    shiftAlone = (e.key === "Shift" && !e.repeat);
    if (e.key === "Shift") return;

    if (!chinese) return;

    if (controller.keyEvent(e)) {
      e.preventDefault();
      e.stopImmediatePropagation();                    // 別讓網站的快捷鍵也吃到
    }
  }, true);

  document.addEventListener("keyup", function (e) {
    if (e.key === "Shift" && shiftAlone && activeEditable()) setChinese(!chinese);
    shiftAlone = false;
  }, true);

  document.addEventListener("focusin", refreshBar, true);
  document.addEventListener("focusout", function () { setTimeout(refreshBar, 0); }, true);

  /* ================= 診斷 ================= */

  function diagnose() {
    var el = activeEditable();
    if (!el) { toast("✗ 焦點不在輸入框\n先點一下輸入框再按 ⌃⇧K", false); return; }
    var desc = el.tagName.toLowerCase() + (el.type ? "[" + el.type + "]" : "") +
               (el.isContentEditable ? " contenteditable" : "");
    // 一旦成功就停：每個成功的方法都會真的插一個「測」進去，全跑會塞三個。
    var lines = [], won = null;
    for (var i = 0; i < METHODS.length && !won; i++) {
      var okr = false, err = "";
      try { okr = !!METHODS[i][1](el, "測"); } catch (e2) { err = "（" + e2.message + "）"; }
      if (okr) won = METHODS[i][0];
      lines.push((okr ? "✓ " : "✗ ") + METHODS[i][0] + err);
    }
    toast("目標：" + desc + "\n" + lines.join("\n") +
          (won ? "\n→ 這個框吃「" + won + "」" : "\n→ 三種都不行") +
          "\n（剛剛插進去的「測」請自己刪掉）", !!won);
  }

  /* ================= 起手 ================= */

  buildBar();
  refreshBar();
  logViewport("init");
  // @match 開到全站之後，每頁都要吃 5.2MB 引擎的解析成本。
  // 印出「從導覽開始到腳本跑完」的毫秒數，用量的決定要不要把 @match 收窄。
  console.log("[hsu] 許氏注音 v" + VERSION + " 已載入（" + Math.round(performance.now()) + "ms，模式：" +
    (chinese ? "中文" : "英文") + "）。Shift 切中／英，⌃⇧K 診斷，⇅ 翻上下。");
})();
