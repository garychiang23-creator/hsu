// ==UserScript==
// @name         L2 注入探針（許氏 IME 前置測試）
// @namespace    hsu_ime
// @version      1.0
// @description  只做一件事：按 ⌃⇧K，把「測試」兩個字塞進當下 focus 的輸入框，並回報哪一種塞法成功。
// @match        *://claude.ai/*
// @match        *://www.google.com/*
// @match        *://www.google.com.tw/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/* 這支不含任何注音引擎，只驗一件事：
 *   userscript 能不能把中文塞進「別人網站」的輸入框？
 * 塞得進去 → L2（Safari 裡到處都能打許氏）可行
 * 塞不進去 → 省掉整個 L2，L1 寫字台就是終點
 *
 * 用法：頁面點一下輸入框（游標要在裡面），按 ⌃⇧K，看畫面右下角的回報。
 */

(function () {
  "use strict";

  const SAMPLE = "測試";

  function toast(msg, ok) {
    let el = document.getElementById("__hsu_probe_toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "__hsu_probe_toast";
      el.style.cssText = [
        "position:fixed", "right:16px", "bottom:16px", "z-index:2147483647",
        "max-width:70vw", "padding:12px 16px", "border-radius:10px",
        "font:14px/1.5 -apple-system,'PingFang TC',sans-serif",
        "color:#fff", "box-shadow:0 6px 24px rgba(0,0,0,.35)",
        "white-space:pre-wrap", "pointer-events:none",
      ].join(";");
      document.body.appendChild(el);
    }
    el.style.background = ok ? "#1f7a3d" : "#8c2020";
    el.textContent = msg;
    clearTimeout(el.__t);
    el.__t = setTimeout(() => { el.remove(); }, 6000);
  }

  function describe(el) {
    if (!el) return "(沒有 focus 的元素)";
    const tag = el.tagName ? el.tagName.toLowerCase() : "?";
    const ce = el.isContentEditable ? " contenteditable" : "";
    const type = el.type ? "[" + el.type + "]" : "";
    const role = el.getAttribute && el.getAttribute("role") ? " role=" + el.getAttribute("role") : "";
    return tag + type + ce + role;
  }

  // 法一：execCommand insertText —— 會觸發真正的 input 事件，React 通常吃得下
  function tryExecCommand(el) {
    if (!document.execCommand) return false;
    const before = readValue(el);
    const r = document.execCommand("insertText", false, SAMPLE);
    return r && readValue(el) !== before;
  }

  // 法二：input/textarea 走 native setter + 手動派 input 事件
  function tryNativeSetter(el) {
    const isField = el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA");
    if (!isField) return false;
    const proto = el.tagName === "INPUT" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value");
    if (!setter || !setter.set) return false;
    const s = el.selectionStart == null ? el.value.length : el.selectionStart;
    const e = el.selectionEnd == null ? el.value.length : el.selectionEnd;
    const before = el.value;
    setter.set.call(el, before.slice(0, s) + SAMPLE + before.slice(e));
    el.setSelectionRange(s + SAMPLE.length, s + SAMPLE.length);
    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: SAMPLE, inputType: "insertText" }));
    return el.value !== before;
  }

  // 法三：contenteditable 直接動 Range
  function tryRange(el) {
    if (!el || !el.isContentEditable) return false;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return false;
    const before = el.textContent;
    const range = sel.getRangeAt(0);
    range.deleteContents();
    const node = document.createTextNode(SAMPLE);
    range.insertNode(node);
    range.setStartAfter(node); range.setEndAfter(node);
    sel.removeAllRanges(); sel.addRange(range);
    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: SAMPLE, inputType: "insertText" }));
    return el.textContent !== before;
  }

  function readValue(el) {
    if (!el) return "";
    return el.value != null ? el.value : el.textContent;
  }

  function run() {
    let el = document.activeElement;
    // 有些站把真正的編輯區藏在 shadow DOM 裡
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;

    const where = describe(el);
    if (!el || el === document.body) {
      toast("✗ 沒有 focus 的輸入框\n先點一下輸入框，再按 ⌃⇧K", false);
      return;
    }

    const tried = [];
    const methods = [
      ["execCommand insertText", tryExecCommand],
      ["native setter + input 事件", tryNativeSetter],
      ["Range 插入", tryRange],
    ];
    for (const [name, fn] of methods) {
      let okr = false;
      try { okr = !!fn(el); } catch (err) { tried.push(name + "（爆炸：" + err.message + "）"); continue; }
      if (okr) {
        toast("✓ 塞進去了\n目標：" + where + "\n方法：" + name, true);
        console.log("[hsu probe] OK", name, el);
        return;
      }
      tried.push(name);
    }
    toast("✗ 三種方法都失敗\n目標：" + where + "\n試過：" + tried.join("、"), false);
    console.log("[hsu probe] FAILED on", el);
  }

  document.addEventListener("keydown", function (e) {
    if (e.ctrlKey && e.shiftKey && (e.key === "K" || e.key === "k")) {
      e.preventDefault();
      run();
    }
  }, true);

  console.log("[hsu probe] 已載入。點一下輸入框，按 ⌃⇧K。");
})();
