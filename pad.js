/* 許氏寫字台／便條 共用核心（index.html、clip.html 都載這支）
 *
 * 頁面只管自己的按鈕；組字、候選列、中英切換、個人詞庫、草稿、視窗高度都在這裡，
 * 修一次兩頁都生效。hsu.user.js 不能共用這支——userscript 只能是單檔（見 CLAUDE.md）。
 *
 * ⚠ 這支在 sw.js 的 SHELL 裡（cache-first）。改了就要把 CACHE +1，push_deploy 會擋。
 */
(function () {
  "use strict";

  /* ================= 個人詞庫（兩頁同源，共用同一份） ================= */

  var PHRASES_KEY = "hsu_user_phrases_v1";
  var EXCLUDED_KEY = "hsu_excluded_phrases_v1";

  // 2026-08-06 實測過的詞（掛上前 3/7 句全對 → 掛上後 7/7，對照組沒被誤傷）。
  // 只在還沒有詞庫時種下；刪掉之後不會再長回來。
  // hsu.user.js 有同一份，smoke test 守著兩邊一致。
  var SEED = [
    ["ㄒㄧㄣ-ㄏㄨㄚˊ", ["昕樺"]],
    ["ㄧ-ㄏㄜˊ", ["一盒"]],
    ["ㄨㄛˇ-ㄌㄞˊ-ㄉㄧㄥˋ", ["我來訂"]],
    ["ㄐㄧㄥ-ㄏㄨㄥˊ", ["晶宏"]],
    ["ㄓㄜˋ-ㄉㄤˇ", ["這檔"]]
  ];

  // 讀音鍵必須是連字號串起的注音（ㄒㄧㄣ-ㄏㄨㄚˊ）。無連字號的寫法掛上去會靜默無效。
  var READING = /^[ㄅ-ㄩˉˊˇˋ˙]+(-[ㄅ-ㄩˉˊˇˋ˙]+)*$/;

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

  function keySet(m) {
    var s = new Set();
    m.forEach(function (ws, r) { ws.forEach(function (w) { s.add(r + "\t" + w); }); });
    return s;
  }

  // 匯出格式＝小麥 data.txt 的「詞 讀音」，一行一個
  function formatPhrases(m) {
    var lines = [];
    m.forEach(function (ws, r) { ws.forEach(function (w) { lines.push(w + " " + r); }); });
    return lines.join("\n");
  }

  // 每行「詞」或「詞 讀音」。只給詞時用 readingOf(詞) 查預設讀音。
  // 字數和音節數對不上的行一律退回（多半是破音字查錯或混了英文）。
  function parsePhrases(text, readingOf) {
    var ok = [], bad = [];
    String(text).split(/\r?\n/).forEach(function (line) {
      line = line.trim();
      if (!line || line.charAt(0) === "#") return;
      var parts = line.split(/\s+/), word, reading;
      if (parts.length >= 2 && READING.test(parts[parts.length - 1])) {
        reading = parts.pop(); word = parts.join("");
      } else if (parts.length === 1) {
        word = parts[0]; reading = readingOf ? readingOf(word) : "";
      } else { bad.push(line); return; }
      if (!reading || !READING.test(reading) ||
          reading.split("-").length !== Array.from(word).length) { bad.push(line); return; }
      ok.push([reading, word]);
    });
    return { ok: ok, bad: bad };
  }

  /* ================= 剪貼簿 ================= */

  // 必須在使用者手勢裡同步呼叫（keydown／click 處理器內），Safari 才准寫。
  function copy(text, onOk, onFail, ta) {
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(onOk, onFail || function () {});
      return;
    }
    // 舊路徑會搶走 focus，寫完還回去
    var tmp = document.createElement("textarea");
    tmp.value = text; tmp.style.position = "fixed"; tmp.style.opacity = "0";
    document.body.appendChild(tmp); tmp.select();
    var done = false;
    try { done = document.execCommand("copy"); } catch (e) {}
    document.body.removeChild(tmp);
    if (ta) ta.focus();
    (done ? onOk : (onFail || function () {}))();
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  /* ================= 掛到頁面上 ================= */
  /* opts.draftKey  草稿存哪（兩頁要不同）
   * opts.onChange(kind)  內容變了就同步呼叫；kind = "commit"（中文送出）或 "input"（英文／刪字／貼上）。
   *   便條的自動複製掛在這裡——它是從 keydown／input 同步進來的，還在使用者手勢裡。 */
  function mount(opts) {
    opts = opts || {};
    var $ = function (id) { return document.getElementById(id); };
    var ta = $("ta"), cand = $("cand"), warn = $("warn"), modeBtn = $("mode"), countEl = $("count");
    var onChange = opts.onChange || function () {};
    var controller = null;

    /* ---------- 組字區：組字中的字直接畫在 textarea 裡，範圍由我方掌握 ---------- */
    var composing = "";      // 目前畫在 textarea 裡的未定字串
    var compStart = null;    // 組字段落的起點；null = 沒有組字中

    // 開始組字／直接送出時的落點。有反白就先刪掉反白（跟一般輸入法一樣取代它）。
    function anchor() {
      if (ta.selectionEnd > ta.selectionStart) ta.setRangeText("", ta.selectionStart, ta.selectionEnd, "start");
      return ta.selectionStart;
    }

    function setComposing(text) {
      if (compStart === null) {
        if (text === "") return;
        compStart = anchor();
      }
      ta.setRangeText(text, compStart, compStart + composing.length, "end");
      composing = text;
      if (text === "") compStart = null;
      scheduleSave();
    }

    function commit(text) {
      if (compStart === null) compStart = anchor();
      ta.setRangeText(text, compStart, compStart + composing.length, "end");
      composing = ""; compStart = null;
      scheduleSave(); updateCount();
      onChange("commit");
    }

    function clearComposing() {
      if (compStart !== null) ta.setRangeText("", compStart, compStart + composing.length, "end");
      composing = ""; compStart = null;
    }

    // 引擎游標／標記範圍 → textarea 原生選取。
    // 標記（Shift+←→）時反白被選的字段；平常把插入點放在引擎游標上，
    // 方向鍵移進組字區選字時看得到自己在哪。
    function paintCursor(segs, cursorIndex) {
      if (compStart === null) return;
      var off = 0, a = -1, b = -1;
      segs.forEach(function (s) {
        var n = (s.text || "").length;
        if (s.style === "highlighted") { if (a < 0) a = off; b = off + n; }
        off += n;
      });
      if (a < 0) a = b = Math.max(0, Math.min(cursorIndex | 0, composing.length));
      try { ta.setSelectionRange(compStart + a, compStart + b); } catch (e) {}
    }

    function plainText() {
      if (compStart === null) return ta.value;
      return ta.value.slice(0, compStart) + ta.value.slice(compStart + composing.length);
    }

    /* ---------- 候選列（兼顯示引擎提示與我方通知） ---------- */
    var lastState = null, noticeMsg = "", noticeTimer = null;

    function renderCandidates() {
      var st = lastState || {}, list = st.candidates || [];
      var tip = st.tooltip || noticeMsg, html = "";
      if (tip) html += '<span class="tip' + (tip === noticeMsg ? " ok" : "") + '">' + esc(tip) + "</span>";
      html += list.map(function (w) {
        var c = w.candidate || {};
        var text = c.displayedText || c.value || "";
        return '<span class="cand' + (w.selected ? " sel" : "") + '" data-k="' +
               esc(w.keyCap) + '"><i>' + esc(w.keyCap) + "</i>" + esc(text) + "</span>";
      }).join("");
      // candidatePageIndex 本身就從 1 起算（實測：第一頁是 1 / 27）
      if (st.candidatePageCount > 1) {
        html += '<span class="page">' + (st.candidatePageIndex | 0) + " / " + st.candidatePageCount + "</span>";
      }
      cand.innerHTML = html;
      cand.className = html ? "show" : "";
    }

    function notice(msg) {
      noticeMsg = msg;
      renderCandidates();
      if (noticeTimer) clearTimeout(noticeTimer);
      noticeTimer = setTimeout(function () { noticeMsg = ""; renderCandidates(); }, 2500);
    }

    // 點候選字：不搶走 textarea 的 focus
    cand.addEventListener("pointerdown", function (e) { e.preventDefault(); });
    cand.addEventListener("click", function (e) {
      var el = e.target.closest ? e.target.closest(".cand") : null;
      if (!el || !controller) return;
      try { controller.simpleKeyboardEvent(el.getAttribute("data-k"), false, false); }
      catch (err) { console.warn("candidate tap failed", err); }
    });

    /* ---------- 引擎 ---------- */
    var ui = {
      reset: function () { clearComposing(); lastState = null; renderCandidates(); },
      commitString: function (text) { if (text) commit(text); },
      update: function (json) {
        var st;
        try { st = JSON.parse(json); } catch (e) { return; }
        var segs = st.composingBuffer || [];
        setComposing(segs.map(function (s) { return s.text || ""; }).join(""));
        paintCursor(segs, st.cursorIndex);
        lastState = st;
        renderCandidates();
        updateCount();
      }
    };

    /* ---------- 詞庫接線 ---------- */
    var userPhrases = loadMap(PHRASES_KEY, SEED), excluded = loadMap(EXCLUDED_KEY);
    var known = keySet(userPhrases);

    function applyLexicon() {
      controller.setUserPhrases(userPhrases);
      controller.setExcludedPhrases(excluded);
    }

    // 引擎拿到的是同一個 Map 的參照，加詞時直接改它；要比對新增了什麼只能靠快照 known
    function onPhraseChange(m) {
      userPhrases = m;
      var now = keySet(m), added = [];
      now.forEach(function (k) { if (!known.has(k)) added.push(k.split("\t")[1]); });
      known = now;
      saveMap(PHRASES_KEY, m);
      if (added.length) notice("✓ 已加入詞庫：" + added.join("、"));
    }

    function onExcludedChange(m) {
      excluded = m;
      saveMap(EXCLUDED_KEY, m);
      notice("✓ 已排除，之後不會再自動選它");
    }

    // 寫字台和便條同時開著時，一邊加的詞另一邊馬上吃得到
    window.addEventListener("storage", function (e) {
      if (!controller) return;
      if (e.key === PHRASES_KEY) {
        userPhrases = loadMap(PHRASES_KEY, SEED); known = keySet(userPhrases);
        controller.setUserPhrases(userPhrases);
      } else if (e.key === EXCLUDED_KEY) {
        excluded = loadMap(EXCLUDED_KEY);
        controller.setExcludedPhrases(excluded);
      }
    });

    /* ---------- 中／英模式 ---------- */
    var alphabetMode = false;
    function setMode(en) {
      alphabetMode = en;
      modeBtn.textContent = en ? "英文" : "中文";
      modeBtn.className = en ? "en" : "";
      if (controller) controller.reset();     // reset 會先把組字中的字送出，不會丟字
      clearComposing();
      lastState = null; renderCandidates();
      ta.focus();
    }
    modeBtn.addEventListener("click", function () { setMode(!alphabetMode); });

    /* ---------- 系統輸入法攔截偵測 ---------- */
    var warned = false;
    function showWarn() { if (!warned) { warned = true; warn.className = "show"; } }
    function hideWarn() { if (warned) { warned = false; warn.className = ""; } }
    function intercepted(e) {
      return e.isComposing === true || e.keyCode === 229 || e.key === "Process";
    }
    ta.addEventListener("compositionstart", showWarn);

    /* ---------- 按鍵 ---------- */
    var shiftAlone = false;

    ta.addEventListener("keydown", function (e) {
      if (intercepted(e)) { showWarn(); return; }        // 系統注音在吃鍵，別搶
      // ⌘ 組合鍵一律放行（⌘C/⌘V/⌘A/⌘⇥）。按下 ⌘ 的當下先把組字送出：
      // 這樣 ⌘V 不會貼進組字區中間，便條按 ⌘⇥ 切走前剪貼簿也已經是完整的字。
      if (e.metaKey || e.key === "Meta") {
        shiftAlone = false;
        if (compStart !== null && controller) controller.reset();
        return;
      }

      shiftAlone = (e.key === "Shift" && !e.repeat);
      if (e.key === "Shift") return;

      if (e.key && e.key.length === 1) hideWarn();       // 收得到乾淨字元 = 來源正確

      if (alphabetMode || !controller) return;
      if (controller.keyEvent(e)) e.preventDefault();
    });

    ta.addEventListener("keyup", function (e) {
      if (e.key === "Shift" && shiftAlone) setMode(!alphabetMode);
      shiftAlone = false;
    });

    // 用手指／滑鼠移動游標時，先把組字送出在原位
    ta.addEventListener("pointerdown", function () {
      if (compStart !== null && controller) controller.reset();
    });

    /* ---------- 草稿 ---------- */
    var draftKey = opts.draftKey, saveTimer = null;
    function scheduleSave() {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(function () {
        try { localStorage.setItem(draftKey, plainText()); } catch (e) {}
      }, 400);
    }
    function restore() {
      try {
        var v = localStorage.getItem(draftKey);
        if (v) { ta.value = v; ta.setSelectionRange(v.length, v.length); }
      } catch (e) {}
      updateCount();
    }
    // input 涵蓋英文模式打字、標點、退格、⌘V 貼上。
    // 中文組字走 setRangeText，程式性修改不會觸發 input，所以不會重複。
    ta.addEventListener("input", function () { scheduleSave(); updateCount(); onChange("input"); });

    function charCount(t) { return t.replace(/\s/g, "").length; }
    function updateCount() { countEl.textContent = charCount(plainText()) + " 字"; }

    function clearAll() {
      if (controller) controller.reset();
      composing = ""; compStart = null;
      ta.value = ""; scheduleSave(); updateCount(); ta.focus();
    }

    /* ---------- 詞庫管理 ---------- */
    var dlg = null, svc = null;

    function readingOf(word) {
      try {
        if (!svc) svc = new window.mcbopomofo.Service();
        return svc.convertTextToBpmfReadingsWithSpaces(word).trim().split(/\s+/).join("-");
      } catch (e) { return ""; }
    }

    function buildLexicon() {
      dlg = document.createElement("dialog");
      dlg.id = "lex";
      dlg.innerHTML =
        '<div class="lex-head"><b>個人詞庫</b><span id="lex-n"></span>' +
        '<button type="button" id="lex-done">完成</button></div>' +
        '<p class="lex-how">加詞：打字時按 <b>Shift+←</b> 選取字段，再按 <b>Enter</b>。' +
        '候選列上按 <b>+</b> 加入、<b>-</b> 排除。</p>' +
        '<ul id="lex-list"></ul>' +
        '<textarea id="lex-text" rows="4" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" ' +
        'placeholder="一行一個詞，可加讀音：&#10;晶宏&#10;晶宏 ㄐㄧㄥ-ㄏㄨㄥˊ"></textarea>' +
        '<div class="lex-row"><button type="button" id="lex-add">加入這些詞</button>' +
        '<button type="button" id="lex-export">匯出全部</button><span id="lex-msg"></span></div>';
      document.body.appendChild(dlg);

      $("lex-done").addEventListener("click", function () { dlg.close(); });
      dlg.addEventListener("close", function () { ta.focus(); });

      $("lex-list").addEventListener("click", function (e) {
        var btn = e.target.closest ? e.target.closest("button[data-k]") : null;
        if (!btn) return;
        var kv = btn.getAttribute("data-k").split("\t"), r = kv[0], w = kv[1];
        var m = btn.getAttribute("data-x") ? excluded : userPhrases;
        var ws = (m.get(r) || []).filter(function (x) { return x !== w; });
        if (ws.length) m.set(r, ws); else m.delete(r);
        if (m === excluded) saveMap(EXCLUDED_KEY, m);
        else { saveMap(PHRASES_KEY, m); known = keySet(m); }
        applyLexicon();
        renderLexicon();
      });

      $("lex-add").addEventListener("click", function () {
        var res = parsePhrases($("lex-text").value, readingOf), n = 0;
        res.ok.forEach(function (p) {
          var ws = userPhrases.get(p[0]) || [];
          if (ws.indexOf(p[1]) < 0) { ws.push(p[1]); userPhrases.set(p[0], ws); n++; }
        });
        saveMap(PHRASES_KEY, userPhrases); known = keySet(userPhrases);
        applyLexicon();
        $("lex-text").value = res.bad.join("\n");
        $("lex-msg").textContent = "加入 " + n + " 個" + (res.bad.length ? "，" + res.bad.length + " 行看不懂（留在框裡）" : "");
        renderLexicon();
      });

      $("lex-export").addEventListener("click", function () {
        var t = formatPhrases(userPhrases);
        $("lex-text").value = t;
        copy(t, function () { $("lex-msg").textContent = "已複製到剪貼簿"; },
                function () { $("lex-msg").textContent = "已放進框裡，請自己複製"; });
      });
    }

    function renderLexicon() {
      var items = [];
      userPhrases.forEach(function (ws, r) {
        ws.forEach(function (w) {
          items.push('<li><span class="w">' + esc(w) + '</span><span class="r">' + esc(r.replace(/-/g, " ")) +
            '</span><button type="button" data-k="' + esc(r + "\t" + w) + '">刪除</button></li>');
        });
      });
      excluded.forEach(function (ws, r) {
        ws.forEach(function (w) {
          items.push('<li class="x"><span class="w">' + esc(w) + '</span><span class="r">已排除</span>' +
            '<button type="button" data-x="1" data-k="' + esc(r + "\t" + w) + '">恢復</button></li>');
        });
      });
      $("lex-list").innerHTML = items.length ? items.join("") : '<li class="empty">還沒有自訂詞</li>';
      $("lex-n").textContent = keySet(userPhrases).size + " 個詞" +
        (excluded.size ? "・排除 " + keySet(excluded).size : "");
    }

    function openLexicon() {
      if (controller) controller.reset();
      if (!dlg) buildLexicon();
      // 先在文中反白一個詞再開詞庫，那個詞就先填好
      var sel = ta.value.slice(ta.selectionStart, ta.selectionEnd).trim();
      if (sel && sel.length <= 10 && !/\s/.test(sel)) $("lex-text").value = sel;
      $("lex-msg").textContent = "";
      renderLexicon();
      if (dlg.showModal) dlg.showModal(); else dlg.setAttribute("open", "");
    }

    /* ---------- 視覺視窗高度（避開 iPad 底部快捷列，見 CLAUDE.md） ---------- */
    function fit() {
      var h = (window.visualViewport && window.visualViewport.height) || window.innerHeight;
      $("app").style.height = h + "px";
    }
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", fit);
      window.visualViewport.addEventListener("scroll", fit);
    }
    window.addEventListener("resize", fit);
    fit();

    // 點空白處回到輸入框
    document.addEventListener("click", function (e) {
      if (e.target === document.body || e.target.id === "app") ta.focus();
    });

    /* ---------- 開機 ---------- */
    var api = {
      plainText: plainText, clearAll: clearAll, charCount: charCount,
      openLexicon: openLexicon, notice: notice,
      focus: function () { ta.focus(); },
      copy: function (t, onOk, onFail) { copy(t, onOk, onFail, ta); }
    };

    if (!window.mcbopomofo) {
      $("boot").textContent = "注音引擎載入失敗，請重新整理。";
      return api;
    }
    controller = new window.mcbopomofo.InputController(ui);
    controller.setKeyboardLayout("Hsu");      // ← 許氏
    controller.setLanguageCode("zh-TW");
    controller.setUserVerticalCandidates(false);
    if (controller.setOnError) controller.setOnError(function () {});
    controller.setOnPhraseChange(onPhraseChange);
    controller.setOnExcludedPhraseChange(onExcludedChange);
    applyLexicon();
    $("boot").className = "gone";
    restore();
    ta.focus();
    return api;
  }

  window.HsuPad = {
    mount: mount,
    SEED: SEED, PHRASES_KEY: PHRASES_KEY, EXCLUDED_KEY: EXCLUDED_KEY,
    parsePhrases: parsePhrases, formatPhrases: formatPhrases
  };
})();
