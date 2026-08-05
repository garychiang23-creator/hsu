// ==UserScript==
// @name         許氏注音（Safari 就地輸入）
// @namespace    hsu_ime
// @version      1.4
// @description  在 Safari 的任何輸入框裡用許氏注音打中文。引擎＝小麥注音網頁版（MIT）。
// @author       Gary + Claude
// @match        *://*/*
// @noframes
// @require      https://garychiang23-creator.github.io/hsu/vendor/mcbopomofo.bundle.js
// @require      https://garychiang23-creator.github.io/hsu/hsu.core.js
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/* 這支只是殼。所有邏輯都在 @require 進來的 hsu.core.js。
 * 拆開的理由：核心放在 Pages 上，改版部署完只要重新整理，
 * 不必再把檔案搬回 iPad。這裡只留一個健康檢查。 */
(function () {
  "use strict";
  if (!window.__hsu_ime_loaded) {
    console.warn("[hsu] 核心沒載入。檢查 @require 的 hsu.core.js 是否可存取。");
  }
})();
