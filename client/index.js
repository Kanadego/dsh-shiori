/**
 * dsh-shiori — 浏览器半体（手写 ModuleLoader bundle，无构建步骤）。
 *
 * 结构与 dsh 生态真实 client bundle 一致：
 *   window.__ModuleLoader__.load({ id, factory(require) })，
 *   factory 内 require 注入依赖（react / zod），导出 { apply, inject }；
 *   apply(ctx) 先 await ctx.remote.$mount(TYPERT_REMOTE)（真实 Typert
 *   contribution），收集 disposer，再注册 plugins.bundle.config 槽位面板；
 *   卸载时逆序释放。
 *
 * wire（CONTRACTS §6 冻结）：namespace `shiori`，各方法 (sessionId, payload)。
 * 服务端为唯一权威；本 bundle 不携带业务状态，结果按 RemoteResult 渲染，
 * 失败显示 error.code，绝不把失败伪装成成功。全程 textContent 渲染
 * （React 文本子节点），不使用 innerHTML / dangerouslySetInnerHTML，
 * 不引用任何外部 CDN。
 *
 * vendored：createTypertRemoteInfo 按生态惯例从
 * @deepseek-ai/dsh-typert-protocol（DeepSEEK，Apache-2.0 同源发布）内联，
 * 与官方生成 client 逐字一致（生成物同样内联此段）；浏览器侧无法 import
 * 宿主服务端模块，此为第三方 client 的标准做法。
 */
window.__ModuleLoader__.load({
  id: "dsh-shiori",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var react = require("react");
    var h = react.createElement;
    var fragment = react.Fragment;
    var zod = require("zod");

    // ── CSS（与随包 client/shiori.css 保持一致；运行时使用本内嵌副本） ──────
    // U1 设计 token：全部挂在 .dshi_root 作用域上（--dshi-*），页面样式只允许
    // 引用 token、不写裸色值。语义色用于水位：safe=安全绿 / warn=警告黄 / danger=危险红；
    // l0/l1/l2/l3-soft 为四层标识淡色；bg-panel 与 bg-card 是两档灰底（面板底/卡片底）；
    // 圆角 / 间距 / 描边 / 字号各档一并收敛。token 本体回退到宿主 --dsw-alias 变量。
    var CSS = ".dshi_root{--dshi-accent:#e5484d;--dshi-safe:var(--dsw-alias-state-success-primary,#1a7f37);--dshi-warn:#b45309;--dshi-danger:var(--dsw-alias-state-error-primary,#f85149);--dshi-accent-a:#e5484d;--dshi-accent-b:#f5b83d;--dshi-gold-ink:#c98a1b;--dshi-l0:#e5484d;--dshi-l1:#d99a1f;--dshi-l2:#2f9e6b;--dshi-l3:#8b5cf6;--dshi-l0-soft:rgba(229,72,77,.16);--dshi-l1-soft:rgba(217,154,31,.18);--dshi-l2-soft:rgba(47,158,107,.16);--dshi-l3-soft:rgba(139,92,246,.16);--dshi-bg-panel:var(--dsw-alias-bg-layer-2,transparent);--dshi-bg-card:var(--dsw-alias-bg-layer-3,#fff);--dshi-text:var(--dsw-alias-label-primary);--dshi-text-dim:var(--dsw-alias-label-tertiary,#8b93a1);--dshi-stroke:1px solid var(--dsw-alias-border-l2,#dce2eb);--dshi-radius:10px;--dshi-radius-sm:8px;--dshi-radius-pill:999px;--dshi-space:12px;--dshi-space-sm:8px;--dshi-space-xs:4px;--dshi-font:13px;--dshi-font-sm:12px;--dshi-font-xs:11px;--dshi-font-title:14px}" +
    ".dshi_root{max-width:860px;display:flex;flex-direction:column;gap:12px;font-size:13px;line-height:1.65;color:var(--dsw-alias-label-primary)}" +
".dshi_root *{box-sizing:border-box;min-width:0}" +
".dshi_title{display:flex;align-items:center;gap:8px;font-size:14px;font-weight:600}" +
".dshi_titleSub{font-size:11px;font-weight:400;color:var(--dsw-alias-label-tertiary)}" +
    // 版式：hero 头（渐变底 + 光斑）、品牌方块、卡片标题前的主题色竖条、渐变主按钮与进度条。
".dshi_hero{position:relative;overflow:hidden;display:flex;align-items:center;gap:var(--dshi-space);border:var(--dshi-stroke);border-radius:14px;padding:12px 14px;background:linear-gradient(120deg,rgba(229,72,77,.16),rgba(245,184,61,.13) 46%,transparent 82%)}" +
".dshi_hero::after{content:\"\";position:absolute;right:-40px;top:-70px;width:200px;height:200px;border-radius:50%;background:radial-gradient(circle,rgba(245,184,61,.30),transparent 68%);filter:blur(6px);pointer-events:none}" +
".dshi_logo{flex:none;width:36px;height:36px;border-radius:12px;display:grid;place-items:center;font-size:16px;font-weight:700;color:#fff;background:linear-gradient(135deg,var(--dshi-accent-a),var(--dshi-accent-b));box-shadow:0 6px 16px rgba(229,72,77,.34)}" +
".dshi_heroText{display:flex;flex-direction:column;gap:2px;min-width:0}" +
".dshi_tabs{display:flex;gap:4px;flex-wrap:wrap;border-bottom:1px solid var(--dsw-alias-border-l2,#dce2eb);padding-bottom:6px}" +
".dshi_tab{border:1px solid transparent;background:none;color:var(--dsw-alias-label-secondary);border-radius:8px;padding:4px 12px;font:inherit;font-size:12px;cursor:pointer}" +
".dshi_tab:hover:not(:disabled){color:var(--dsw-alias-label-primary)}" +
".dshi_tabOn{border-color:transparent;background:linear-gradient(135deg,var(--dshi-accent-a),var(--dshi-accent-b));color:#fff;font-weight:600;box-shadow:0 4px 14px rgba(229,72,77,.30)}" +
".dshi_card{border:1px solid var(--dsw-alias-border-l2,#dce2eb);background:var(--dsw-alias-bg-layer-3,#fff);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:8px}" +
".dshi_cardTitle{font-size:12px;font-weight:600;display:flex;align-items:center;gap:8px;flex-wrap:wrap}" +
".dshi_cardTitle::before{content:\"\";flex:none;width:3px;height:14px;border-radius:2px;background:linear-gradient(180deg,var(--dshi-accent-a),var(--dshi-accent-b))}" +
".dshi_hint{font-size:11px;color:var(--dsw-alias-label-tertiary)}" +
".dshi_row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}" +
".dshi_kv{display:grid;grid-template-columns:auto 1fr;gap:2px 12px;font-size:12px}" +
".dshi_kv dt{color:var(--dsw-alias-label-tertiary);white-space:nowrap}" +
".dshi_kv dd{margin:0;font-family:ui-monospace,Consolas,monospace;word-break:break-all}" +
".dshi_badge{border:1px solid var(--dshi-gold-ink,#c98a1b);color:var(--dshi-gold-ink,#c98a1b);border-radius:999px;padding:0 8px;font-size:10px;white-space:nowrap}" +
".dshi_badgeWarn{border-color:var(--dsw-alias-state-error-primary,#f85149);color:var(--dsw-alias-state-error-primary,#f85149)}" +
".dshi_badgeDim{border-color:var(--dsw-alias-border-l2,#dce2eb);color:var(--dsw-alias-label-tertiary)}" +
".dshi_btn{border:1px solid var(--dsw-alias-border-l2,#dce2eb);background:var(--dsw-alias-bg-layer-3,#fff);color:var(--dsw-alias-label-primary);border-radius:8px;padding:5px 12px;font:inherit;font-size:12px;cursor:pointer}" +
".dshi_btn:hover:not(:disabled){border-color:var(--dshi-accent-a,#e5484d)}" +
".dshi_btn:disabled{opacity:.5;cursor:default}" +
".dshi_btnPrimary{border-color:transparent;background:linear-gradient(135deg,var(--dshi-accent-a),var(--dshi-accent-b));color:#fff;font-weight:600;box-shadow:0 4px 14px rgba(229,72,77,.28)}" +
".dshi_btnDanger{border-color:var(--dsw-alias-state-error-primary,#f85149);color:var(--dsw-alias-state-error-primary,#f85149)}" +
".dshi_input,.dshi_select,.dshi_textarea{border:1px solid var(--dsw-alias-border-l2,#dce2eb);background:var(--dsw-alias-bg-layer-3,#fff);font:inherit;font-size:12px;color:var(--dsw-alias-label-primary);border-radius:8px;padding:5px 8px}" +
".dshi_textarea{width:100%;min-height:120px;resize:vertical;font-family:ui-monospace,Consolas,monospace;font-size:12px;line-height:1.6;white-space:pre;overflow-wrap:normal;overflow-x:auto}" +
".dshi_label{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary);display:flex;flex-direction:column;gap:3px}" +
".dshi_error{font-size:12px;color:var(--dsw-alias-state-error-primary,#f85149);border:1px solid var(--dsw-alias-state-error-primary,#f85149);border-radius:8px;padding:6px 10px;word-break:break-all}" +
".dshi_ok{font-size:12px;color:var(--dsw-alias-state-success-primary,#1a7f37);border:1px solid var(--dsw-alias-state-success-primary,#1a7f37);border-radius:8px;padding:6px 10px;word-break:break-all}" +
".dshi_loading{font-size:12px;color:var(--dsw-alias-label-tertiary)}" +
".dshi_pre{margin:0;font-family:ui-monospace,Consolas,monospace;font-size:11px;line-height:1.6;white-space:pre-wrap;word-break:break-word;max-height:320px;overflow:auto;border:1px solid var(--dsw-alias-border-l2,#dce2eb);border-radius:8px;padding:8px 10px;background:var(--dsw-alias-bg-layer-2,transparent)}" +
".dshi_bar{height:8px;border-radius:4px;border:1px solid var(--dsw-alias-border-l2,#dce2eb);overflow:hidden;background:var(--dsw-alias-bg-layer-2,transparent)}" +
".dshi_barFill{height:100%;background:linear-gradient(90deg,var(--dshi-accent-a),var(--dshi-accent-b))}" +
".dshi_barFillSafe{background:var(--dshi-safe)}" +
".dshi_barFillWarn{background:var(--dshi-warn)}" +
".dshi_barFillDanger{background:var(--dshi-danger)}" +
".dshi_graphWrap{border:1px solid var(--dsw-alias-border-l2,#dce2eb);border-radius:10px;overflow:hidden;position:relative;user-select:none;cursor:grab;background:var(--dsw-alias-bg-layer-2,transparent)}" +
".dshi_graphSvg{display:block;width:100%;height:380px;touch-action:none}" +
".dshi_graphNode{cursor:pointer}" +
".dshi_nodeEvergreen{fill:var(--dsw-alias-state-success-primary,#1a7f37)}" +
".dshi_nodeEphemeral{fill:var(--dsw-alias-state-business-primary,#3964fe)}" +
".dshi_nodeDim{fill:var(--dsw-alias-label-tertiary,#8b93a1)}" +
".dshi_nodeSel{stroke:var(--dsw-alias-state-error-primary,#f85149);stroke-width:2}" +
".dshi_nodeLabel{font-size:10px;fill:var(--dsw-alias-label-primary);pointer-events:none}" +
".dshi_edge{stroke:var(--dsw-alias-border-l2,#9aa4b2);stroke-width:1;fill:none}" +
".dshi_legend{display:flex;gap:12px;align-items:center;font-size:11px;color:var(--dsw-alias-label-tertiary);flex-wrap:wrap}" +
".dshi_dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:4px;vertical-align:-1px}" +
".dshi_items{display:flex;flex-direction:column;gap:6px}" +
".dshi_item{border:1px solid var(--dsw-alias-border-l2,#dce2eb);border-radius:8px;padding:6px 10px;display:flex;flex-direction:column;gap:4px;font-size:12px}" +
".dshi_itemHead{display:flex;align-items:center;gap:8px;flex-wrap:wrap}" +
".dshi_mono{font-family:ui-monospace,Consolas,monospace;font-size:11px;word-break:break-all}" +
".dshi_confirm{border:1px solid var(--dsw-alias-state-error-primary,#f85149);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:8px}" +
".dshi_grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px}" +
    // U2 预算页（标杆页）：以下样式只引用 --dshi-* token，不写裸色值。
".dshi_bgroup{border:var(--dshi-stroke);background:var(--dshi-bg-card);background-image:linear-gradient(180deg,rgba(229,72,77,.07),transparent 42%);border-radius:14px;padding:var(--dshi-space);display:flex;flex-direction:column;gap:var(--dshi-space-sm);box-shadow:0 2px 10px rgba(15,23,42,.05)}" +
".dshi_layerChip{border-radius:var(--dshi-radius-pill);padding:0 8px;font-size:var(--dshi-font-xs);font-weight:600;white-space:nowrap;border:1px solid transparent}" +
".dshi_layerL0{background:var(--dshi-l0-soft);color:var(--dshi-l0);border-color:var(--dshi-l0)}" +
".dshi_layerL1{background:var(--dshi-l1-soft);color:var(--dshi-l1);border-color:var(--dshi-l1)}" +
".dshi_layerL2{background:var(--dshi-l2-soft);color:var(--dshi-l2);border-color:var(--dshi-l2)}" +
".dshi_layerL3{background:var(--dshi-l3-soft);color:var(--dshi-l3);border-color:var(--dshi-l3)}" +
".dshi_bintro{font-size:var(--dshi-font-xs);color:var(--dshi-text-dim)}" +
".dshi_preview{border:var(--dshi-stroke);background:var(--dshi-bg-panel);border-radius:var(--dshi-radius);padding:var(--dshi-space);display:flex;flex-direction:column;gap:var(--dshi-space-sm)}" +
".dshi_track{position:relative;height:14px;border-radius:var(--dshi-radius-sm);border:var(--dshi-stroke);background:var(--dshi-bg-card);overflow:hidden}" +
".dshi_trackFill{position:absolute;top:0;left:0;bottom:0}" +
".dshi_trackMark{position:absolute;top:0;bottom:0;width:2px}" +
".dshi_trackLegend{display:flex;gap:var(--dshi-space-sm);flex-wrap:wrap;font-size:var(--dshi-font-xs);color:var(--dshi-text-dim)}" +
".dshi_sliderRow{display:flex;align-items:center;gap:var(--dshi-space-sm);flex-wrap:wrap;width:100%}" +
".dshi_slider{flex:1;min-width:160px;accent-color:var(--dshi-accent)}" +
".dshi_sliderNum{width:96px}" +
".dshi_fieldRow{display:flex;flex-direction:column;gap:var(--dshi-space-xs)}" +
".dshi_controlRow{display:flex;align-items:center;gap:var(--dshi-space-sm);flex-wrap:wrap}" +
".dshi_controlRow>.dshi_sliderRow{flex:1;min-width:220px}" +
".dshi_controlRow>.dshi_btn{flex:none}" +
".dshi_controlRow>.dshi_input{max-width:200px}" +
".dshi_modBadge{border:1px solid var(--dshi-warn);color:var(--dshi-warn);border-radius:var(--dshi-radius-pill);padding:0 8px;font-size:10px;white-space:nowrap}" +
".dshi_fieldError{font-size:var(--dshi-font-xs);color:var(--dshi-danger)}" +
".dshi_blockError{border:var(--dshi-stroke);border-color:var(--dshi-danger);border-radius:var(--dshi-radius-sm);padding:var(--dshi-space-sm);font-size:var(--dshi-font-sm);color:var(--dshi-danger)}" +
    ".dshi_mdPreview{border:var(--dshi-stroke);background:var(--dshi-bg-panel);border-radius:var(--dshi-radius-sm);padding:var(--dshi-space-sm) var(--dshi-space);max-height:320px;overflow:auto;display:flex;flex-direction:column;gap:var(--dshi-space-xs);font-size:var(--dshi-font-sm)}" +
    ".dshi_mdH1{font-size:var(--dshi-font-title);font-weight:600;margin-top:var(--dshi-space-xs)}" +
    ".dshi_mdH2{font-size:var(--dshi-font);font-weight:600;margin-top:var(--dshi-space-xs)}" +
    ".dshi_mdH3{font-size:var(--dshi-font-sm);font-weight:600;margin-top:var(--dshi-space-xs)}" +
    ".dshi_mdP{white-space:pre-wrap;word-break:break-word}" +
    ".dshi_mdList{margin:0;padding-left:20px;display:flex;flex-direction:column;gap:2px}" +
    ".dshi_mdQuote{margin:0;border-left:3px solid var(--dsw-alias-border-l2,#dce2eb);padding:2px 10px;color:var(--dshi-text-dim);white-space:pre-wrap;word-break:break-word}" +
    ".dshi_mdPre{margin:0;font-family:ui-monospace,Consolas,monospace;font-size:var(--dshi-font-xs);line-height:1.6;white-space:pre-wrap;word-break:break-word;background:var(--dshi-bg-panel);border:var(--dshi-stroke);border-radius:var(--dshi-radius-sm);padding:var(--dshi-space-sm)}" +
    ".dshi_mdCode{font-family:ui-monospace,Consolas,monospace;font-size:var(--dshi-font-xs);background:var(--dshi-bg-panel);border:var(--dshi-stroke);border-radius:var(--dshi-radius-sm);padding:0 4px;word-break:break-all}" +
    ".dshi_mdBold{font-weight:600}" +
    ".dshi_memEditor{min-height:320px}" +
    ".dshi_empty{font-size:var(--dshi-font-sm);color:var(--dshi-text-dim);border:1px dashed var(--dsw-alias-border-l2,#dce2eb);border-radius:var(--dshi-radius-sm);padding:var(--dshi-space-sm) var(--dshi-space);line-height:1.7}" +
    ".dshi_conflict{font-size:var(--dshi-font-sm);color:var(--dshi-warn);border:1px solid var(--dshi-warn);border-radius:var(--dshi-radius-sm);padding:var(--dshi-space-sm)}" +
    // U8 壳层：sticky 壳条（选择器 + tab 栏随滚动固定）、tab 内联 SVG 图标（CSS mask，
    // 不动按钮 DOM 形状）、toast 三态与需重启横幅（挂在 body 上，不在 .dshi_root 内，
    // 故 token 在 .dshi_toasts/.dshi_restartBanner 上单独桥接一份）。
".dshi_sticky{position:sticky;top:0;z-index:30;display:flex;flex-direction:column;gap:12px;background:var(--dshi-bg-card);border-bottom:var(--dshi-stroke);padding-bottom:var(--dshi-space-sm);box-shadow:0 8px 20px -14px rgba(15,23,42,.45)}" +
".dshi_tabIco::before{content:\"\";display:inline-block;width:12px;height:12px;margin-right:5px;vertical-align:-1px;background-color:currentColor;-webkit-mask:var(--dshi-tab-ico) center/contain no-repeat;mask:var(--dshi-tab-ico) center/contain no-repeat}" +
".dshi_tabIco-status{--dshi-tab-ico:url('data:image/svg+xml,%3Csvg xmlns=%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27 viewBox=%270 0 16 16%27%3E%3Cpath d=%27M1 8h3l2-5 4 10 2-5h3%27 fill=%27none%27 stroke=%27%23000%27 stroke-width=%272%27 stroke-linecap=%27round%27 stroke-linejoin=%27round%27/%3E%3C/svg%3E')}" +
".dshi_tabIco-memory{--dshi-tab-ico:url('data:image/svg+xml,%3Csvg xmlns=%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27 viewBox=%270 0 16 16%27%3E%3Cpath d=%27M8 1l6 3-6 3-6-3z%27/%3E%3Cpath d=%27M2 8l6 3 6-3M2 12l6 3 6-3%27 fill=%27none%27 stroke=%27%23000%27 stroke-width=%271.5%27 stroke-linejoin=%27round%27/%3E%3C/svg%3E')}" +
".dshi_tabIco-graph{--dshi-tab-ico:url('data:image/svg+xml,%3Csvg xmlns=%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27 viewBox=%270 0 16 16%27%3E%3Ccircle cx=%273%27 cy=%273%27 r=%272.2%27/%3E%3Ccircle cx=%2713%27 cy=%273%27 r=%272.2%27/%3E%3Ccircle cx=%278%27 cy=%2713%27 r=%272.2%27/%3E%3Cpath d=%27M3 3h10M3 3l5 10M13 3l-5 10%27 fill=%27none%27 stroke=%27%23000%27 stroke-width=%271.5%27/%3E%3C/svg%3E')}" +
".dshi_tabIco-candidates{--dshi-tab-ico:url('data:image/svg+xml,%3Csvg xmlns=%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27 viewBox=%270 0 16 16%27%3E%3Crect x=%272%27 y=%272%27 width=%275%27 height=%275%27 rx=%271%27/%3E%3Crect x=%272%27 y=%279%27 width=%275%27 height=%275%27 rx=%271%27/%3E%3Cpath d=%27M9 4h5M9 12h5%27 fill=%27none%27 stroke=%27%23000%27 stroke-width=%271.5%27/%3E%3C/svg%3E')}" +
".dshi_tabIco-topics{--dshi-tab-ico:url('data:image/svg+xml,%3Csvg xmlns=%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27 viewBox=%270 0 16 16%27%3E%3Cpath d=%27M3 1h10v14l-5-4-5 4z%27/%3E%3C/svg%3E')}" +
".dshi_tabIco-budgets{--dshi-tab-ico:url('data:image/svg+xml,%3Csvg xmlns=%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27 viewBox=%270 0 16 16%27%3E%3Cpath d=%27M1 4h14M1 8h14M1 12h14%27 fill=%27none%27 stroke=%27%23000%27 stroke-width=%271.5%27/%3E%3Ccircle cx=%275%27 cy=%274%27 r=%272%27/%3E%3Ccircle cx=%2711%27 cy=%278%27 r=%272%27/%3E%3Ccircle cx=%276%27 cy=%2712%27 r=%272%27/%3E%3C/svg%3E')}" +
".dshi_toasts,.dshi_restartBanner{--dshi-safe:var(--dsw-alias-state-success-primary,#1a7f37);--dshi-warn:#b45309;--dshi-danger:var(--dsw-alias-state-error-primary,#f85149);--dshi-radius-sm:8px;--dshi-font-sm:12px;--dshi-font-xs:11px}" +
".dshi_toasts{position:fixed;right:16px;bottom:16px;z-index:1000;display:flex;flex-direction:column;gap:8px;max-width:340px}" +
".dshi_toast{display:flex;align-items:flex-start;gap:8px;border-radius:var(--dshi-radius-sm);padding:8px 10px;font-size:var(--dshi-font-sm);line-height:1.5;color:#fff}" +
".dshi_toastSuccess{background:var(--dshi-safe)}" +
".dshi_toastError{background:var(--dshi-danger)}" +
".dshi_toastRestart{background:var(--dshi-warn)}" +
".dshi_toastText{flex:1;word-break:break-word}" +
".dshi_toastClose{border:none;background:none;color:inherit;font:inherit;font-size:14px;line-height:1;cursor:pointer;padding:0}" +
".dshi_restartBanner{position:fixed;top:0;left:50%;transform:translateX(-50%);z-index:1001;display:flex;align-items:center;gap:10px;max-width:640px;background:var(--dshi-warn);color:#fff;border-radius:0 0 var(--dshi-radius-sm) var(--dshi-radius-sm);padding:8px 14px;font-size:var(--dshi-font-sm);line-height:1.5}" +
".dshi_restartText{flex:1;word-break:break-word}" +
".dshi_restartClose{border:1px solid currentColor;background:none;color:inherit;font:inherit;font-size:var(--dshi-font-xs);border-radius:6px;padding:2px 8px;cursor:pointer}";
    function ensureStyle() {
      try {
        if (document.getElementById("dsh-shiori-style")) return;
        var tag = document.createElement("style");
        tag.id = "dsh-shiori-style";
        tag.textContent = CSS;
        document.head.appendChild(tag);
      } catch (error) { /* 非 DOM 环境忽略 */ }
    }

    // ── U8 toast / 需重启横幅（纯 DOM，独立于 React 树） ─────────────────────
    // 三态语义：success 成功（约 3s 自动消失）/ error 失败（约 6s 或手动关闭）/
    // restart 需重启（约 6s 或手动关闭）。右下角浮层可叠多条；需重启另有页内横幅
    // （顶部强提示，手动关闭）。宿主面板滚动容器之外挂 body，不受 .dshi_root 影响。
    // 非 DOM 环境（测试/SSR）整体静默 no-op，绝不抛错。卸载时 disposeToastUi()
    // 统一清理全部定时器并摘除节点（不许泄漏），由 apply(ctx) 的 disposer 调用。
    var TOAST_TTL = { success: 3000, error: 6000, restart: 6000 };
    var TOAST_KIND_CLASS = { success: "dshi_toastSuccess", error: "dshi_toastError", restart: "dshi_toastRestart" };
    var RESTART_HINT = "保存成功；新预算将在下次插件重载或宿主重启后生效。";
    var toastUi = null; // { host, banner, bannerText, entries: [{ el, timer }] }

    function toastDocument() {
      return typeof document === "undefined" ? null : document;
    }

    function ensureToastUi() {
      var doc = toastDocument();
      if (!doc || typeof doc.createElement !== "function" || !doc.body) return null;
      if (toastUi) return toastUi;
      var host = doc.createElement("div");
      host.className = "dshi_toasts";
      doc.body.appendChild(host);
      toastUi = { host: host, banner: null, bannerText: null, bannerTimer: null, entries: [] };
      return toastUi;
    }

    function removeToastEntry(ui, entry) {
      var index = ui.entries.indexOf(entry);
      if (index >= 0) ui.entries.splice(index, 1);
      if (entry.timer !== null) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
      if (entry.el && entry.el.parentNode) entry.el.parentNode.removeChild(entry.el);
    }

    // 可复用调用入口：shioriToast(kind, text)，kind = "success" | "error" | "restart"。
    function shioriToast(kind, text) {
      var ui = ensureToastUi();
      if (!ui) return null;
      var doc = toastDocument();
      var normalizedKind = TOAST_KIND_CLASS[kind] ? kind : "error";
      var el = doc.createElement("div");
      el.className = "dshi_toast " + TOAST_KIND_CLASS[normalizedKind];
      el.setAttribute("data-kind", normalizedKind);
      var textEl = doc.createElement("span");
      textEl.className = "dshi_toastText";
      textEl.textContent = String(text === undefined || text === null ? "" : text);
      var close = doc.createElement("button");
      close.className = "dshi_toastClose";
      close.type = "button";
      close.setAttribute("aria-label", "关闭提示");
      close.textContent = "×";
      el.appendChild(textEl);
      el.appendChild(close);
      ui.host.appendChild(el);
      var entry = { el: el, timer: null };
      entry.timer = setTimeout(function () { removeToastEntry(ui, entry); }, TOAST_TTL[normalizedKind]);
      close.onclick = function () { removeToastEntry(ui, entry); };
      ui.entries.push(entry);
      return el;
    }

    // 需重启的页内强提示：顶部横幅，只保留一条，再次触发时刷新文案并重置计时；
    // 8 秒后自动收起，也可手动关闭（不常驻——挂太久会被当成关不掉的报错框）。
    var RESTART_BANNER_TTL = 8000;

    function hideRestartBanner() {
      var ui = toastUi;
      if (!ui) return;
      if (ui.bannerTimer) {
        clearTimeout(ui.bannerTimer);
        ui.bannerTimer = null;
      }
      if (ui.banner && ui.banner.parentNode) ui.banner.parentNode.removeChild(ui.banner);
      ui.banner = null;
      ui.bannerText = null;
    }

    function showRestartBanner(text) {
      var ui = ensureToastUi();
      if (!ui) return null;
      var doc = toastDocument();
      if (!ui.banner) {
        var banner = doc.createElement("div");
        banner.className = "dshi_restartBanner";
        banner.setAttribute("data-role", "restart-banner");
        var bannerText = doc.createElement("span");
        bannerText.className = "dshi_restartText";
        var close = doc.createElement("button");
        close.className = "dshi_restartClose";
        close.type = "button";
        close.setAttribute("aria-label", "关闭需重启提示");
        close.textContent = "知道了";
        banner.appendChild(bannerText);
        banner.appendChild(close);
        doc.body.appendChild(banner);
        close.onclick = function () { hideRestartBanner(); };
        ui.banner = banner;
        ui.bannerText = bannerText;
      }
      ui.bannerText.textContent = String(text === undefined || text === null ? RESTART_HINT : text);
      if (ui.bannerTimer) clearTimeout(ui.bannerTimer);
      ui.bannerTimer = setTimeout(function () { hideRestartBanner(); }, RESTART_BANNER_TTL);
      return ui.banner;
    }

    // 保存/执行成功但需重启才生效时的组合入口：「需重启」toast + 页内横幅。
    function notifyRestart(text) {
      shioriToast("restart", text === undefined ? RESTART_HINT : text);
      showRestartBanner(text === undefined ? RESTART_HINT : text);
    }

    function disposeToastUi() {
      if (!toastUi) return;
      var ui = toastUi;
      toastUi = null;
      var entries = ui.entries.slice(0);
      for (var i = 0; i < entries.length; i++) removeToastEntry(ui, entries[i]);
      if (ui.bannerTimer) clearTimeout(ui.bannerTimer);
      if (ui.banner && ui.banner.parentNode) ui.banner.parentNode.removeChild(ui.banner);
      if (ui.host && ui.host.parentNode) ui.host.parentNode.removeChild(ui.host);
      ui.banner = null;
      ui.bannerText = null;
      ui.host = null;
    }

    // ── vendored createTypertRemoteInfo（与官方生成 client 内联版本一致） ────
    function createTypertRemoteInfo(spec, z) {
      return new RemoteInfo(spec, z);
    }
    function optional(parameter) {
      return parameter.source === "json" && parameter.acceptsUndefined === true;
    }
    var RemoteInfo = class {
      constructor(spec, z) {
        this.spec = spec;
        this.z = z;
      }
      get package() {
        return this.spec.package;
      }
      get descriptors() {
        return this.resolve().descriptors;
      }
      get methods() {
        return this.resolve().methods;
      }
      resolve() {
        if (this.index !== undefined) return this.index;
        var z = this.z;
        var descriptors = [];
        var methods = Object.create(null);
        var entries = Object.entries(this.spec.methods);
        for (var i = 0; i < entries.length; i++) {
          var endpoint = entries[i][0];
          var definition = entries[i][1];
          var separator = endpoint.indexOf("/");
          var namespace = endpoint.slice(0, separator);
          var method = endpoint.slice(separator + 1);
          var parameters = definition.parameters.map(function (parameter) {
            return Object.assign({}, parameter, { wire: parameter.wire ?? parameter.name });
          });
          var descriptor = Object.assign({}, definition, {
            id: this.spec.package + "#" + endpoint,
            namespace: namespace,
            method: method,
            parameters: parameters,
            result: definition.result.description === undefined ? definition.result : new ResultValue(definition.result)
          });
          if (definition.invocation.kind === "direct") {
            (function (descriptor, namespace, method, definition, parameters) {
              var inputs = [];
              methods[endpoint] = Object.assign(descriptor, {
                input: function (options) {
                  var strict = options?.strict === true;
                  return inputs[strict ? 1 : 0] ??= new NamedInput(parameters, strict, z);
                },
                invoke: function (remote, input, signal) {
                  var named = input;
                  var values = parameters.map(function (parameter) { return named[parameter.wire]; });
                  if (definition.cancellation !== undefined) values.push(signal);
                  var receiver = Reflect.get(remote, namespace);
                  return Reflect.get(receiver, method).apply(receiver, values);
                }
              });
            })(descriptor, namespace, method, definition, parameters);
          }
          descriptors.push(descriptor);
        }
        return this.index = { descriptors: descriptors, methods: methods };
      }
    };
    var NamedInput = class {
      constructor(parameters, strict, z) {
        this.parameters = parameters;
        this.strict = strict;
        this.z = z;
      }
      codec(parameter) {
        return this.strict ? parameter.strictCodec : parameter.codec;
      }
      create = () => this.schema ??= this.z.strictObject(Object.fromEntries(this.parameters.map((parameter) => {
        var value = this.codec(parameter).create();
        return [parameter.wire, optional(parameter) ? value.optional() : value.nonoptional()];
      })));
      get jsonSchema() {
        return this.project().jsonSchema;
      }
      get jsonSchemaError() {
        return this.project().jsonSchemaError;
      }
      project() {
        if (this.projection !== undefined) return this.projection;
        var unavailable = this.parameters.find((parameter) => this.codec(parameter).jsonSchema === undefined);
        if (unavailable !== undefined) return this.projection = { jsonSchemaError: this.codec(unavailable).jsonSchemaError ?? "No JSON Schema for parameter " + unavailable.wire };
        return this.projection = { jsonSchema: {
          type: "object",
          properties: Object.fromEntries(this.parameters.map((parameter) => [parameter.wire, Object.assign({}, this.codec(parameter).jsonSchema, parameter.description === undefined ? {} : { description: parameter.description })])),
          required: this.parameters.filter((parameter) => !optional(parameter)).map((parameter) => parameter.wire),
          additionalProperties: false
        } };
      }
    };
    var ResultValue = class {
      constructor(spec) {
        this.spec = spec;
      }
      get mode() { return this.spec.mode; }
      get typeSymbol() { return this.spec.typeSymbol; }
      get create() { return this.spec.create; }
      get decode() { return this.spec.decode; }
      get encode() { return this.spec.encode; }
      get description() { return this.spec.description; }
      get jsonSchemaError() { return this.spec.jsonSchemaError; }
      get jsonSchema() {
        if (this.projection === undefined) {
          var schema = this.spec.jsonSchema;
          this.projection = { value: schema === undefined ? undefined : Object.assign({}, schema, { description: this.spec.description }) };
        }
        return this.projection.value;
      }
    };

    // ── 冻结 wire 定义（namespace shiori；参数 session→wire sessionId + payload） ──
    var RPC_METHODS = ["getStatus", "getMemoryView", "getGraph", "executeTool", "listCandidates", "analyze", "reviewCandidate", "previewPlan", "executePlan", "getTimeline"];
    function sessionCodec() {
      return {
        mode: "strict",
        typeSymbol: "@deepseek-ai/dsh-session/types#SessionId",
        create: function () { return zod.z.string(); },
        jsonSchema: { type: "string" }
      };
    }
    function createPayloadSchema() {
      var z = zod.z;
      try { return z.record(z.string(), z.unknown()); } catch (error) { /* zod 形状回退 */ }
      try { return z.looseObject({}); } catch (error) { /* 同上 */ }
      return z.any();
    }
    function payloadCodec(symbol) {
      return {
        mode: "strict",
        typeSymbol: symbol,
        create: createPayloadSchema,
        jsonSchema: { type: "object" }
      };
    }
    function buildSpec() {
      var methods = {};
      for (var i = 0; i < RPC_METHODS.length; i++) {
        var method = RPC_METHODS[i];
        var endpoint = "shiori/" + method;
        methods[endpoint] = {
          service: "shiori.panel",
          description: "Shiori management method " + method + " (frozen wire: sessionId + payload).",
          invocation: { kind: "direct" },
          parameters: [
            {
              name: "session",
              wire: "sessionId",
              source: "lookup",
              lookup: "session",
              description: "Session identity resolved by the Host into a live Session object.",
              codec: sessionCodec(),
              strictCodec: sessionCodec()
            },
            {
              name: "payload",
              source: "json",
              description: "Business payload; validated server-side by the shiori protocol.",
              codec: payloadCodec("dsh-shiori#" + endpoint + ":payload"),
              strictCodec: payloadCodec("dsh-shiori#" + endpoint + ":payload")
            }
          ],
          cancellation: { parameter: "signal" },
          result: {
            mode: "strict",
            typeSymbol: "dsh-shiori#" + endpoint + ":result",
            // 输出权威在服务端（P 的 MANAGEMENT_METHODS 输出 schema）；客户端按
            // 原样 JSON 透传渲染，不在浏览器侧复制业务校验。
            create: function () { return zod.z.unknown(); }
          }
        };
      }
      return { package: "dsh-shiori", methods: methods };
    }
    var TYPERT_REMOTE = createTypertRemoteInfo(buildSpec(), zod.z);

    // ── 小工具 ──────────────────────────────────────────────────────────────
    function assign(target) {
      for (var i = 1; i < arguments.length; i++) {
        var source = arguments[i];
        if (source) for (var key in source) if (Object.prototype.hasOwnProperty.call(source, key)) target[key] = source[key];
      }
      return target;
    }
    function newId() {
      try {
        if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
      } catch (error) { /* 回退 */ }
      return "op-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
    }
    function stableStringify(value) {
      return JSON.stringify(value, null, 2) ?? "null";
    }
    // Q-C（owner work order）：diagnostics 里 P 本轮会新增 codec/transport 等字段，
    // 未来还可能继续加。状态 tab 必须容错：未知字段照常展示（key: value），值为
    // undefined 的键忽略（不显示 undefined / 伪装成 null），序列化抛错（循环引用等）
    // 降级为 String()，绝不崩。
    function safeDtoText(value) {
      if (value === undefined) return "";
      try { return stableStringify(value); } catch (error) { return String(value); }
    }

    // R3 守卫（owner review）：宿主 isRemoteJsonValue 拒绝含 undefined / 非 JSON
    // 值的 payload。发送前在客户端按同一规则检查，出现即抛带 code 的错误——
    // 不静默剥字段（把「缺数据」伪装成「合法空值」），也不发不可序列化对象。
    function losslessError(where, what) {
      var error = new Error("shiori UI: non-lossless JSON value at " + where + " (" + what + ")");
      error.code = "shiori/ui-invalid-payload";
      return error;
    }
    function ensureLosslessJson(value, path) {
      var where = path || "payload";
      if (value === undefined) throw losslessError(where, "undefined");
      if (value === null || typeof value === "boolean" || typeof value === "string") return value;
      if (typeof value === "number") {
        if (!Number.isFinite(value)) throw losslessError(where, String(value));
        return value;
      }
      if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
        throw losslessError(where, typeof value);
      }
      if (Array.isArray(value)) {
        for (var i = 0; i < value.length; i++) ensureLosslessJson(value[i], where + "[" + i + "]");
        return value;
      }
      var proto = Object.getPrototypeOf(value);
      if (proto === Object.prototype || proto === null) {
        for (var key of Object.keys(value)) ensureLosslessJson(value[key], where + "." + key);
        return value;
      }
      throw losslessError(where, proto && proto.constructor ? String(proto.constructor.name) : typeof value);
    }

    // ── remote 命名空间取用（Cordis 服务键 `remote.<ns>`） ──────────────────
    // 宿主把 remote 命名空间注册为 Cordis 服务键 "remote.<ns>"，消费方必须走
    // ctx.get("remote.<ns>")；直接读 ctx.remote.<ns> 在未 inject 时会命中 Cordis
    // 的未注入属性拦截（cannot get property "remote.<ns>" without inject）。
    // 注意：本插件自己通过 ctx.remote.$mount 提供 "remote.shiori"，绝不能把它写进
    // inject（会自锁 pending waiting for service）。取不到时回退旧属性直读以兼容
    // 已注入的 ctx / 旧宿主，但必须 try/catch（未注入时 getter 会抛错）。
    function remoteNamespace(ctx, name) {
      var service;
      if (ctx && typeof ctx.get === "function") {
        try { service = ctx.get("remote." + name); } catch (error) { /* 未注册 → 视为缺失 */ }
      }
      if (service !== undefined && service !== null) return service;
      try {
        return ctx && ctx.remote ? ctx.remote[name] : undefined;
      } catch (error) {
        return undefined;
      }
    }

    // ── 会话列表规范化（宿主真实 DTO，owner 实机 /api/session/list 抓包） ─────
    // 宿主 session.list → { ok:true, value:{ items:[item...] } }：
    //   - 标题在 item.projections.values.title（不是 item.title）；
    //   - 子代理会话带 parentSessionId 或 origin === "subagent"（面板不应展示，
    //     否则每个 tab 都会被 [session/agent-busy] 拒绝）；
    //   - 归档集合不在 session.list 里，只存在于宿主 Cordis 服务 "workspaces"
    //     （ClientWorkspaceModel）快照的 archivedSessionIds 里。
    // 以下规范化函数不抛错：服务缺失/快照异常一概当作「无归档」（不打日志）。
    function isSubagentSessionItem(item) {
      if (!item || typeof item !== "object") return false;
      if (item.origin === "subagent") return true;
      var parent = item.parentSessionId;
      return parent !== undefined && parent !== null && String(parent) !== "";
    }

    function archivedSessionIds(ctx) {
      var rawIds = null;
      try {
        var workspaces = ctx && typeof ctx.get === "function" ? ctx.get("workspaces") : undefined;
        var snapshot = null;
        if (workspaces && workspaces.list && typeof workspaces.list.getSnapshot === "function") {
          snapshot = workspaces.list.getSnapshot();
        } else if (workspaces && typeof workspaces.getSnapshot === "function") {
          snapshot = workspaces.getSnapshot();
        }
        if (snapshot && Array.isArray(snapshot.archivedSessionIds)) rawIds = snapshot.archivedSessionIds;
      } catch (error) {
        rawIds = null;
      }
      var ids = new Set();
      if (Array.isArray(rawIds)) {
        for (var i = 0; i < rawIds.length; i++) {
          if (rawIds[i] !== undefined && rawIds[i] !== null && String(rawIds[i]) !== "") ids.add(String(rawIds[i]));
        }
      }
      return ids;
    }

    function sessionTitleOf(item) {
      var direct = item.title;
      if (typeof direct === "string" && direct.trim() !== "") return direct;
      var projections = item.projections;
      var values = projections && typeof projections === "object" ? projections.values : null;
      var projected = values && typeof values === "object" ? values.title : undefined;
      if (typeof projected === "string" && projected.trim() !== "") return projected;
      return "";
    }

    function normalizeSessionItems(items, archivedIds, currentSessionId) {
      var normalized = [];
      // 当前会话（slot props.sessionId，或面板已选中的 sessionId）即使还是空壳也要保留：
      // 用户刚建新会话、还没说话就在该会话里打开面板时，下拉里必须看得到自己。
      var currentId = currentSessionId !== undefined && currentSessionId !== null
        ? String(currentSessionId)
        : "";
      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        if (!item || typeof item !== "object") continue;
        if (isSubagentSessionItem(item)) continue;
        var sessionId = String(item.sessionId !== undefined && item.sessionId !== null
          ? item.sessionId
          : (item.id !== undefined && item.id !== null ? item.id : ""));
        if (sessionId === "") continue;
        // 空壳会话（item.blank === true，title:null）是宿主建过但没说过话的裸 session，
        // 混进下拉只会让用户选到一个永远 writer-held 的 id；当前会话例外。blank 缺失按 false 处理。
        if (item.blank === true && sessionId !== currentId) continue;
        if (archivedIds && archivedIds.has(sessionId)) continue;
        normalized.push({ sessionId: sessionId, title: sessionTitleOf(item), updatedAt: item.updatedAt });
      }
      return normalized;
    }

    // ── RPC 调用封装（RemoteResult → value / 抛出带 code 的错误） ────────────
    function buildApi(ctx) {
      return {
        call: async function (method, sessionId, payload) {
          var namespace = remoteNamespace(ctx, "shiori");
          if (!namespace || typeof namespace[method] !== "function") {
            var error = new Error("shiori namespace is not mounted (method " + method + ")");
            error.code = "shiori/ui-unavailable";
            throw error;
          }
          var result;
          try {
            result = await namespace[method](sessionId, ensureLosslessJson(payload === undefined ? {} : payload));
          } catch (error1) {
            error1.code = error1.code || "shiori/carrier";
            throw error1;
          }
          if (result && result.ok === false) {
            var failure = new Error((result.error && result.error.message) || "rpc failed");
            failure.code = (result.error && result.error.code) || "UNKNOWN";
            failure.details = result.error && result.error.details;
            throw failure;
          }
          return result ? result.value : undefined;
        },
        listSessions: async function (currentSessionId) {
          try {
            var sessionNamespace = remoteNamespace(ctx, "session");
            if (!sessionNamespace || typeof sessionNamespace.list !== "function") return null;
            var result = await sessionNamespace.list({});
            if (!result || !result.ok) return null;
            var items = result.value && result.value.items;
            // DTO 守卫：宿主 items 非数组时降级为空列表（渲染侧只做 .length/.map）。
            if (!Array.isArray(items)) return [];
            return normalizeSessionItems(items, archivedSessionIds(ctx), currentSessionId);
          } catch (error) {
            return null;
          }
        },
        // 工作区列表（读宿主 workspaces 快照）：会话下拉按工作区分组用。
        // 服务缺失 / 快照异常返回 null，面板退化成平铺会话下拉（与旧行为一致）。
        listWorkspaces: function () {
          try {
            var workspaces = ctx && typeof ctx.get === "function" ? ctx.get("workspaces") : undefined;
            var snapshot = null;
            if (workspaces && workspaces.list && typeof workspaces.list.getSnapshot === "function") {
              snapshot = workspaces.list.getSnapshot();
            } else if (workspaces && typeof workspaces.getSnapshot === "function") {
              snapshot = workspaces.getSnapshot();
            }
            if (!snapshot || !Array.isArray(snapshot.items)) return null;
            var out = [];
            for (var i = 0; i < snapshot.items.length; i++) {
              var item = snapshot.items[i];
              if (!item || typeof item !== "object") continue;
              var workspaceId = String(item.workspaceId !== undefined && item.workspaceId !== null
                ? item.workspaceId
                : (item.id !== undefined && item.id !== null ? item.id : ""));
              if (workspaceId === "") continue;
              var sessionIds = [];
              if (Array.isArray(item.sessionIds)) {
                for (var j = 0; j < item.sessionIds.length; j++) {
                  if (item.sessionIds[j] !== undefined && item.sessionIds[j] !== null) sessionIds.push(String(item.sessionIds[j]));
                }
              }
              var title = typeof item.title === "string" && item.title.trim() !== ""
                ? item.title
                : (typeof item.path === "string" && item.path !== "" ? item.path : workspaceId);
              out.push({
                workspaceId: workspaceId,
                title: title,
                path: typeof item.path === "string" ? item.path : "",
                sessionIds: sessionIds
              });
            }
            return out;
          } catch (error) {
            return null;
          }
        },
        configScope: function () {
          try { return ctx.configForms.get("shiori"); } catch (error) { return undefined; }
        }
      };
    }

    // ── React 组件 ──────────────────────────────────────────────────────────
    var useState = react.useState;
    var useEffect = react.useEffect;
    var useMemo = react.useMemo;
    var useRef = react.useRef;

    // ── 会话级不可用（宿主写句柄锁 / 子代理路由 / 会话不存在 / 无权解析） ─────
    // owner 实机（DSH 0.2.1-rc.2）：12 个会话抽样里 11 个 getStatus 返回
    // session/writer-held，每个数据 tab 就各刷一行红字。会话本身打不开不是各 tab 的
    // 业务错误，统一收敛为「自动跳过 + 面板级提示」；其他错误码照旧进对应 tab
    // 的 ErrorBox（绝不吞、绝不伪装成功）。
    var SESSION_UNAVAILABLE_CODES = {
      "session/writer-held": true,
      "session/agent-busy": true,
      "session/not-found": true,
      "shiori/invalid-session": true
    };
    var SESSION_PROBE_LIMIT = 5;
    function isSessionUnavailableCode(code) {
      return typeof code === "string" && SESSION_UNAVAILABLE_CODES[code] === true;
    }
    function isSessionUnavailableError(error) {
      return Boolean(error) && isSessionUnavailableCode(error.code);
    }
    // 面板 RPC 命名空间都没挂载时探测无法判定会话可用性（不是会话的错）：
    // 退回旧行为选中首条，由各 tab 如实显示 transport 错误。
    function isProbeInconclusiveError(error) {
      var code = error && error.code;
      return code === "shiori/ui-unavailable" || code === "shiori/carrier";
    }
    function sessionFailureOf(error) {
      return {
        code: (error && error.code) || "UNKNOWN",
        message: (error && error.message) || String(error)
      };
    }
    // 会话级不可用的人话文案（owner 指定）；代码本身必须可见，便于排查。
    // 集合内但不在这三条里的（shiori/invalid-session）保留 "[code] message" 原样。
    function sessionUnavailableText(failure) {
      var code = failure && failure.code ? String(failure.code) : "";
      if (code === "session/writer-held") return "宿主无法打开该会话：它正被另一个写句柄占用（可能有子代理或活跃代理正在写），已自动跳过。换一个会话，或稍后点刷新重试。（" + code + "）";
      if (code === "session/agent-busy") return "该会话由子代理路由持有，无法在面板内打开，已自动跳过。（" + code + "）";
      if (code === "session/not-found") return "会话不存在或已被删除，已自动跳过。（" + code + "）";
      return "[" + (code || "UNKNOWN") + "] " + ((failure && failure.message) || "");
    }
    // 会话级失败交回面板层缓存，tab 自身不渲染 ErrorBox（返回 true 表示已处理）。
    function reportSessionUnavailable(error, props, setError) {
      if (!isSessionUnavailableError(error)) return false;
      if (typeof setError === "function") setError(null);
      if (props && typeof props.onSessionUnavailable === "function") props.onSessionUnavailable(error);
      return true;
    }

    function ErrorBox(error) {
      if (!error) return null;
      return h("div", { className: "dshi_error" }, (error.code ? "[" + error.code + "] " : "") + (error.message || String(error)));
    }

    // U3 水位三档具名常量：ratio < WATER_WARN_RATIO 正常、达到 WATER_WARN_RATIO 警示、
    // 达到 WATER_DANGER_RATIO 危险；WATER_FULL_RATIO 仅用于占满截断。颜色不在 JS 写死，
    // 档位只映射到 CSS token（--dshi-safe / --dshi-warn / --dshi-danger，与预算页预览条同批）。
    var WATER_WARN_RATIO = 0.7;
    var WATER_DANGER_RATIO = 0.9;
    var WATER_FULL_RATIO = 1;

    function Bar(label, used, limit, detail) {
      var usedNum = typeof used === "number" && Number.isFinite(used) ? used : 0;
      var limitNum = typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? limit : 0;
      var ratio = limitNum > 0 ? Math.min(WATER_FULL_RATIO, usedNum / limitNum) : 0;
      // 三档判定只此一处，StatusTab 与记忆页共用本函数，不另起第二套颜色逻辑。
      var tier = ratio >= WATER_DANGER_RATIO ? "danger" : (ratio >= WATER_WARN_RATIO ? "warn" : "safe");
      return h("div", { className: "dshi_card" },
        h("div", { className: "dshi_row" },
          h("span", { className: "dshi_hint" }, label),
          h("span", { className: "dshi_mono" }, usedNum + " / " + (limitNum || "?") + " UTF-16")),
        h("div", {
          className: "dshi_bar",
          role: "progressbar",
          "aria-label": label,
          "aria-valuemin": 0,
          "aria-valuemax": limitNum,
          "aria-valuenow": usedNum,
          "data-dshi-bar": tier
        },
          h("div", {
            className: "dshi_barFill " + (tier === "safe" ? "dshi_barFillSafe" : tier === "warn" ? "dshi_barFillWarn" : "dshi_barFillDanger"),
            style: { width: Math.round(ratio * 100) + "%" }
          })),
        detail ? h("div", { className: "dshi_hint" }, detail) : null);
    }

    // diagnostics 在宿主 DTO 中有两种形态：历史数组（[{code:"needs-configuration"}]）
    // 与真实对象（src/plugin/management.mjs getStatus：
    // { ownerId, generation, started }）。非数组对象没有 .some，历史上的直接调用
    // 会在真实 DTO 上抛 "status.diagnostics.some is not a function"，被 React 错误
    // 边界整块抹掉面板——这里统一收敛为对两种形态都安全的判定。
    function diagnosticsNeedsConfiguration(status) {
      if (!status || typeof status !== "object") return false;
      if (status.needsConfiguration === true) return true;
      var diagnostics = status.diagnostics;
      if (Array.isArray(diagnostics)) {
        return diagnostics.some(function (item) {
          return String(item && (item.code || item)).indexOf("needs-configuration") >= 0;
        });
      }
      if (diagnostics && typeof diagnostics === "object") {
        return String(diagnostics.code || "").indexOf("needs-configuration") >= 0;
      }
      if (typeof diagnostics === "string") return diagnostics.indexOf("needs-configuration") >= 0;
      return false;
    }

    // 状态页是给人看的，不是给调试看的：先给中文摘要（模式 / 作用域 / 占用 / 能力），
    // 原始字段（mode / scope / diagnostics / 完整 DTO）一律收进折叠区，需要时再展开。
    var STATUS_MODE_LABELS = { active: "运行中", inactive: "未启用", disabled: "已停用", error: "异常" };
    var STATUS_CAPABILITY_LABELS = {
      l2: "Spark 二级记忆",
      organize: "候选整理",
      forgetting: "遗忘归档",
      tools: "记忆工具",
      sections: "分区写入"
    };

    function statusModeText(mode) {
      if (mode === undefined || mode === null || mode === "") return "未知";
      return STATUS_MODE_LABELS[mode] || String(mode);
    }

    function statusScopeText(scope) {
      if (scope === undefined || scope === null || scope === "") return "";
      if (typeof scope === "object") return String(scope.scopeId ?? scope.persona ?? scope.id ?? stableStringify(scope));
      return String(scope);
    }

    function statusCapabilityText(value) {
      if (value === true) return "已开启";
      if (value === false) return "已关闭";
      if (value === undefined || value === null) return "—";
      if (typeof value === "object") return stableStringify(value);
      return String(value);
    }

    function occupancyText(used, limit) {
      var usedNum = typeof used === "number" && Number.isFinite(used) ? used : null;
      var limitNum = typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? limit : null;
      if (usedNum === null) return "—";
      if (limitNum === null) return usedNum + " 字符";
      var pct = Math.round((usedNum / limitNum) * 1000) / 10;
      return usedNum + " / " + limitNum + " 字符（" + pct + "%）";
    }

    function statusRow(label, value, hint) {
      return h("div", { className: "dshi_row" },
        h("span", { className: "dshi_hint", style: { minWidth: 132 } }, label),
        h("span", null, value),
        hint ? h("span", { className: "dshi_hint" }, hint) : null);
    }

    function StatusTab(props) {
      var state = useState(null);
      var status = state[0];
      var setStatus = state[1];
      var errorState = useState(null);
      var error = errorState[0];
      var setError = errorState[1];
      var load = async function () {
        setError(null);
        try {
          setStatus(await props.dsh.call("getStatus", props.sessionId, {}));
        } catch (e) { setStatus(null); if (!reportSessionUnavailable(e, props, setError)) setError(e); }
      };
      useEffect(function () { load(); }, [props.sessionId]);
      var occupancy = (status && status.occupancy) || {};
      var capabilities = status && status.capabilities && typeof status.capabilities === "object" ? status.capabilities : null;
      var startedFlag = status && status.diagnostics && typeof status.diagnostics === "object" && !Array.isArray(status.diagnostics)
        ? status.diagnostics.started : undefined;
      return h("div", { className: "dshi_card" },
        h("div", { className: "dshi_row" },
          h("span", { className: "dshi_cardTitle" }, "运行状态"),
          h("button", { className: "dshi_btn", onClick: load }, "刷新")),
        ErrorBox(error),
        status === null && !error ? h("div", { className: "dshi_loading" }, "加载中…") : null,
        status ? h(fragment, null,
          diagnosticsNeedsConfiguration(status)
            // 徽标文案中文化，但仍原样带出 code 字面量（排查/测试按它定位）。
            ? h("span", { className: "dshi_badge dshi_badgeWarn" },
                "需要先完成配置，记忆才能工作（",
                "needs-configuration",
                "）")
            : null,
          h("div", { className: "dshi_items" },
            statusRow("运行模式", statusModeText(status.mode),
              status.mode === "active" ? "记忆正在参与对话" : "记忆当前不注入上下文"),
            statusRow("记忆作用域", statusScopeText(status.scope) || "未指定", "记忆数据属于哪个人设"),
            statusRow("服务启动", startedFlag === true ? "已就绪" : (startedFlag === false ? "未就绪" : "未知"),
              startedFlag === true ? "" : "重启 DSH 或刷新可重新探测"),
            // U3：L0/L1 占用改为彩色水位条（共用 Bar 三档），occupancyText 的
            // 「used / limit（百分比）」可读文本保留在 detail 行，不只剩视觉条。
            Bar("人设卡占用（L0）", occupancy.l0Chars, occupancy.l0Budget,
              occupancyText(occupancy.l0Chars, occupancy.l0Budget) + " · 人设卡正文已用 / 上限"),
            Bar("记忆核心占用（L1）", occupancy.l1Chars, occupancy.l1HardCap,
              occupancyText(occupancy.l1Chars, occupancy.l1HardCap) + " · 记忆核心正文已用 / 硬上限")),
          capabilities ? h("div", { className: "dshi_card" },
            h("div", { className: "dshi_cardTitle" }, "已启用的能力"),
            h("div", { className: "dshi_row" }, Object.keys(capabilities).map(function (key) {
              var on = capabilities[key] === true;
              return h("span", {
                key: key,
                className: "dshi_badge" + (on ? "" : " dshi_badgeDim")
              }, (STATUS_CAPABILITY_LABELS[key] || key) + "：" + statusCapabilityText(capabilities[key]));
            }))) : null,
          h("details", null,
            h("summary", { className: "dshi_hint" }, "技术细节（原始字段，一般不用看）"),
            h("div", { className: "dshi_items" },
              h("div", { className: "dshi_item dshi_mono" }, "mode: " + String(status.mode)),
              h("div", { className: "dshi_item dshi_mono" }, "scope: " + String(statusScopeText(status.scope) || "—")),
              Array.isArray(status.diagnostics) && status.diagnostics.length > 0
                ? h("div", { className: "dshi_items" }, status.diagnostics.filter(function (item) { return item !== undefined; }).map(function (item, index) {
                    return h("div", { key: index, className: "dshi_item dshi_mono" }, typeof item === "string" ? item : safeDtoText(item));
                  }))
                : null,
              // 真实 DTO：diagnostics 是对象（ownerId / generation / started，P 后续新增
              // codec/transport 等）——未知键照常渲染，undefined 值忽略，序列化异常降级。
              !Array.isArray(status.diagnostics) && status.diagnostics && typeof status.diagnostics === "object"
                ? h("div", { className: "dshi_items" }, Object.keys(status.diagnostics).filter(function (key) {
                    return status.diagnostics[key] !== undefined;
                  }).map(function (key) {
                    return h("div", { key: key, className: "dshi_item dshi_mono" }, key + ": " + safeDtoText(status.diagnostics[key]));
                  }))
                : null)),
          h("details", null,
            h("summary", { className: "dshi_hint" }, "完整 DTO（服务端原样返回）"),
            h("pre", { className: "dshi_pre" }, stableStringify(status))))
        : null);
    }

    function MemoryTab(props) {
      var state = useState(null);
      var view = state[0];
      var setView = state[1];
      var errorState = useState(null);
      var error = errorState[0];
      var setError = errorState[1];
      // R7 追加：L0/L1 手动编辑。新 state 一律追加在既有 state 之后，
      // 保持 test/plugin/client.test.mjs 预置的 states 下标不变。
      var editingState = useState(null);   // null | "l0" | "l1"
      var editing = editingState[0];
      var setEditing = editingState[1];
      // 草稿按层保留（{l0:"...", l1:"..."}）：取消编辑不落盘也不清空已输入的
      // 内容，重进编辑时若该层已有草稿则继续用草稿，不回填服务端版本。
      var draftState = useState(null);
      var draft = draftState[0];
      var setDraft = draftState[1];
      var busyState = useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];
      var okState = useState(null);
      var okText = okState[0];
      var setOk = okState[1];
      var saveErrorState = useState(null);
      var saveError = saveErrorState[0];
      var setSaveError = saveErrorState[1];
      var load = async function () {
        setError(null);
        try {
          setView(await props.dsh.call("getMemoryView", props.sessionId, {}));
        } catch (e) { setView(null); if (!reportSessionUnavailable(e, props, setError)) setError(e); }
      };
      useEffect(function () { load(); }, [props.sessionId]);
      var l0 = view && (view.l0 || view.persona);
      var l1 = view && (view.l1 || view.core);
      var budgets = (view && view.budgets) || props.budgets || {};

      // 编辑初值：L1 的 text 是服务端渲染视图（core 正文 + 派生主题索引），整段写回
      // 会把索引固化进 core，必须用 body（磁盘正文）。L0 没有派生部分，照旧用 text。
      var initialDraftFor = function (kind, layer) {
        if (kind === "l1" && layer && typeof layer.body === "string") return layer.body;
        if (typeof layer === "string") return layer;
        return String((layer && (layer.text ?? layer.content)) ?? "");
      };
      var draftFor = function (kind) {
        return draft && typeof draft[kind] === "string" ? draft[kind] : "";
      };
      var beginEdit = function (kind) {
        if (!view) return;   // 数据未加载不进编辑，避免对着空壳误写
        var layer = kind === "l0" ? l0 : l1;
        setEditing(kind);
        setOk(null);
        setSaveError(null);
        // 草稿按层保留：取消后重进编辑不清空用户已输入的内容，
        // 只在该层还没有草稿时才回填服务端当前版本。
        if (!draft || typeof draft[kind] !== "string") {
          var patch = {};
          patch[kind] = initialDraftFor(kind, layer);
          setDraft(Object.assign({}, draft, patch));
        }
      };
      // 取消：退出编辑、不落盘、不清空草稿（用户已输入的内容保留）。
      var cancelEdit = function () { setEditing(null); setOk(null); setSaveError(null); };
      // 保存复用 executeTool（与面板其它写操作同一条链路）：L0 走 soul_update，
      // L1 走 core_write 并始终带 expectedRevision 做 CAS——revision 过期服务端报
      // REVISION_CONFLICT，不静默覆盖别人的修改；冲突时停在编辑态、草稿原样保留。
      var save = async function () {
        if (!editing) return;
        var kind = editing;
        var text = draftFor(kind);
        setBusy(true);
        setSaveError(null);
        setOk(null);
        try {
          if (kind === "l0") {
            await props.dsh.call("executeTool", props.sessionId, { name: "soul_update", args: { content: text } });
          } else {
            // core_write 的 expectedRevision 是硬性要求（string，或首次创建时的
            // null）；拿不到 revision 时传 null 让服务端拒绝，绝不静默覆盖。
            var args = {
              content: text,
              expectedRevision: (l1 && l1.revision !== undefined && l1.revision !== null) ? l1.revision : null
            };
            await props.dsh.call("executeTool", props.sessionId, { name: "core_write", args: args });
          }
          var cleared = {};
          cleared[kind] = "";
          setDraft(Object.assign({}, draft, cleared));
          setEditing(null);
          setOk(kind === "l0" ? "人设卡已保存（下一轮对话即生效）" : "记忆核心已保存");
          await load();
        } catch (e) {
          // 冲突/失败都不丢草稿：停在编辑态，已输入的内容原样保留在文本框里。
          setSaveError(e);
        } finally {
          setBusy(false);
        }
      };
      // ── 预览态：markdown 安全子集渲染 ─────────────────────────────────
      // 只支持：标题（# ~ ###）、无序/有序列表、引用块、粗体、行内代码、围栏
      // 代码块。全部经 DOM API（React 元素 + 文本节点）构建，绝不 innerHTML——
      // 记忆内容只会以字符串子节点的形式出现，<script>/<img onerror> 之类
      // 一律按字面显示；不支持的语法（#### 四级标题、未闭合的 ** / ` 等）
      // 按原样文本显示，不吞内容。
      var mdInline = function (text) {
        var out = [];
        var rest = String(text);
        var buf = "";
        var flush = function () { if (buf !== "") { out.push(buf); buf = ""; } };
        while (rest.length > 0) {
          var tick = rest.indexOf("`");
          var star = rest.indexOf("**");
          if (tick < 0 && star < 0) { buf += rest; break; }
          if (tick >= 0 && (star < 0 || tick < star)) {
            var endTick = rest.indexOf("`", tick + 1);
            if (endTick < 0) { buf += rest; break; }   // 未闭合：按字面输出
            flush();
            out.push(h("code", { key: out.length, className: "dshi_mdCode" }, rest.slice(tick + 1, endTick)));
            rest = rest.slice(endTick + 1);
          } else {
            var endStar = rest.indexOf("**", star + 2);
            if (endStar < 0) { buf += rest; break; }   // 未闭合：按字面输出
            flush();
            out.push(h("strong", { key: out.length, className: "dshi_mdBold" }, rest.slice(star + 2, endStar)));
            rest = rest.slice(endStar + 2);
          }
        }
        flush();
        return out;
      };
      var mdBlocks = function (text) {
        var lines = String(text).split(/\r\n|\n|\r/);
        var blocks = [];
        var i = 0;
        var isBlockStart = /^(#{1,3}\s|[-*]\s|\d+[.)]\s|>|```)/;
        while (i < lines.length) {
          var line = lines[i];
          if (/^\s*```/.test(line)) {
            // 围栏代码块：内容整体作为单个文本节点，不做任何行内解析。
            var codeLines = [];
            i += 1;
            while (i < lines.length && !/^\s*```/.test(lines[i])) { codeLines.push(lines[i]); i += 1; }
            if (i < lines.length) i += 1;   // 跳过闭合围栏；未闭合到结尾也照常收块
            blocks.push(h("pre", { key: blocks.length, className: "dshi_mdPre" }, codeLines.join("\n")));
            continue;
          }
          var heading = line.match(/^(#{1,3})\s+(.*)$/);
          if (heading) {
            blocks.push(h("div", { key: blocks.length, className: "dshi_mdH" + heading[1].length }, mdInline(heading[2])));
            i += 1;
            continue;
          }
          if (/^\s*>\s?/.test(line)) {
            var quoteLines = [];
            while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
              quoteLines.push(lines[i].replace(/^\s*>\s?/, ""));
              i += 1;
            }
            blocks.push(h("blockquote", { key: blocks.length, className: "dshi_mdQuote" }, mdInline(quoteLines.join("\n"))));
            continue;
          }
          if (/^\s*[-*]\s+/.test(line)) {
            var ulItems = [];
            while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
              ulItems.push(h("li", { key: ulItems.length }, mdInline(lines[i].replace(/^\s*[-*]\s+/, ""))));
              i += 1;
            }
            blocks.push(h("ul", { key: blocks.length, className: "dshi_mdList" }, ulItems));
            continue;
          }
          if (/^\s*\d+[.)]\s+/.test(line)) {
            var olItems = [];
            while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
              olItems.push(h("li", { key: olItems.length }, mdInline(lines[i].replace(/^\s*\d+[.)]\s+/, ""))));
              i += 1;
            }
            blocks.push(h("ol", { key: blocks.length, className: "dshi_mdList" }, olItems));
            continue;
          }
          if (line.trim() === "") { i += 1; continue; }
          var paraLines = [line];
          i += 1;
          while (i < lines.length && lines[i].trim() !== "" && !isBlockStart.test(lines[i])) {
            paraLines.push(lines[i]);
            i += 1;
          }
          blocks.push(h("div", { key: blocks.length, className: "dshi_mdP" }, mdInline(paraLines.join("\n"))));
        }
        return blocks;
      };
      var layerRawText = function (layer) {
        if (typeof layer === "string") return layer;
        return String((layer && (layer.text ?? layer.content ?? layer.rendered)) ?? "");
      };
      // 空状态：说明记忆怎么组织、从哪里开始写第一条、需要先配置什么，不留白。
      var renderEmptyLayer = function (kind, title) {
        var guide = kind === "l0"
          ? "人设卡（L0）还是空的。记忆按层组织：L0 是每轮对话常驻注入的身份与规则卡，L1 是记忆核心，更细的事实记录在 L2/L3（由记忆工具与候选整理维护）。写第一条：点下方「编辑」，写下这份人设的身份、语气与边界，保存后下一轮对话即生效。开始前请先确认面板处于 active 模式，并在「预算配置」里设置人设卡最大字符数。"
          : "记忆核心（L1）还是空的。它是长期记忆的正文区，服务端渲染时会自动在正文后附加主题索引，不用手写。写第一条：点下方「编辑」，用一段话记录值得长期记住的事实或偏好，保存即生效。开始前请先确认面板处于 active 模式，并在「预算配置」里设置记忆核心的目标字符数与硬上限。";
        return h("div", { className: "dshi_card" },
          h("div", { className: "dshi_row" },
            h("span", { className: "dshi_cardTitle" }, title),
            h("span", { style: { flex: 1 } }),
            h("button", { className: "dshi_btn", onClick: function () { beginEdit(kind); } }, "编辑")),
          h("div", { className: "dshi_empty" }, guide));
      };
      var renderLayer = function (kind, title, layer, hint) {
        var isEditing = editing === kind;
        var rawText = layerRawText(layer);
        // 空状态：层缺数据或正文为空时给引导文案（编辑中除外，编辑态照常给文本框）。
        if ((!layer || rawText.trim() === "") && !isEditing) return renderEmptyLayer(kind, title);
        // revision 是 shiori-r1.<base64>.<sha256> 的长 token，直接铺在标题行会顶出屏幕：
        // 只显示前缀，完整值放 title 属性，需要时悬停看。
        var revisionText = layer && layer.revision !== undefined && layer.revision !== null ? "rev " + shortRev(layer.revision) : "";
        return h("div", { className: "dshi_card" },
          h("div", { className: "dshi_row" },
            h("span", { className: "dshi_cardTitle" }, title),
            revisionText ? h("span", { className: "dshi_badgeDim dshi_badge", title: "完整版本号：" + String(layer.revision) }, revisionText) : null,
            layer && layer.stale === true ? h("span", { className: "dshi_badge dshi_badgeWarn" }, "磁盘已被外部修改") : null,
            h("span", { style: { flex: 1 } }),
            isEditing
              ? h(fragment, null,
                h("button", { className: "dshi_btn dshi_btnPrimary", disabled: busy, onClick: save }, busy ? "保存中…" : "保存"),
                h("button", { className: "dshi_btn", disabled: busy, onClick: cancelEdit }, "取消"))
              : h("button", { className: "dshi_btn", onClick: function () { beginEdit(kind); } }, "编辑")),
          hint ? h("div", { className: "dshi_hint" }, hint) : null,
          isEditing
            ? h("textarea", {
                className: "dshi_textarea dshi_memEditor",
                value: draftFor(kind),
                onChange: function (event) {
                  var value = event && event.target ? event.target.value : "";
                  setDraft(function (prev) {
                    var next = Object.assign({}, prev);
                    next[kind] = value;
                    return next;
                  });
                }
              })
            : h("div", { className: "dshi_mdPreview" }, mdBlocks(rawText)));
      };

      return h("div", null,
        h("div", { className: "dshi_row", style: { marginBottom: 8 } },
          h("span", { className: "dshi_cardTitle" }, "记忆内容 L0 / L1"),
          h("button", { className: "dshi_btn", onClick: load }, "刷新")),
        ErrorBox(error),
        saveError ? ErrorBox(saveError) : null,
        saveError && saveError.code === "REVISION_CONFLICT"
          ? h("div", { className: "dshi_conflict" },
            "记忆已在别处更新，请重新加载后再改。你的草稿仍保留在编辑框里，点上方「刷新」取回最新版本后再保存，已输入的内容不会丢失。")
          : null,
        okText ? h("div", { className: "dshi_ok" }, okText) : null,
        view ? h(fragment, null,
          h("div", { className: "dshi_grid2" },
            Bar("人设卡 L0（UTF-16）", l0 && (l0.chars ?? l0.length ?? (l0.text ? l0.text.length : 0)), (budgets.persona && budgets.persona.maxChars) ?? 12000),
            Bar("记忆核心 L1（UTF-16）", l1 && (l1.chars ?? l1.length ?? (l1.text ? l1.text.length : 0)), (budgets.core && budgets.core.targetChars) ?? 8000)),
          renderLayer("l0", "人设卡（L0 persona）", l0,
            "每轮对话常驻的身份与规则。编辑后保存立即生效；上限由「预算配置」的人设卡最大字符数决定。"),
          renderLayer("l1", "记忆核心（L1 core）", l1,
            "上方预览是完整渲染结果（正文 + 派生主题索引）；点编辑后文本框里只有磁盘正文，主题索引由服务端自动生成，不用手写。保存带 revision 校验，若别处刚改过会提示冲突，刷新后重试。"),
          h("details", null,
            h("summary", { className: "dshi_hint" }, "完整 DTO"),
            h("pre", { className: "dshi_pre" }, stableStringify(view))))
        : null);
    }

    function normalizeGraph(value) {
      var nodes = [];
      var rawNodes = value && (value.nodes || value.cards || (value.graph && value.graph.nodes)) || [];
      if (!Array.isArray(rawNodes)) rawNodes = [];   // DTO 守卫：绝不把对象当数组遍历
      for (var i = 0; i < rawNodes.length; i++) {
        var raw = rawNodes[i];
        nodes.push({
          id: String(raw.id ?? raw.key ?? raw.cardId ?? i),
          title: String(raw.title ?? raw.key ?? raw.summary ?? raw.id ?? ("node-" + i)),
          vitality: String(raw.vitality ?? "ephemeral"),
          state: String(raw.state ?? "active"),
          revision: raw.revision,
          raw: raw
        });
      }
      var rawEdges = value && (value.edges || value.links || (value.graph && value.graph.edges)) || [];
      if (!Array.isArray(rawEdges)) rawEdges = [];   // DTO 守卫：同上
      var edges = [];
      for (var j = 0; j < rawEdges.length; j++) {
        var edge = rawEdges[j];
        var from = String(edge.from ?? edge.source ?? edge.a ?? "");
        var to = String(edge.to ?? edge.target ?? edge.b ?? "");
        if (from && to) edges.push({ from: from, to: to, rel: edge.rel ?? edge.kind });
      }
      return { nodes: nodes, edges: edges };
    }

    // getGraph 的节点 → { id: title }。候选页只拿到 64 位 hex id，
    // 用这张映射表把「是哪张卡」还原出来（拉不到就退化成短 id）。
    function titleMapOf(graph) {
      var normalized = normalizeGraph(graph);
      var map = {};
      for (var i = 0; i < normalized.nodes.length; i++) {
        var node = normalized.nodes[i];
        map[node.id] = node.title;
      }
      return map;
    }

    function GraphTab(props) {
      var state = useState(null);
      var graph = state[0];
      var setGraph = state[1];
      var errorState = useState(null);
      var error = errorState[0];
      var setError = errorState[1];
      var selectedState = useState(null);
      var selected = selectedState[0];
      var setSelected = selectedState[1];
      var viewState = useState({ x: 0, y: 0, k: 1 });
      var view = viewState[0];
      var setView = viewState[1];
      var dragRef = useRef(null);
      var wrapRef = useRef(null);
      // 滚轮缩放：以指针位置为锚点，缩放范围与按钮一致（0.3~3）。
      // React 的 onWheel 在部分宿主里被登记成 passive（preventDefault 无效、滚轮会连带
      // 滚动整个面板），所以这里挂原生 listener 并显式 passive:false。
      useEffect(function () {
        var element = wrapRef.current;
        if (!element || typeof element.addEventListener !== "function") return undefined;
        var onWheel = function (event) {
          if (event && typeof event.preventDefault === "function") event.preventDefault();
          var delta = Number(event && event.deltaY);
          if (!Number.isFinite(delta) || delta === 0) return;
          var factor = delta > 0 ? 1 / 1.12 : 1.12;
          var rect = typeof element.getBoundingClientRect === "function" ? element.getBoundingClientRect() : null;
          var clientX = Number(event && event.clientX);
          var clientY = Number(event && event.clientY);
          setView(function (prev) {
            var current = prev && Number.isFinite(prev.k) ? prev : { x: 0, y: 0, k: 1 };
            var nextK = Math.min(3, Math.max(0.3, current.k * factor));
            if (nextK === current.k) return current;
            // 锚点默认取画布中心；拿得到指针位置时换算到 viewBox 坐标（800×380）。
            var pivot = { x: 400, y: 190 };
            if (rect && rect.width > 0 && rect.height > 0 && Number.isFinite(clientX) && Number.isFinite(clientY)) {
              pivot = {
                x: (clientX - rect.left) * 800 / rect.width,
                y: (clientY - rect.top) * 380 / rect.height
              };
            }
            var ratio = nextK / current.k;
            return { x: pivot.x - (pivot.x - current.x) * ratio, y: pivot.y - (pivot.y - current.y) * ratio, k: nextK };
          });
        };
        element.addEventListener("wheel", onWheel, { passive: false });
        return function () {
          if (typeof element.removeEventListener === "function") element.removeEventListener("wheel", onWheel);
        };
      }, [graph]);
      var load = async function () {
        setError(null);
        try {
          setGraph(await props.dsh.call("getGraph", props.sessionId, {}));
        } catch (e) { setGraph(null); if (!reportSessionUnavailable(e, props, setError)) setError(e); }
      };
      useEffect(function () { load(); }, [props.sessionId]);
      var normalized = useMemo(function () { return graph ? normalizeGraph(graph) : { nodes: [], edges: [] }; }, [graph]);
      var layout = useMemo(function () {
        var positions = {};
        var count = normalized.nodes.length;
        for (var i = 0; i < count; i++) {
          var angle = (2 * Math.PI * i) / Math.max(1, count) - Math.PI / 2;
          positions[normalized.nodes[i].id] = { x: 400 + 260 * Math.cos(angle), y: 190 + 140 * Math.sin(angle) };
        }
        return positions;
      }, [normalized]);
      var onPointerDown = function (event) {
        dragRef.current = { startX: event.clientX, startY: event.clientY, originX: view.x, originY: view.y, moved: false };
      };
      var onPointerMove = function (event) {
        var drag = dragRef.current;
        if (!drag) return;
        var dx = event.clientX - drag.startX;
        var dy = event.clientY - drag.startY;
        if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
        setView({ x: drag.originX + dx, y: drag.originY + dy, k: view.k });
      };
      var onPointerUp = function () { dragRef.current = null; };
      var zoomBy = function (factor) {
        setView({ x: view.x, y: view.y, k: Math.min(3, Math.max(0.3, view.k * factor)) });
      };
      var nodeClass = function (node) {
        var base = node.state !== "active" ? "dshi_nodeDim" : node.vitality === "evergreen" ? "dshi_nodeEvergreen" : "dshi_nodeEphemeral";
        return base + (selected && selected.id === node.id ? " dshi_nodeSel" : "");
      };
      return h("div", { className: "dshi_card" },
        h("div", { className: "dshi_row" },
          h("span", { className: "dshi_cardTitle" }, "Spark 图谱（active）"),
          h("button", { className: "dshi_btn", onClick: load }, "刷新"),
          h("button", { className: "dshi_btn", onClick: function () { zoomBy(1.2); } }, "放大 +"),
          h("button", { className: "dshi_btn", onClick: function () { zoomBy(1 / 1.2); } }, "缩小 −"),
          h("button", { className: "dshi_btn", onClick: function () { setView({ x: 0, y: 0, k: 1 }); } }, "复位")),
        h("div", { className: "dshi_legend" },
          h("span", null, h("i", { className: "dshi_dot", style: { background: "var(--dsw-alias-state-success-primary,#1a7f37)" } }), "evergreen"),
          h("span", null, h("i", { className: "dshi_dot", style: { background: "var(--dsw-alias-state-business-primary,#3964fe)" } }), "ephemeral"),
          h("span", null, h("i", { className: "dshi_dot", style: { background: "var(--dsw-alias-label-tertiary,#8b93a1)" } }), "非 active"),
          h("span", { className: "dshi_hint" }, "滚轮缩放 / 拖拽平移 / 点击节点查看详情与编辑")),
        ErrorBox(error),
        normalized.nodes.length === 0 && !error ? h("div", { className: "dshi_loading" }, graph ? "当前 scope 无 active 卡" : "加载中…") : null,
        normalized.nodes.length > 0 ? h("div", {
          className: "dshi_graphWrap",
          ref: wrapRef,
          onPointerDown: onPointerDown,
          onPointerMove: onPointerMove,
          onPointerUp: onPointerUp,
          onPointerLeave: onPointerUp
        },
          h("svg", { className: "dshi_graphSvg", viewBox: "0 0 800 380" },
            h("g", { transform: "translate(" + view.x + "," + view.y + ") scale(" + view.k + ")" },
              normalized.edges.map(function (edge, index) {
                var from = layout[edge.from];
                var to = layout[edge.to];
                if (!from || !to) return null;
                return h("line", { key: "e" + index, className: "dshi_edge", x1: from.x, y1: from.y, x2: to.x, y2: to.y });
              }),
              normalized.nodes.map(function (node) {
                var position = layout[node.id] || { x: 400, y: 190 };
                return h("g", {
                  key: node.id,
                  className: "dshi_graphNode",
                  onPointerUp: function () {
                    if (dragRef.current && dragRef.current.moved) return;
                    setSelected(node);
                  }
                },
                  h("circle", { className: nodeClass(node), cx: position.x, cy: position.y, r: 14 }),
                  h("text", { className: "dshi_nodeLabel", x: position.x + 18, y: position.y + 4 }, node.title.slice(0, 24)));
              }))))
        : null,
        selected ? h(NodeDetail, { node: selected, nodes: normalized.nodes, edges: normalized.edges, dsh: props.dsh, sessionId: props.sessionId, onClose: function () { setSelected(null); }, onSaved: load }) : null);
    }

    var VITALITY_LABELS = { evergreen: "长期卡", ephemeral: "短期卡" };
    var STATE_LABELS = { active: "生效中", archived: "已归档", superseded: "已被替代" };

    // spark_read / spark_update 的 links 形状：[{ target, rel }]，target 是另一张卡的 id。
    function cardLinksOf(card) {
      var raw = card && card.links;
      if (!Array.isArray(raw)) return [];
      var out = [];
      for (var i = 0; i < raw.length; i++) {
        var item = raw[i];
        if (!item) continue;
        if (typeof item === "string") { out.push({ target: item, rel: null }); continue; }
        var target = String(item.target ?? item.id ?? "");
        if (!target) continue;
        out.push({ target: target, rel: item.rel === undefined ? null : item.rel });
      }
      return out;
    }

    function shortId(id) {
      var text = String(id ?? "");
      return text.length > 12 ? text.slice(0, 8) + "…" : text;
    }

    // revision token（shiori-r1.<base64>.<sha256>）动辄一百多字符；标题行只显示前缀，
    // 完整值放 title 属性。数字型 revision（如 spark 的 rev 1）原样返回。
    function shortRev(rev) {
      if (rev === undefined || rev === null) return "";
      var text = String(rev);
      return text.length > 16 ? text.slice(0, 12) + "…" : text;
    }

    // spark 卡片表单：triggers / entities 在工具里是字符串数组，面板里按「一行一条」编辑。
    function splitLines(text) {
      if (typeof text !== "string" || text === "") return [];
      var out = [];
      var rows = text.split(/\r?\n/);
      for (var i = 0; i < rows.length; i++) {
        var item = rows[i].trim();
        if (item !== "") out.push(item);
      }
      return out;
    }

    function formFromCard(card) {
      var source = card && typeof card === "object" ? card : {};
      return {
        title: typeof source.title === "string" ? source.title : "",
        summary: typeof source.summary === "string" ? source.summary : "",
        content: typeof source.content === "string" ? source.content : "",
        triggers: Array.isArray(source.triggers) ? source.triggers.join("\n") : "",
        entities: Array.isArray(source.entities) ? source.entities.join("\n") : "",
        vitality: typeof source.vitality === "string" && source.vitality ? source.vitality : "ephemeral"
      };
    }

    // 只把真正改过的字段放进 patch：未改动的字段不提交，避免把 null 摘要写成空串、或误触发其他校验。
    function cardFormPatch(card, form) {
      var source = card && typeof card === "object" ? card : {};
      var patch = {};
      var title = String(form.title || "").trim();
      if (title !== String(source.title ?? "")) patch.title = title;
      var summary = String(form.summary || "");
      if (summary !== String(source.summary ?? "")) patch.summary = summary;
      var content = String(form.content || "");
      if (content !== String(source.content ?? "")) patch.content = content;
      var triggers = splitLines(form.triggers);
      if (stableStringify(triggers) !== stableStringify(Array.isArray(source.triggers) ? source.triggers : [])) patch.triggers = triggers;
      var entities = splitLines(form.entities);
      if (stableStringify(entities) !== stableStringify(Array.isArray(source.entities) ? source.entities : [])) patch.entities = entities;
      var vitality = String(form.vitality || "");
      if (vitality !== String(source.vitality ?? "")) patch.vitality = vitality;
      return patch;
    }

    function NodeDetail(props) {
      var node = props.node;
      var allNodes = Array.isArray(props.nodes) ? props.nodes : [];
      // 卡片正文编辑（spark_update）：表单里全是字符串，保存时再按行拆成 triggers / entities 数组。
      var formState = useState(null);
      var form = formState[0];
      var setForm = formState[1];
      var formBusyState = useState(false);
      var formBusy = formBusyState[0];
      var setFormBusy = formBusyState[1];
      var formErrorState = useState(null);
      var formError = formErrorState[0];
      var setFormError = formErrorState[1];
      var formOkState = useState(null);
      var formOk = formOkState[0];
      var setFormOk = formOkState[1];
      // R7 追加：关联连线编辑。新 state 一律追加在既有 state 之后。
      var cardState = useState(null);
      var card = cardState[0];
      var setCard = cardState[1];
      var linkTargetState = useState("");
      var linkTarget = linkTargetState[0];
      var setLinkTarget = linkTargetState[1];
      var linkRelState = useState("");
      var linkRel = linkRelState[0];
      var setLinkRel = linkRelState[1];
      var linksBusyState = useState(false);
      var linksBusy = linksBusyState[0];
      var setLinksBusy = linksBusyState[1];
      var linksErrorState = useState(null);
      var linksError = linksErrorState[0];
      var setLinksError = linksErrorState[1];
      var linksOkState = useState(null);
      var linksOk = linksOkState[0];
      var setLinksOk = linksOkState[1];
      // 读取那一刻的连线快照：本地加了又删、或者手滑删错时，用它一键还原（不影响服务端已保存的值）。
      var pristineState = useState(null);
      var pristineLinks = pristineState[0];
      var setPristineLinks = pristineState[1];
      // 打开卡片就拉一次 spark_read：既拿到完整正文，也拿到现有 links 与最新 revision。
      // 必须先读再改——spark_update 的 patch.links 是整体替换，盲改会抹掉原有连线。
      var loadCard = async function () {
        setLinksBusy(true);
        setLinksError(null);
        setLinksOk(null);
        setFormError(null);
        setFormOk(null);
        try {
          var fresh = await props.dsh.call("executeTool", props.sessionId, { name: "spark_read", args: { id: node.id } });
          setCard(fresh);
          setPristineLinks(cardLinksOf(fresh));
          setForm(formFromCard(fresh));
        } catch (e) {
          setCard(null);
          setLinksError(e);
        } finally {
          setLinksBusy(false);
        }
      };
      useEffect(function () { loadCard(); }, [node.id]);
      var links = cardLinksOf(card);
      var titleOf = function (id) {
        for (var i = 0; i < allNodes.length; i++) if (allNodes[i].id === id) return allNodes[i].title;
        return null;
      };
      var addLink = function () {
        var target = String(linkTarget || "");
        if (!target) return;
        var duplicated = false;
        for (var i = 0; i < links.length; i++) if (links[i].target === target) duplicated = true;
        if (duplicated) return;
        var next = links.concat([{ target: target, rel: linkRel ? String(linkRel) : null }]);
        setCard(function (prev) {
          var base = prev && typeof prev === "object" ? prev : {};
          return assign({}, base, { links: next });
        });
        setLinkTarget("");
        setLinkRel("");
        setLinksOk(null);
      };
      var removeLink = function (target) {
        var next = links.filter(function (link) { return link.target !== target; });
        setCard(function (prev) {
          var base = prev && typeof prev === "object" ? prev : {};
          return assign({}, base, { links: next });
        });
        setLinksOk(null);
      };
      var saveLinks = async function () {
        if (!card) return;
        setLinksBusy(true);
        setLinksError(null);
        setLinksOk(null);
        try {
          var args = { id: node.id, patch: { links: links } };
          if (card.revision !== undefined && card.revision !== null) args.expectedRevision = card.revision;
          await props.dsh.call("executeTool", props.sessionId, { name: "spark_update", args: args });
          setLinksOk("连线已保存");
          if (typeof props.onSaved === "function") props.onSaved();
          await loadCard();
        } catch (e) {
          setLinksError(e);
        } finally {
          setLinksBusy(false);
        }
      };
      var linksDirty = card !== null && pristineLinks !== null && stableStringify(links) !== stableStringify(pristineLinks);
      // 误操作撤回：把本地连线还原成读取时的样子（服务端还没写入，丢掉草稿即可）。
      var undoLinks = function () {
        if (pristineLinks === null) return;
        setCard(function (prev) {
          var base = prev && typeof prev === "object" ? prev : {};
          return assign({}, base, { links: pristineLinks.slice() });
        });
        setLinksOk(null);
        setLinksError(null);
      };
      var updateField = function (key, value) {
        setForm(function (prev) {
          var base = prev && typeof prev === "object" ? prev : formFromCard(card);
          var next = assign({}, base);
          next[key] = value;
          return next;
        });
        setFormOk(null);
      };
      var saveForm = async function () {
        if (!card || !form) return;
        var patch = cardFormPatch(card, form);
        if (Object.keys(patch).length === 0) { setFormOk("内容没有改动"); return; }
        if (patch.title !== undefined && patch.title === "") { setFormError(new Error("标题不能为空：清空标题会被服务端拒绝")); return; }
        if (patch.content !== undefined && patch.content === "") { setFormError(new Error("正文不能为空：清空正文会被服务端拒绝")); return; }
        setFormBusy(true);
        setFormError(null);
        setFormOk(null);
        try {
          var saveArgs = { id: node.id, patch: patch };
          if (card.revision !== undefined && card.revision !== null) saveArgs.expectedRevision = card.revision;
          await props.dsh.call("executeTool", props.sessionId, { name: "spark_update", args: saveArgs });
          setFormOk("卡片已保存");
          if (typeof props.onSaved === "function") props.onSaved();
          await loadCard();
        } catch (e) {
          setFormError(e);
        } finally {
          setFormBusy(false);
        }
      };
      return h("div", { className: "dshi_card" },
        h("div", { className: "dshi_itemHead" },
          h("span", { className: "dshi_cardTitle" }, "卡片详情：" + node.title),
          h("span", { className: "dshi_badge" + (node.vitality === "evergreen" ? "" : "Dim") }, VITALITY_LABELS[node.vitality] || node.vitality),
          h("span", { className: "dshi_badgeDim dshi_badge" }, STATE_LABELS[node.state] || node.state),
          node.revision !== undefined ? h("span", { className: "dshi_mono" }, "rev " + String(node.revision)) : null,
          h("button", { className: "dshi_btn", onClick: props.onClose }, "关闭")),
        h("details", null,
          h("summary", { className: "dshi_hint" }, "原始节点数据"),
          h("pre", { className: "dshi_pre" }, stableStringify(node.raw))),

        // 关联连线：把这张卡和别的卡连起来，图谱上会画出来。
        h("div", { className: "dshi_card" },
          h("div", { className: "dshi_row" },
            h("span", { className: "dshi_cardTitle" }, "关联连线"),
            h("button", { className: "dshi_btn", disabled: linksBusy, onClick: loadCard }, linksBusy ? "读取中…" : "重新读取"),
            h("button", { className: "dshi_btn", disabled: linksBusy || !linksDirty, onClick: undoLinks }, linksDirty ? "撤销修改" : "没有未保存的改动"),
            h("span", { style: { flex: 1 } }),
            h("span", { className: "dshi_hint" }, linksDirty ? "有未保存的改动" : "与服务端一致")),
          h("div", { className: "dshi_hint" }, "「添加连线」「移除」都只是本地改动，点「保存连线」才写入服务端；删错了点「撤销修改」退回读取时的样子。"),
          ErrorBox(linksError),
          linksOk ? h("div", { className: "dshi_ok" }, linksOk) : null,
          card === null
            ? h("div", { className: "dshi_loading" }, linksBusy ? "正在读取这张卡的连线…" : "还没读到这张卡，点「重新读取」")
            : (links.length === 0
              ? h("div", { className: "dshi_hint" }, "这张卡还没有连线。")
              : h("div", { className: "dshi_items" }, links.map(function (link) {
                  var title = titleOf(link.target);
                  return h("div", { key: link.target, className: "dshi_item" },
                    h("div", { className: "dshi_itemHead" },
                      h("span", null, title || ("（图谱里没有这张卡）")),
                      link.rel ? h("span", { className: "dshi_badgeDim dshi_badge" }, String(link.rel)) : null,
                      h("span", { className: "dshi_mono" }, shortId(link.target)),
                      h("span", { style: { flex: 1 } }),
                      h("button", { className: "dshi_btn dshi_btnDanger", onClick: function () { removeLink(link.target); } }, "移除")));
                }))),
          card === null ? null : h("div", { className: "dshi_row" },
            h("select", {
              className: "dshi_select",
              value: linkTarget,
              onChange: function (event) { setLinkTarget(event.target.value); }
            },
              h("option", { value: "" }, "— 选择要连到的卡 —"),
              allNodes.filter(function (item) { return item.id !== node.id; }).map(function (item) {
                return h("option", { key: item.id, value: item.id }, item.title + "（" + shortId(item.id) + "）");
              })),
            h("input", {
              className: "dshi_input",
              placeholder: "关系名（可空，如 related）",
              value: linkRel,
              onChange: function (event) { setLinkRel(event.target.value); }
            }),
            h("button", { className: "dshi_btn", disabled: !linkTarget, onClick: addLink }, "添加连线"),
            h("button", { className: "dshi_btn dshi_btnPrimary", disabled: linksBusy || !card, onClick: saveLinks }, linksBusy ? "保存中…" : "保存连线"))),

        // 卡片内容：只改 spark 卡片本身。人设卡 / 记忆核心在「记忆 L0/L1」页，
        // 主题在「L3/topic 记忆管理」页——这里不再混进那四个记忆工具。
        h("div", { className: "dshi_card" },
          h("div", { className: "dshi_row" },
            h("span", { className: "dshi_cardTitle" }, "卡片内容"),
            formOk ? h("span", { className: "dshi_ok" }, formOk) : null,
            h("span", { style: { flex: 1 } }),
            h("button", { className: "dshi_btn dshi_btnPrimary", disabled: formBusy || !form || !card, onClick: saveForm }, formBusy ? "保存中…" : "保存卡片")),
          ErrorBox(formError),
          form === null
            ? h("div", { className: "dshi_loading" }, linksBusy ? "正在读取卡片…" : "还没读到卡片，点上方「重新读取」")
            : h(fragment, null,
                h("label", { className: "dshi_label" }, "标题",
                  h("input", { className: "dshi_input", value: form.title, onChange: function (event) { updateField("title", event.target.value); } })),
                h("label", { className: "dshi_label" }, "摘要（一行，可空）",
                  h("input", { className: "dshi_input", value: form.summary, onChange: function (event) { updateField("summary", event.target.value); } })),
                h("label", { className: "dshi_label" }, "正文",
                  h("textarea", { className: "dshi_textarea", style: { minHeight: 160 }, value: form.content, onChange: function (event) { updateField("content", event.target.value); } })),
                h("div", { className: "dshi_grid2" },
                  h("label", { className: "dshi_label" }, "触发词（一行一条）",
                    h("textarea", { className: "dshi_textarea", style: { minHeight: 70 }, value: form.triggers, onChange: function (event) { updateField("triggers", event.target.value); } })),
                  h("label", { className: "dshi_label" }, "实体（一行一条）",
                    h("textarea", { className: "dshi_textarea", style: { minHeight: 70 }, value: form.entities, onChange: function (event) { updateField("entities", event.target.value); } }))),
                h("label", { className: "dshi_label" }, "重要度",
                  h("select", { className: "dshi_select", value: form.vitality, onChange: function (event) { updateField("vitality", event.target.value); } },
                    form.vitality !== "evergreen" && form.vitality !== "ephemeral"
                      ? h("option", { value: form.vitality }, VITALITY_LABELS[form.vitality] || form.vitality)
                      : null,
                    h("option", { value: "evergreen" }, "长期卡（evergreen）"),
                    h("option", { value: "ephemeral" }, "短期卡（ephemeral）"))),
                h("div", { className: "dshi_hint" }, "保存走版本校验：别处刚改过这张卡会提示冲突，点「重新读取」再改。人设卡 / 记忆核心在「记忆 L0/L1」页改，主题在「L3/topic 记忆管理」页改。"))));
    }

    // ── Q-A：cluster 候选「合并进主题」辅助 ──────────────────────────────────
    // revision token：executeTool memory_list_topics / memory_read 返回
    // `shiori-r1.<base64url>.<sha256>`（src/service/index.mjs tokenFor/parseToken）。
    // legacy 主题只读（updated === "legacy-unknown"，服务端拒 UNSUPPORTED），必须过滤。
    var LEGACY_TOPIC_UPDATED = "legacy-unknown";
    function isLegacyTopicRow(row) {
      if (!row || typeof row !== "object") return true;
      return String(row.updated) === LEGACY_TOPIC_UPDATED;
    }
    function topicRevisionPrefix(token) {
      var text = String(token ?? "");
      return text.length > 28 ? text.slice(0, 28) + "…" : text;
    }
    // 合并正文默认草稿：候选 evidence（sharedTerm/field）+ 源卡 id 清单；用户可编辑。
    // 服务端会在 after 末尾自动追加 shiori-p3-sources 源保全块（queue.mjs buildMergeTopicDraft）。
    function mergeBodyDraft(candidate) {
      var evidence = candidate && typeof candidate.evidence === "object" && candidate.evidence ? candidate.evidence : {};
      var term = typeof evidence.sharedTerm === "string" && evidence.sharedTerm
        ? evidence.sharedTerm
        : (typeof evidence.field === "string" && evidence.field ? evidence.field : "合并记忆");
      var ids = Array.isArray(candidate && candidate.sources)
        ? candidate.sources.map(function (s) { return String(s && s.id); }).filter(Boolean) : [];
      return "\n\n## 合并记忆：" + term + "\n\n本节由面板合并流程生成，收录 " + ids.length + " 张关联记忆卡（" + ids.join(", ") + "）。请按需编辑正文。\n";
    }
    // 发送前的轻量预检（服务端 buildMergeTopicDraft / validatePlanTopic 仍是权威）：
    // 只拦 UI 能明确给出人话的常见错误，避免用户吃裸 INVALID_INPUT。
    function validateMergeFormLocal(form) {
      if (!form || typeof form !== "object") return "合并表单未初始化。";
      if (!String(form.key || "")) return "缺少目标主题 key。";
      if (!String(form.expectedRevision || "")) return "缺少主题 revision token（请重新拉取主题列表）。";
      if (!String(form.title || "").trim()) return "标题不能为空。";
      var summary = String(form.summary ?? "");
      if (summary.includes("\n") || summary.includes("\r")) return "摘要必须单行（不得含换行）。";
      if (summary.length > 60) return "摘要过长（最多 60 字符，当前 " + summary.length + "）。";
      var before = String(form.before ?? "");
      var after = String(form.after ?? "");
      if (!after.startsWith(before)) return "合并后正文必须保留原正文（append-only）：after 必须以 before 开头。";
      if (after.length === before.length) return "合并后正文与原正文相同（没有任何变化），服务端会拒绝。";
      return null;
    }
    // Q-B：候选/计划脏数据的人话错误（保留原 code，便于排查）。
    function candidateActionError(error) {
      var code = error && error.code ? String(error.code) : "";
      var detail = (error && error.message) || String(error);
      if (code === "NOT_FOUND") {
        return { code: code, message: "该候选或计划已过期：源卡可能已被合并 / 归档，或计划已不存在。请点「刷新」重新分析后再试。（原始信息：" + detail + "）" };
      }
      if (code === "INVALID_INPUT") {
        return { code: code, message: "服务端拒绝了这次操作：数据可能已过期（请点「刷新」重新分析），或参数未通过服务端校验。（原始信息：" + detail + "）" };
      }
      if (code === "REVISION_CONFLICT") {
        return { code: code, message: "revision 冲突：该计划可能已被执行，或主题 / 队列在此期间被修改。请刷新后重新预览，不要重试旧预览。（原始信息：" + detail + "）" };
      }
      if (code === "UNSUPPORTED") {
        return { code: code, message: "服务端不支持该操作（例如 legacy 主题只读，不能作为合并目标）。（原始信息：" + detail + "）" };
      }
      return error;
    }
    // 真机 queueDto：items[i] = { candidate: {id, kind, scopeId, sources, evidence}, status }
    // （src/organize/queue.mjs item 结构 / src/plugin/management.mjs queueDto）。候选的
    // id / kind / sources / evidence 都在 item.candidate 里，不在 item 上。旧扁平形状
    // （{candidateId|id, kind, …}）仅作兼容读取；两者皆缺时返回 null，由调用方保证
    // 下标只用作渲染 key，绝不当业务 id 发 RPC。
    function queueItemCandidate(item) {
      if (!item || typeof item !== "object") return null;
      var nested = item.candidate && typeof item.candidate === "object" ? item.candidate : null;
      if (nested) return nested;
      var flatId = item.candidateId !== undefined && item.candidateId !== null
        ? item.candidateId
        : (item.id !== undefined && item.id !== null ? item.id : null);
      if (flatId === null) return null;
      return { id: flatId, kind: item.kind, sources: item.sources, evidence: item.evidence };
    }
    // 界面文案映射（只影响显示；协议字段与状态字面量一律不变：
    // doReview 仍发 "reviewed" / "dismissed"，previewPlan 的 kind 仍是 organize / forgetting）。
    // 未知 kind / status 保留原文，绝不吞掉服务端新增的分类。
    var CANDIDATE_KIND_LABELS = { cluster: "集群", isolated: "孤立卡", link: "可建链接" };
    var CANDIDATE_STATUS_LABELS = { pending: "待处理", reviewed: "已阅", dismissed: "已忽略" };
    var PLAN_STATE_LABELS = { open: "待执行", executed: "已执行", superseded: "已作废" };
    var PLAN_KIND_LABELS = { organize: "整理", forgetting: "遗忘" };
    function candidateKindLabel(kind) {
      var text = String(kind ?? "");
      return CANDIDATE_KIND_LABELS[text] ?? text;
    }
    function candidateStatusLabel(status) {
      var text = String(status ?? "");
      return CANDIDATE_STATUS_LABELS[text] ?? text;
    }
    function planStateLabel(state) {
      return PLAN_STATE_LABELS[state] ?? String(state);
    }
    function planKindLabel(kind) {
      var text = String(kind ?? "");
      return PLAN_KIND_LABELS[text] ?? text;
    }
    // Q-B：preview organize 发送前的本地校验（服务端 protocol.mjs organizeProposal
    // 仍是权威）：拦下必然失败的死 payload（如空 links），给出中文指引，
    // 不把注定 INVALID_INPUT 的请求交给服务端。形状按协议 additionalProperties:false
    // 加严：多余键、rel 类型、link/merge-topic 键集齐全都本地拦下。
    function validateOrganizeProposalLocal(proposal) {
      if (!proposal || typeof proposal !== "object" || Array.isArray(proposal)) {
        return "proposal 必须是 JSON 对象。";
      }
      if (proposal.kind !== "link" && proposal.kind !== "merge-topic") {
        return "proposal.kind 必须是 link / merge-topic（当前 " + JSON.stringify(proposal.kind ?? null) + "）。cluster 候选可直接用「合并进主题」自动构造。";
      }
      if (proposal.kind === "link") {
        var linkExtra = Object.keys(proposal).filter(function (k) { return k !== "kind" && k !== "links"; });
        if (linkExtra.length > 0) return "proposal.link 存在多余键：" + linkExtra.join(", ") + "（协议只允许 kind / links）。";
        if (!Array.isArray(proposal.links) || proposal.links.length === 0) {
          return "proposal.link.links 至少需要 1 项：请先补 link 项，或改用 cluster 候选的「合并进主题」流程。";
        }
        for (var i = 0; i < proposal.links.length; i++) {
          var link = proposal.links[i];
          if (!link || typeof link !== "object" || Array.isArray(link)) {
            return "proposal.links[" + i + "] 必须是对象（{ id, after }）。";
          }
          var entryExtra = Object.keys(link).filter(function (k) { return k !== "id" && k !== "after"; });
          if (entryExtra.length > 0) return "proposal.links[" + i + "] 存在多余键：" + entryExtra.join(", ") + "（协议只允许 id / after）。";
          if (!String(link.id ?? "")) return "proposal.links[" + i + "].id 不能为空。";
          if (!Array.isArray(link.after) || link.after.length === 0) {
            return "proposal.links[" + i + "].after 至少需要 1 项（{ target, rel }）。";
          }
          for (var j = 0; j < link.after.length; j++) {
            var edge = link.after[j];
            if (!edge || typeof edge !== "object" || Array.isArray(edge)) {
              return "proposal.links[" + i + "].after[" + j + "] 必须是对象（{ target, rel }）。";
            }
            var edgeExtra = Object.keys(edge).filter(function (k) { return k !== "target" && k !== "rel"; });
            if (edgeExtra.length > 0) return "proposal.links[" + i + "].after[" + j + "] 存在多余键：" + edgeExtra.join(", ") + "（协议只允许 target / rel）。";
            if (!String(edge.target ?? "")) return "proposal.links[" + i + "].after[" + j + "].target 不能为空。";
            if (edge.rel !== undefined && edge.rel !== null && typeof edge.rel !== "string") {
              return "proposal.links[" + i + "].after[" + j + "].rel 必须是字符串或 null。";
            }
          }
        }
      }
      if (proposal.kind === "merge-topic") {
        var topicExtra = Object.keys(proposal).filter(function (k) { return k !== "kind" && k !== "topic"; });
        if (topicExtra.length > 0) return "proposal.merge-topic 存在多余键：" + topicExtra.join(", ") + "（协议只允许 kind / topic）。";
        var topic = proposal.topic;
        if (!topic || typeof topic !== "object" || Array.isArray(topic)) {
          return "proposal.merge-topic 必须带 topic 对象（7 键：key/expectedRevision/before/after/title/summary/updated）。";
        }
        var TOPIC_KEYS = ["key", "expectedRevision", "before", "after", "title", "summary", "updated"];
        var missing = TOPIC_KEYS.filter(function (k) { return !Object.prototype.hasOwnProperty.call(topic, k); });
        if (missing.length > 0) return "proposal.topic 缺少键：" + missing.join(", ") + "（7 键缺一不可）。";
        var topicOnlyExtra = Object.keys(topic).filter(function (k) { return TOPIC_KEYS.indexOf(k) === -1; });
        if (topicOnlyExtra.length > 0) return "proposal.topic 存在多余键：" + topicOnlyExtra.join(", ") + "。";
        if (!String(topic.key ?? "")) return "proposal.topic.key 不能为空。";
        if (!String(topic.title ?? "")) return "proposal.topic.title 不能为空。";
        if (topic.expectedRevision !== null && typeof topic.expectedRevision !== "string") {
          return "proposal.topic.expectedRevision 必须是字符串或 null（服务端签发的 token）。";
        }
        if (!String(topic.after ?? "").startsWith(String(topic.before ?? ""))) {
          return "proposal.topic.after 必须保留 before 全文（append-only）。";
        }
      }
      return null;
    }
    // B-Q2：按候选 kind 预填可提交的 proposal 骨架（带候选真实源卡 id）。
    // cluster 候选不预填——merge-topic 需要服务端签发的 revision token，
    // 文本框手写必然失败，应走「合并进主题」一键流程。
    function proposalSkeleton(candidate) {
      var sources = candidate && Array.isArray(candidate.sources) ? candidate.sources : [];
      var first = sources[0] && sources[0].id ? String(sources[0].id) : "<源卡 id>";
      var second = sources[1] && sources[1].id ? String(sources[1].id) : "<另一张卡 id>";
      return JSON.stringify({ kind: "link", links: [{ id: first, after: [{ target: second, rel: "related" }] }] }, null, 2);
    }

    function CandidatesTab(props) {
      var state = useState(null);
      var data = state[0];
      var setData = state[1];
      var errorState = useState(null);
      var error = errorState[0];
      var setError = errorState[1];
      var busyState = useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];
      // B-Q2：默认留空——必红死值（空 links）等于换个地方红；点「preview organize」
      // 时按候选 kind 预填可用骨架（带真实源卡 id）或指引走合并流程。
      var proposalState = useState("");
      var proposal = proposalState[0];
      var setProposal = proposalState[1];
      // R4（owner review）：preview 以 { sessionId, plan } 钉住来源会话；跨会话
      // 渲染与确认执行前都校验，不一致即拒绝，杜绝「A 会话预览在 B 会话执行」。
      var previewState = useState(null);
      var preview = previewState[0];
      var setPreview = previewState[1];
      var previewErrorState = useState(null);
      var previewError = previewErrorState[0];
      var setPreviewError = previewErrorState[1];
      // 会话/代际守卫 holder（状态对象跨渲染持久，充当 ref 使用）：props.sessionId
      // 变化时 gen+1 使一切在途异步结果作废，并清空会话绑定状态。
      var guardState = useState({ sessionId: props.sessionId, gen: 0 });
      var sessionGuard = guardState[0];
      // ── Q-A：合并进主题流程（新增 hook 全部排在既有 7 个之后，老测试的
      // states[0..6] 布局不变）──────────────────────────────────────────────
      // merge：当前走合并流程的候选 { candidateId }；topics：主题列表
      // { loading, error, topics, total }；mergeForm：合并表单；newTopic：新建主题表单。
      var mergeState = useState(null);
      var merge = mergeState[0];
      var setMerge = mergeState[1];
      var topicsState = useState(null);
      var topics = topicsState[0];
      var setTopics = topicsState[1];
      var mergeFormState = useState(null);
      var mergeForm = mergeFormState[0];
      var setMergeForm = mergeFormState[1];
      var newTopicState = useState({ topic: "", title: "", summary: "", busy: false, error: null });
      var newTopic = newTopicState[0];
      var setNewTopic = newTopicState[1];
      // R7 追加：候选卡片 id → 标题映射（拉不到图谱时保持空对象，行内退化成短 id）。
      var titlesState = useState({});
      var titles = titlesState[0];
      var setTitles = titlesState[1];

      var mark = function () {
        return { sessionId: props.sessionId, gen: sessionGuard.gen };
      };
      var isStale = function (origin) {
        return sessionGuard.sessionId !== origin.sessionId || sessionGuard.gen !== origin.gen;
      };

      useEffect(function () {
        if (sessionGuard.sessionId !== props.sessionId) {
          sessionGuard.sessionId = props.sessionId;
          sessionGuard.gen += 1;
          setData(null);
          setPreview(null);
          setPreviewError(null);
          setError(null);
          setBusy(false);
          // Q-A：合并流程是会话绑定的（主题列表 / 表单 / revision token 都按 scope 解析）
          setMerge(null);
          setTopics(null);
          setMergeForm(null);
        }
      }, [props.sessionId]);

      var queueRevision = data && typeof data.queueRevision === "number" ? data.queueRevision : null;
      // R3（owner review）：数据未加载（queueRevision 未知）前禁用全部写动作，
      // 而不是发送 expectedQueueRevision: undefined。
      var loaded = queueRevision !== null;
      // DTO 守卫：items / plans 只按数组渲染（对象形态不调 .length/.map）。
      var items = Array.isArray(data && data.items) ? data.items : [];
      var plans = Array.isArray(data && data.plans) ? data.plans : [];

      var load = async function () {
        var origin = mark();
        setError(null);
        setPreview(null);
        setPreviewError(null);
        try {
          var result = await props.dsh.call("listCandidates", props.sessionId, {});
          if (isStale(origin)) return;
          setData(result);
        } catch (e) {
          if (isStale(origin)) return;
          setData(null);
          if (!reportSessionUnavailable(e, props, setError)) setError(e);
        }
        // 候选条目里只有 id（digest），没有卡片标题。顺手拉一次图谱建 id→标题映射，
        // 让每行看得出「是哪张卡」；图谱拉取失败不影响候选本身。
        try {
          var graph = await props.dsh.call("getGraph", props.sessionId, {});
          if (isStale(origin)) return;
          setTitles(titleMapOf(graph));
        } catch (e) {
          if (isStale(origin)) return;
          setTitles({});
        }
      };
      useEffect(function () { load(); }, [props.sessionId]);

      var guard = async function (action) {
        var origin = mark();
        setBusy(true);
        setError(null);
        try {
          await action();
          await load();
        } catch (e) {
          // Q-B：候选/计划脏数据给具体人话提示（保留原 code），不只显示原始 code
          if (!isStale(origin) && !reportSessionUnavailable(e, props, setError)) setError(candidateActionError(e));
        } finally {
          setBusy(false);
        }
      };

      // R3：expectedQueueRevision 仅在已加载时附带；绝不发送 undefined 值字段
      //（宿主 isRemoteJsonValue 拒绝非无损 JSON）。
      var withRevision = function (payload) {
        if (queueRevision !== null) payload.expectedQueueRevision = queueRevision;
        return payload;
      };

      var doAnalyze = function (kind) {
        var origin = mark();
        return guard(async function () {
          var result = await props.dsh.call("analyze", props.sessionId, withRevision({ kind: kind, operationId: newId() }));
          if (!isStale(origin)) setData(result);
        });
      };
      var doReview = function (candidateId, decision) {
        var origin = mark();
        return guard(async function () {
          var result = await props.dsh.call("reviewCandidate", props.sessionId, withRevision({ candidateId: candidateId, decision: decision, operationId: newId() }));
          if (!isStale(origin)) setData(result);
        });
      };
      var guardPreview = async function (action) {
        setBusy(true);
        setError(null);
        try {
          await action();
        } catch (e) {
          setPreview(null);
          if (!reportSessionUnavailable(e, props, setError)) setError(candidateActionError(e));
        } finally {
          setBusy(false);
        }
      };
      var doPreviewOrganize = function (candidateId) {
        // B-Q2：空 proposal（默认态）不发送——按候选 kind 预填：link 候选给带真实
        // 源卡 id 的骨架；cluster 候选指引走「合并进主题」（merge-topic 需服务端
        // 签发的 revision token，文本框手写必然失败）。
        var candidate = null;
        for (var i = 0; i < items.length; i++) {
          var c = queueItemCandidate(items[i]);
          if (c && c.id !== undefined && c.id !== null && String(c.id) === String(candidateId)) {
            candidate = c;
            break;
          }
        }
        var text = String(proposal ?? "");
        if (text.trim() === "") {
          setPreview(null);
          if (candidate && String(candidate.kind) === "cluster") {
            setPreviewError({ code: "ui/use-merge-flow", message: "cluster 候选请使用「合并进主题」一键流程（自动选/建主题并带服务端签发的 revision token）；手动 merge-topic 需要真实 token，不在文本框手写。" });
            return;
          }
          setProposal(proposalSkeleton(candidate));
          setPreviewError({ code: "ui/proposal-prefilled", message: "已按该候选预填 link 骨架（源卡 id 来自候选）。请确认 target 是另一张真实卡 id 后，再点「preview organize」发送。" });
          return;
        }
        var parsed;
        try {
          parsed = JSON.parse(text);
        } catch (e) {
          setPreview(null);
          setPreviewError({ code: "ui/invalid-json", message: "proposal JSON 解析失败：" + e.message });
          return;
        }
        // Q-B：死 payload（如空 links）在本地拦下，不发必然失败的 RPC。
        var problem = validateOrganizeProposalLocal(parsed);
        if (problem) {
          setPreview(null);
          setPreviewError({ code: "ui/invalid-proposal", message: problem });
          return;
        }
        setPreviewError(null);
        var origin = mark();
        guardPreview(async function () {
          var result = await props.dsh.call("previewPlan", props.sessionId, withRevision({ kind: "organize", candidateId: candidateId, proposal: parsed, operationId: newId() }));
          if (isStale(origin)) return;
          setPreview({ sessionId: props.sessionId, plan: result });
        });
      };
      var doPreviewForgetting = function (planId) {
        setPreviewError(null);
        var origin = mark();
        guardPreview(async function () {
          var result = await props.dsh.call("previewPlan", props.sessionId, { kind: "forgetting", planId: planId });
          if (isStale(origin)) return;
          setPreview({ sessionId: props.sessionId, plan: result });
        });
      };
      // R4：确认执行前校验 preview 钉住的来源会话与当前会话一致，不一致拒绝发送
      // RPC（服务端 P 仍须独立校验 trusted session / plan / digest 绑定）。
      // Q-B：preview 同时钉定生成时的 queueRevision——刷新 / analyze 后队列前进，
      // 旧 preview 的 planDigest 对新队列不再可信，拒绝拿旧 preview 去 execute。
      var doExecute = function () {
        if (!preview || preview.sessionId !== props.sessionId) {
          setError({ code: "shiori/ui-stale-preview", message: "预览已过期（来源会话与当前会话不一致），请重新生成预览后再执行。" });
          return Promise.resolve();
        }
        if (preview.queueRevision !== undefined && preview.queueRevision !== null
          && queueRevision !== null && preview.queueRevision !== queueRevision) {
          setError({ code: "shiori/ui-stale-preview", message: "队列已变化（预览基于 revision " + preview.queueRevision + "，当前 " + queueRevision + "），旧预览已失效，请重新预览后再执行。" });
          return Promise.resolve();
        }
        var plan = preview.plan;
        return guard(async function () {
          await props.dsh.call("executePlan", props.sessionId, { planId: plan.planId, planDigest: plan.planDigest, operationId: newId(), confirmed: true });
          // 执行成功：收起合并流程（guard 随后 load() 刷新队列 revision / 候选 / 计划；
          // 图谱与记忆 L1 视图在切到对应 tab 时按会话重新拉取）。
          setMerge(null);
          setMergeForm(null);
        });
      };
      var actionsDisabled = busy || !loaded;

      // ── Q-A：cluster 候选「合并进主题」流程 ────────────────────────────────
      // 全部 RPC 经 props.dsh.call（ctx.get('remote.shiori')）；会话级失败沿用
      // reportSessionUnavailable（面板层缓存，不刷 tab 红字）。
      var loadTopics = function () {
        var origin = mark();
        setTopics({ loading: true, error: null, topics: [], total: 0 });
        props.dsh.call("executeTool", props.sessionId, { name: "memory_list_topics", args: {} }).then(function (result) {
          if (isStale(origin)) return;
          var rows = Array.isArray(result && result.topics) ? result.topics : [];
          setTopics({ loading: false, error: null, topics: rows.filter(function (t) { return !isLegacyTopicRow(t); }), total: rows.length });
        }, function (e) {
          if (isStale(origin)) return;
          setTopics({ loading: false, error: candidateActionError(e), topics: [], total: 0 });
        });
      };
      var openMerge = function (candidateId) {
        setMerge({ candidateId: String(candidateId) });
        setMergeForm(null);
        setPreviewError(null);
        loadTopics();
      };
      var closeMerge = function () {
        setMerge(null);
        setMergeForm(null);
        setNewTopic({ topic: "", title: "", summary: "", busy: false, error: null });
      };
      // 选中主题：memory_read 拿当前正文（before）与服务端权威 revision token。
      // before 绝不传空串——执行端以 plan.topic.after 整体替换正文（executor 锁内
      // 重读 after 一致性校验），空 before 会截断既有正文。
      var openTopicForMerge = function (row) {
        if (!merge) return;
        var origin = mark();
        var key = String(row && row.key);
        setNewTopic({ topic: "", title: "", summary: "", busy: false, error: null });
        props.dsh.call("executeTool", props.sessionId, { name: "memory_read", args: { topic: key } }).then(function (result) {
          if (isStale(origin)) return;
          var before = result && typeof result.content === "string" ? result.content : "";
          var token = result && typeof result.revision === "string" && result.revision
            ? result.revision
            : (row && typeof row.revision === "string" ? row.revision : "");
          var candidate = null;
          for (var i = 0; i < items.length; i++) {
            var c = queueItemCandidate(items[i]);
            if (c && c.id !== undefined && c.id !== null && String(c.id) === merge.candidateId) {
              candidate = c;
              break;
            }
          }
          if (candidate === null) candidate = {};
          setMergeForm({
            key: key,
            expectedRevision: token,
            tokenSource: result && result.revision ? "memory_read" : "memory_list_topics",
            before: before,
            after: before + mergeBodyDraft(candidate),
            title: String((row && row.title) ?? ""),
            summary: String((row && row.summary) ?? "").split("\n")[0].slice(0, 60),
            updated: new Date().toISOString()
          });
        }, function (e) {
          if (isStale(origin)) return;
          setTopics({ loading: false, error: candidateActionError(e), topics: topics ? topics.topics : [], total: topics ? topics.total : 0 });
        });
      };
      // 新建主题：topic_create 成功后重新 memory_list_topics 取服务端权威 token，
      // 再自动进入合并表单（不猜 token 形状）。
      var submitNewTopic = function () {
        if (!merge) return;
        var key = String(newTopic.topic || "").trim();
        var title = String(newTopic.title || "").trim();
        var summary = String(newTopic.summary || "").trim();
        if (!key || !title || !summary) {
          setNewTopic({ topic: newTopic.topic, title: newTopic.title, summary: newTopic.summary, busy: false, error: { code: "ui/invalid-topic", message: "key / 标题 / 摘要 都必填。" } });
          return;
        }
        if (summary.includes("\n") || summary.includes("\r") || summary.length > 60) {
          setNewTopic({ topic: newTopic.topic, title: newTopic.title, summary: newTopic.summary, busy: false, error: { code: "ui/invalid-topic", message: "摘要必须单行且不超过 60 字符。" } });
          return;
        }
        var origin = mark();
        setNewTopic({ topic: key, title: title, summary: summary, busy: true, error: null });
        props.dsh.call("executeTool", props.sessionId, { name: "topic_create", args: { topic: key, title: title, summary: summary, operationId: newId() } }).then(function () {
          return props.dsh.call("executeTool", props.sessionId, { name: "memory_list_topics", args: {} });
        }).then(function (listing) {
          if (isStale(origin)) return;
          var rows = Array.isArray(listing && listing.topics) ? listing.topics : [];
          var usable = rows.filter(function (t) { return !isLegacyTopicRow(t); });
          setTopics({ loading: false, error: null, topics: usable, total: rows.length });
          setNewTopic({ topic: "", title: "", summary: "", busy: false, error: null });
          var fresh = usable.find(function (t) { return String(t && t.key) === key; });
          if (!fresh) {
            setNewTopic({ topic: key, title: title, summary: summary, busy: false, error: { code: "shiori/ui-topic-missing", message: "主题已创建，但未能在主题列表中找到它（" + key + "）；请刷新主题列表后手动选择。" } });
            return;
          }
          openTopicForMerge(fresh);
        }, function (e) {
          if (isStale(origin)) return;
          setNewTopic({ topic: key, title: title, summary: summary, busy: false, error: candidateActionError(e) });
        });
      };
      // 合并预览：自动构造 merge-topic proposal（7 键），带 candidateId +
      // expectedQueueRevision + operationId 走 previewPlan；diff 由既有 preview 卡渲染。
      var doMergePreview = function () {
        if (!merge || !mergeForm) return;
        var form = mergeForm;
        var problem = validateMergeFormLocal(form);
        if (problem) {
          setPreview(null);
          setPreviewError({ code: "ui/invalid-proposal", message: problem });
          return;
        }
        setPreviewError(null);
        var origin = mark();
        guardPreview(async function () {
          var proposal = { kind: "merge-topic", topic: { key: form.key, expectedRevision: form.expectedRevision, before: form.before, after: form.after, title: form.title, summary: form.summary, updated: form.updated } };
          var result = await props.dsh.call("previewPlan", props.sessionId, withRevision({ kind: "organize", candidateId: merge.candidateId, proposal: proposal, operationId: newId() }));
          if (isStale(origin)) return;
          setPreview({ sessionId: props.sessionId, plan: result, queueRevision: queueRevision });
        });
      };
      var updateMergeForm = function (patch) {
        setMergeForm(mergeForm ? assign({}, mergeForm, patch) : mergeForm);
      };
      var updateNewTopic = function (patch) {
        setNewTopic(assign({}, newTopic, patch));
      };
      // Q-A 合并卡渲染器：内容 / 三步状态机与原实现逐行一致，仅把卡片从「候选卡之后」
      // 搬到被点击候选行的正下方（同一 dshi_items 容器内就地展开），避免按钮在列表中间、
      // 控件在页面底部。候选 id 只显示前 8 位，完整 id 放 title。
      var renderMergeCard = function (candidateId) {
        var fullId = String(candidateId);
        var shortId = fullId.slice(0, 8) + "…";
        return h("div", { key: "merge-" + fullId, className: "dshi_itemMerge", style: { minWidth: 0 } },
          h("div", { className: "dshi_card", style: { marginLeft: 12 } },
            h("div", { className: "dshi_row" },
              h("span", { className: "dshi_cardTitle", title: "候选完整 id：" + fullId }, "合并进主题（候选 " + shortId + "）"),
              h("button", { className: "dshi_btn", disabled: topics !== null && topics.loading, onClick: loadTopics }, "刷新主题"),
              h("button", { className: "dshi_btn", onClick: closeMerge }, "收起")),
            // 步骤引导（纯展示）：① 选目标主题 → ② 载入 before/token 出合并表单 → ③ after → 预览 diff → 确认执行。
            // mergeForm 为空时 ① 标「进行中」（主色 badge），其余 dim；不改任何 RPC / 状态机逻辑。
            h("div", { className: "dshi_hint" }, "合并流程（3 步，按当前进度高亮）："),
            h("div", { className: "dshi_items" },
              h("div", { className: "dshi_row" },
                h("span", { className: mergeForm ? "dshi_badgeDim dshi_badge" : "dshi_badge" }, mergeForm ? "① 已完成" : "① 进行中"),
                h("span", { className: "dshi_hint" }, "选择目标主题：点主题列表某行的「合并到这个主题」，或在下方新建主题后点「创建并选择」。")),
              h("div", { className: "dshi_row" },
                h("span", { className: "dshi_badgeDim dshi_badge" }, mergeForm ? "② 已完成" : "② 待完成"),
                h("span", { className: "dshi_hint" }, "选定后自动载入 before 正文与 revision token，并出现「合并表单」。")),
              h("div", { className: "dshi_row" },
                h("span", { className: "dshi_badgeDim dshi_badge" }, mergeForm ? "③ 下一步" : "③ 待完成"),
                h("span", { className: "dshi_hint" }, "在合并表单里编辑 after → 点「预览 diff（previewPlan）」→ 在下方确认卡里点「确认执行」。合并后源卡将 retired，不可撤销。"))),
            topics === null || topics.loading ? h("div", { className: "dshi_loading" }, "主题列表加载中…") : null,
            topics && topics.error ? ErrorBox(topics.error) : null,
            topics && !topics.loading && !topics.error ? h("div", { className: "dshi_items" },
              topics.topics.length === 0 ? h("div", { className: "dshi_hint" },
                "当前 scope 没有可用的非 legacy 主题（legacy 主题只读，服务端拒绝作为合并目标）。请在下方新建主题。")
                : topics.topics.map(function (row) {
                  var key = String(row.key ?? "");
                  return h("div", { key: key, className: "dshi_item" },
                    h("div", { className: "dshi_itemHead" },
                      h("span", { className: "dshi_mono" }, key),
                      row.title ? h("span", { className: "dshi_badgeDim dshi_badge" }, String(row.title)) : null,
                      row.updated ? h("span", { className: "dshi_hint" }, String(row.updated)) : null,
                      row.revision ? h("span", { className: "dshi_hint dshi_mono" }, "rev " + topicRevisionPrefix(row.revision)) : null,
                      // D：legacy 行只读（服务端拒 UNSUPPORTED）——加 title 说明但不禁用按钮；
                      // loadTopics 通常已过滤 legacy 行，这里保留防御性提示。
                      h("button", {
                        className: "dshi_btn",
                        disabled: busy,
                        title: isLegacyTopicRow(row) ? "legacy 主题只读，不能作为合并目标" : undefined,
                        onClick: function () { openTopicForMerge(row); }
                      }, "合并到这个主题")));
                })) : null,
            // B/C：未选定目标主题时的中性提示（不是错误，不用 ErrorBox / 红色）；选定后换成下一步提示。
            mergeForm ? h("div", { className: "dshi_hint", style: { fontWeight: 600 } },
              "已在合并表单中：编辑 after 后点「预览 diff（previewPlan）」，再在下方确认卡里确认执行。")
              : h("div", { className: "dshi_hint", style: { fontWeight: 600 } },
                "还没有选择目标主题：先点上方某行「合并到这个主题」，或在下方新建主题并点「创建并选择」。选定之后才会出现「合并表单」和「预览 diff」按钮。"),
            h("div", { className: "dshi_cardTitle", style: { marginTop: 6 } }, "或新建主题"),
            newTopic.error ? ErrorBox(newTopic.error) : null,
            h("div", { className: "dshi_row" },
              h("input", { className: "dshi_input", placeholder: "key（安全文件名，core 保留）", value: newTopic.topic, onChange: function (event) { updateNewTopic({ topic: event.target.value }); } }),
              h("input", { className: "dshi_input", placeholder: "标题", value: newTopic.title, onChange: function (event) { updateNewTopic({ title: event.target.value }); } }),
              h("input", { className: "dshi_input", placeholder: "单行摘要（≤60 字符）", value: newTopic.summary, onChange: function (event) { updateNewTopic({ summary: event.target.value }); } }),
              h("button", { className: "dshi_btn dshi_btnPrimary", disabled: busy || newTopic.busy, onClick: submitNewTopic }, newTopic.busy ? "创建中…" : "创建并选择")),
            mergeForm ? h("div", null,
              h("div", { className: "dshi_itemHead", style: { marginTop: 6 } },
                h("span", { className: "dshi_cardTitle" }, "合并表单（目标 " + mergeForm.key + "）"),
                h("span", { className: "dshi_hint dshi_mono" }, "token(" + mergeForm.tokenSource + ") " + topicRevisionPrefix(mergeForm.expectedRevision))),
              h("div", { className: "dshi_hint" }, "before（" + mergeForm.before.length + " 字符，服务端按 append-only 校验 after 必须保留它）已载入；源保全块由服务端自动追加。"),
              h("label", { className: "dshi_label" }, "标题",
                h("input", { className: "dshi_input", value: mergeForm.title, onChange: function (event) { updateMergeForm({ title: event.target.value }); } })),
              h("label", { className: "dshi_label" }, "单行摘要（≤60 字符）",
                h("input", { className: "dshi_input", value: mergeForm.summary, onChange: function (event) { updateMergeForm({ summary: event.target.value }); } })),
              h("label", { className: "dshi_label" }, "合并后正文（after，可编辑；必须保留 before 全文）",
                h("textarea", { className: "dshi_textarea", value: mergeForm.after, onChange: function (event) { updateMergeForm({ after: event.target.value }); } })),
              h("div", { className: "dshi_row" },
                h("button", { className: "dshi_btn dshi_btnPrimary", disabled: busy, onClick: doMergePreview }, "预览 diff（previewPlan）"))) : null
          ));
      };
      return h("div", null,
        h("div", { className: "dshi_row", style: { marginBottom: 8 } },
          h("span", { className: "dshi_cardTitle" }, "整理 / 遗忘：候选审阅与执行"),
          h("button", { className: "dshi_btn", onClick: load, disabled: busy }, "刷新"),
          h("button", { className: "dshi_btn", title: "找出该合并进主题、该建链接、该单独成卡的卡（只读分析，不改数据）", onClick: function () { doAnalyze("organize"); }, disabled: actionsDisabled }, "分析整理候选"),
          h("button", { className: "dshi_btn", title: "按衰减分数找出该归档的旧卡（只读分析）", onClick: function () { doAnalyze("forgetting"); }, disabled: actionsDisabled }, "分析遗忘候选"),
          loaded ? h("span", { className: "dshi_badgeDim dshi_badge" }, "queueRevision " + queueRevision) : null),
        ErrorBox(error),
        data ? h(fragment, null,
          h("div", { className: "dshi_card" },
          h("div", { className: "dshi_cardTitle" }, "候选（" + items.length + "）"),
          h("div", { className: "dshi_hint" }, "候选由「分析整理候选 / 分析遗忘候选」生成：集群（≥8 张共享实体或触发词的卡）可直接「合并进主题」，孤立卡只能用内置预览，可建链接用「预览整理计划」。"),
          items.length === 0 ? h("div", { className: "dshi_hint" }, "（空）") : h("div", { className: "dshi_items" }, items.map(function (item, index) {
            // 真机 queueDto：id/kind 在 item.candidate 里（queueItemCandidate 兼容旧扁平形状）。
            // 下标只用作渲染 key；没有业务 id 的行禁用全部动作，不把下标当 candidateId 发 RPC。
            var candidate = queueItemCandidate(item);
            var businessId = candidate && candidate.id !== undefined && candidate.id !== null
              ? String(candidate.id) : null;
            var key = businessId !== null ? businessId : String(index);
            var isCluster = candidate ? String(candidate.kind ?? "") === "cluster" : false;
            var rowDisabled = actionsDisabled || businessId === null;
            // 就地展开：只有被点击的那一行才在自身正下方渲染合并卡（同一 dshi_items 容器内）。
            var mergeForThisRow = Boolean(merge) && businessId !== null && String(merge.candidateId) === businessId;
            // 有了 id→标题映射就把候选翻译成人话：集群说共享词 + 卡数，
            // 链接说「A ↔ B」，孤立卡直接给源卡标题；都没有时退化成短 id。
            var sourceIds = candidate && Array.isArray(candidate.sources)
              ? candidate.sources.map(function (s) { return String(s && s.id); }).filter(Boolean) : [];
            var sourceTitles = sourceIds.map(function (id) { return titles[id] || shortId(id); });
            var evidence = candidate && candidate.evidence && typeof candidate.evidence === "object" ? candidate.evidence : {};
            var candidateKind = candidate && candidate.kind ? String(candidate.kind) : "";
            var candidateTitle = null;
            if (candidateKind === "cluster") {
              var sharedTerm = evidence.sharedTerm || evidence.field;
              candidateTitle = sharedTerm
                ? "合并「" + String(sharedTerm) + "」相关的 " + sourceIds.length + " 张卡"
                : "合并 " + sourceIds.length + " 张卡";
            } else if (candidateKind === "link" && sourceTitles.length >= 2) {
              candidateTitle = "连接：" + sourceTitles.join(" ↔ ");
            } else if (sourceTitles.length === 1) {
              candidateTitle = sourceTitles[0];
            } else if (sourceTitles.length > 1) {
              candidateTitle = sourceTitles.join("、");
            }
            var row = h("div", { key: key, className: "dshi_item" },
              h("div", { className: "dshi_itemHead" },
                h("span", null, candidateTitle || "（未识别的卡片）"),
                h("span", { className: "dshi_mono" }, businessId !== null ? shortId(businessId) : "（缺少 candidate.id）"),
                candidate && candidate.kind ? h("span", { className: "dshi_badgeDim dshi_badge" }, candidateKindLabel(candidate.kind)) : null,
                item.status ? h("span", { className: "dshi_badge" }, candidateStatusLabel(item.status)) : null,
                h("button", { className: "dshi_btn", disabled: rowDisabled, title: "把候选状态置为 reviewed", onClick: function () { doReview(businessId, "reviewed"); } }, "标记已阅"),
                h("button", { className: "dshi_btn", disabled: rowDisabled, title: "把候选状态置为 dismissed", onClick: function () { doReview(businessId, "dismissed"); } }, "忽略"),
                h("button", { className: "dshi_btn", disabled: rowDisabled, onClick: function () { doPreviewOrganize(businessId); } }, "预览整理计划"),
                // Q-A：cluster 候选一键进入「合并进主题」流程（选/建主题 → 自动 proposal
                // → preview diff → 确认执行），不再要求手写 proposal JSON。
                isCluster ? h("button", { className: "dshi_btn dshi_btnPrimary", disabled: rowDisabled, onClick: function () { openMerge(businessId); } }, "合并进主题") : null),
              // 原始 JSON 默认折叠：details 不写 open，铺满屏幕的长串移出主视线。
              h("details", { className: "dshi_details" },
                h("summary", { className: "dshi_hint" }, "原始数据（JSON）"),
                h("pre", { className: "dshi_pre" }, stableStringify(item))));
            return mergeForThisRow ? [row, renderMergeCard(businessId)] : row;
          })),
          h("div", { className: "dshi_cardTitle", style: { marginTop: 6 } }, "计划（" + plans.length + "）"),
          h("div", { className: "dshi_hint" }, "计划＝预览（previewPlan）生成的待执行变更，含 diff 与 planDigest；确认执行后标为「已执行」，被新预览作废的标为「已作废」。整理类计划请从对应候选的「预览整理计划 / 合并进主题」发起，遗忘类计划可用行内「预览遗忘计划」。"),
          plans.length === 0 ? h("div", { className: "dshi_hint" }, "（空）") : h("div", { className: "dshi_items" }, plans.map(function (plan, index) {
            // 与候选行同一原则：下标只用作渲染 key，planId 缺失时禁用动作而非发下标。
            var businessPlanId = plan && plan.planId !== undefined && plan.planId !== null
              ? String(plan.planId)
              : (plan && plan.id !== undefined && plan.id !== null ? String(plan.id) : null);
            var planId = businessPlanId !== null ? businessPlanId : String(index);
            // Q-B：区分 open / executed / superseded（planStore list 投影的布尔；
            // superseded = 新预览作废旧 open 计划，P 侧 state.mjs 投影提供）。
            // operationId 仅在 DTO 提供时显示（当前投影只含 executed/superseded 布尔，向前兼容）。
            var executed = plan.executed === true;
            var superseded = plan.superseded === true;
            var executedWith = plan.executedWith ?? plan.operationId;
            var isForgetting = plan.kind === undefined || String(plan.kind) === "forgetting";
            return h("div", { key: planId, className: "dshi_item" },
              h("div", { className: "dshi_itemHead" },
                h("span", { className: "dshi_mono" }, businessPlanId !== null ? businessPlanId : "（缺少 planId）"),
                plan.kind ? h("span", { className: "dshi_badgeDim dshi_badge" }, planKindLabel(plan.kind)) : null,
                executed ? h("span", { className: "dshi_badge dshi_badgeWarn" }, planStateLabel("executed"))
                  : superseded ? h("span", { className: "dshi_badge dshi_badgeWarn" }, planStateLabel("superseded"))
                  : h("span", { className: "dshi_badgeDim dshi_badge" }, planStateLabel("open")),
                executedWith !== undefined && executedWith !== null ? h("span", { className: "dshi_hint dshi_mono" }, "op " + String(executedWith)) : null,
                executed || !isForgetting ? null
                  : h("button", { className: "dshi_btn", disabled: actionsDisabled || businessPlanId === null || superseded, onClick: function () { doPreviewForgetting(businessPlanId); } }, "预览遗忘计划")),
              executed ? h("div", { className: "dshi_hint" }, "该计划已执行：不可再次预览 / 执行；如需再次整理请重新 analyze。")
                : superseded ? h("div", { className: "dshi_hint" }, "该计划已被新预览作废（superseded）：不可再预览 / 执行（服务端会拒绝并报 REVISION_CONFLICT），请使用最新计划。")
                : (!isForgetting ? h("div", { className: "dshi_hint" }, "organize 计划请从对应候选的「预览 / 合并进主题」流程执行。") : null),
              h("details", { className: "dshi_details" },
                h("summary", { className: "dshi_hint" }, "原始数据（JSON）"),
                h("pre", { className: "dshi_pre" }, stableStringify(plan))));
          })),
          h("label", { className: "dshi_label", style: { marginTop: 6 } }, "organize proposal（buildDraft 形状，服务端严格校验；默认留空——点候选行「preview organize」按候选预填骨架，cluster 候选推荐直接用「合并进主题」）",
            h("textarea", { className: "dshi_textarea", value: proposal, placeholder: "留空＝未填写（不发送）。点候选行「preview organize」自动预填；或按协议手写 link / merge-topic 形状。", onChange: function (event) { setProposal(event.target.value); } }))),
        ) : null,
        previewError ? ErrorBox(previewError) : null,
        preview && preview.sessionId === props.sessionId ? h("div", { className: "dshi_confirm" },
          h("div", { className: "dshi_cardTitle" }, "PlanView 预览（" + String(preview.plan.kind) + "）",
            h("span", { className: "dshi_mono" }, String(preview.plan.planId)),
            h("span", { className: "dshi_badgeDim dshi_badge" }, String(preview.plan.planDigest))),
          preview.plan.summary ? h("div", { className: "dshi_hint" }, String(preview.plan.summary)) : null,
          Array.isArray(preview.plan.diff) && preview.plan.diff.length > 0 ? preview.plan.diff.map(function (entry, index) {
            return h("div", { key: index, className: "dshi_item" },
              h("div", { className: "dshi_mono" }, String(entry.path ?? index)),
              h("div", { className: "dshi_hint" }, "old"),
              h("pre", { className: "dshi_pre" }, String(entry.oldText ?? "")),
              h("div", { className: "dshi_hint" }, "new"),
              h("pre", { className: "dshi_pre" }, String(entry.newText ?? "")));
          }) : h("div", { className: "dshi_hint" }, "（无 diff 条目）"),
          // Q-B：预览对应的计划若已在 plans 列表里标记 executed / superseded，执行按钮禁用
          (function () {
            var row = plans.find(function (p) { return String(p && p.planId) === String(preview.plan && preview.plan.planId); });
            return row && (row.executed === true || row.superseded === true);
          })() ? h("div", { className: "dshi_hint" }, "该计划已执行或已被新预览作废（plans 列表标记），执行按钮已禁用。") : null,
          h("div", { className: "dshi_row" },
            h("button", {
              className: "dshi_btn dshi_btnDanger",
              disabled: busy || (function () {
                var row = plans.find(function (p) { return String(p && p.planId) === String(preview.plan && preview.plan.planId); });
                return Boolean(row && (row.executed === true || row.superseded === true));
              })(),
              onClick: doExecute
            }, "确认执行（不可撤销）"),
            h("button", { className: "dshi_btn", disabled: busy, onClick: function () { setPreview(null); } }, "取消")))
        : null);
    }

    // ── L3：主题（topic）记忆管理 ────────────────────────────────────────────
    // memory_list_topics 只回元数据（key/title/summary/chars/revision），正文必须
    // memory_read(topic) 单独拿——几十个主题一次性全读会拖慢面板，所以列表默认只显示名字，
    // 点「展开」才读正文。legacy 主题（updated === "legacy-unknown"）服务端拒写，只读展示。
    function TopicsTab(props) {
      var listState = useState(null);
      var topics = listState[0];
      var setTopics = listState[1];
      var busyState = useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];
      var errorState = useState(null);
      var error = errorState[0];
      var setError = errorState[1];
      var openedState = useState("");
      var opened = openedState[0];
      var setOpened = openedState[1];
      var detailState = useState(null);
      var detail = detailState[0];
      var setDetail = detailState[1];
      var detailBusyState = useState(false);
      var detailBusy = detailBusyState[0];
      var setDetailBusy = detailBusyState[1];
      var detailErrorState = useState(null);
      var detailError = detailErrorState[0];
      var setDetailError = detailErrorState[1];
      var editingState = useState(false);
      var editing = editingState[0];
      var setEditing = editingState[1];
      var draftState = useState("");
      var draft = draftState[0];
      var setDraft = draftState[1];
      var saveBusyState = useState(false);
      var saveBusy = saveBusyState[0];
      var setSaveBusy = saveBusyState[1];
      var saveErrorState = useState(null);
      var saveError = saveErrorState[0];
      var setSaveError = saveErrorState[1];
      var saveOkState = useState(null);
      var saveOk = saveOkState[0];
      var setSaveOk = saveOkState[1];

      var load = async function () {
        setBusy(true);
        setError(null);
        try {
          var result = await props.dsh.call("executeTool", props.sessionId, { name: "memory_list_topics", args: {} });
          setTopics(Array.isArray(result && result.topics) ? result.topics : []);
        } catch (e) {
          setTopics(null);
          setError(e);
        } finally {
          setBusy(false);
        }
      };
      useEffect(function () { load(); }, [props.sessionId]);

      var readTopic = async function (key) {
        setDetailBusy(true);
        setDetailError(null);
        try {
          setDetail(await props.dsh.call("executeTool", props.sessionId, { name: "memory_read", args: { topic: key } }));
        } catch (e) {
          setDetail(null);
          setDetailError(e);
        } finally {
          setDetailBusy(false);
        }
      };
      var openTopic = function (key) {
        if (opened === key) {
          setOpened("");
          setDetail(null);
          setEditing(false);
          setDraft("");
          setSaveOk(null);
          setSaveError(null);
          return;
        }
        setOpened(key);
        setDetail(null);
        setDetailError(null);
        setEditing(false);
        setDraft("");
        setSaveOk(null);
        setSaveError(null);
        readTopic(key);
      };
      var beginEdit = function () {
        if (!detail) return;
        setDraft(typeof detail.content === "string" ? detail.content : "");
        setEditing(true);
        setSaveOk(null);
        setSaveError(null);
      };
      var cancelEdit = function () { setEditing(false); setDraft(""); setSaveError(null); };
      var save = async function () {
        if (!detail) return;
        var key = detail.topic || opened;
        setSaveBusy(true);
        setSaveError(null);
        setSaveOk(null);
        try {
          var args = { topic: key, content: draft };
          if (detail.revision !== undefined && detail.revision !== null) args.expectedRevision = detail.revision;
          await props.dsh.call("executeTool", props.sessionId, { name: "memory_rewrite", args: args });
          setEditing(false);
          setSaveOk("主题「" + key + "」已保存");
          await readTopic(key);
          await load();
        } catch (e) {
          setSaveError(e);
        } finally {
          setSaveBusy(false);
        }
      };

      return h("div", null,
        h("div", { className: "dshi_row", style: { marginBottom: 8 } },
          h("span", { className: "dshi_cardTitle" }, "L3 主题记忆（topic）"),
          h("button", { className: "dshi_btn", disabled: busy, onClick: load }, busy ? "刷新中…" : "刷新"),
          h("span", { style: { flex: 1 } }),
          h("span", { className: "dshi_hint" }, topics === null ? "" : "共 " + topics.length + " 个主题")),
        h("div", { className: "dshi_hint" }, "L3 是跨会话的长期主题记忆，每条按 key 存一个文件。这里列表只显示名字和字数，点「展开」才读正文；编辑是整篇覆盖，保存走版本校验。"),
        ErrorBox(error),
        busy && topics === null ? h("div", { className: "dshi_loading" }, "正在读取主题列表…") : null,
        topics !== null && topics.length === 0 ? h("div", { className: "dshi_hint" }, "这个作用域下还没有主题。") : null,
        topics !== null ? h("div", { className: "dshi_items" }, topics.map(function (row) {
          var key = String(row.key);
          var legacy = isLegacyTopicRow(row);
          var isOpen = opened === key;
          return h("div", { key: key, className: "dshi_item" },
            h("div", { className: "dshi_itemHead" },
              h("span", { className: "dshi_cardTitle" }, key),
              row.title ? h("span", { className: "dshi_hint" }, String(row.title)) : null,
              legacy ? h("span", { className: "dshi_badge dshi_badgeWarn" }, "legacy 只读") : null,
              h("span", { style: { flex: 1 } }),
              h("span", { className: "dshi_mono" }, (row.chars ?? 0) + " 字符"),
              h("button", { className: "dshi_btn", onClick: function () { openTopic(key); } }, isOpen ? "收起" : "展开")),
            isOpen
              ? h("div", null,
                  row.summary ? h("div", { className: "dshi_hint" }, String(row.summary)) : null,
                  detailBusy ? h("div", { className: "dshi_loading" }, "正在读取正文…") : null,
                  ErrorBox(detailError),
                  detail ? h("div", null,
                    h("div", { className: "dshi_row" },
                      h("span", { className: "dshi_mono", title: "完整版本号：" + String(detail.revision) }, "rev " + shortRev(detail.revision)),
                      h("span", { className: "dshi_hint" }, (detail.bytes ?? 0) + " 字节"),
                      detail.truncated ? h("span", { className: "dshi_badge dshi_badgeWarn" }, "正文过长，已截断") : null,
                      h("span", { style: { flex: 1 } }),
                      legacy
                        ? h("span", { className: "dshi_hint" }, "legacy 主题由旧版写入，服务端拒绝改写")
                        : (editing
                          ? h(fragment, null,
                              h("button", { className: "dshi_btn dshi_btnPrimary", disabled: saveBusy, onClick: save }, saveBusy ? "保存中…" : "保存"),
                              h("button", { className: "dshi_btn", disabled: saveBusy, onClick: cancelEdit }, "取消"))
                          : h("button", { className: "dshi_btn", onClick: beginEdit }, "编辑"))),
                    saveOk ? h("div", { className: "dshi_ok" }, saveOk) : null,
                    ErrorBox(saveError),
                    editing
                      ? h("textarea", {
                          className: "dshi_textarea",
                          style: { minHeight: 220 },
                          value: draft,
                          onChange: function (event) { setDraft(event.target.value); }
                        })
                      : h("pre", { className: "dshi_pre" }, String(detail.content ?? "")))
                  : null)
              : null);
        })) : null);
    }

    // ── U2 预算页重写（标杆页，其他页对齐它的标准） ─────────────────────────
    // - 命名三层分离：界面名主位；技术名进 tooltip（title）与页尾「技术细节」；
    //   机制说明一律写成后果描述（例：超过这个长度就不再接受新增内容，只能删减）。
    // - 占比字段改水位：softRatio / hardRatio 不再直接编辑，改为字符数水位滑杆 +
    //   联动显示；软水位不得越过硬水位，互相钳制。
    // - 顶部实时预览条：当前占用 ─ 软水位 · 硬闸 · 硬顶，随任何字段修改实时变化；
    //   占用取 getStatus 返回的真实 occupancy（l1Chars），不写死示例值。
    // - 按人设卡（L0）/ 记忆核心（L1）/ 闪回卡片（L2）三组分组卡片，组头一句话介绍。
    // - 已修改字段标「已修改」徽章 + 单字段恢复默认；越界就地中文提示并禁用保存。
    // - targetChars 不在界面出现（D3：保留 schema、界面隐藏）；但它必须是
    //   softChars ≤ targetChars < hardChars 的合法值，所以随三个可调字段一起
    //   被收敛进区间（clampCoreWater），并在保存时写回——否则把硬顶调小到
    //   targetChars 以下时，保存会被一个界面上看不见的字段挡住（P1 修复点）。
    //   保存时把旧 ratio 字段清掉，避免双源真相。
    // - 层号纠错（U0）：记忆核心是 L1、人设卡是 L0（对齐状态页 686-687 行写法）。

    // 出厂默认值：与 src/core/config.mjs DEFAULT_CONFIG 一致；水位按
    // hardCapChars × ratio 四舍五入派生（与 src/plugin/config.mjs derivedWaterDefaults
    // 同一派生式）。浏览器 bundle 无构建步骤、拿不到服务端模块，只能在此落常数，
    // 改动 DEFAULT_CONFIG 时必须同步这里。
    var BUDGET_FACTORY_DEFAULTS = {
      core: { targetChars: 8000, hardCapChars: 10000, softChars: 7500, hardChars: 9000 },
      persona: { maxChars: 12000 },
      spark: { maxChars: 600, inlineMaxChars: 100, maxCards: 5, seedCount: 3, linkCount: 2 }
    };

    // 字段元数据：label=界面名（主位）；tech=技术名（进 tooltip）；hint=后果描述。
    // 上限与 src/plugin/config.mjs BUDGET_CEILINGS 保持一致。
    var BUDGET_FIELD_META = {
      "core.hardCapChars": {
        kind: "integer",
        label: "硬顶",
        tech: "core.hardCapChars",
        hint: "无论如何不能越过的总长度上限"
      },
      "persona.maxChars": {
        kind: "integer",
        // 与服务端 BUDGET_CEILINGS.persona.maxChars 保持一致（默认 12000）。
        max: 60000,
        label: "人设卡最大字符数",
        tech: "persona.maxChars（上限 60000）",
        hint: "人设卡正文超过这个长度，写入会被拒绝"
      },
      "spark.maxChars": {
        kind: "integer",
        max: 600,
        label: "单次投递长度上限",
        tech: "spark.maxChars（上限 600）",
        hint: "一轮投递的闪回卡片文本总长超过它就发不出去"
      },
      "spark.inlineMaxChars": {
        kind: "integer",
        max: 100,
        label: "直接带全文的门槛",
        tech: "spark.inlineMaxChars（上限 100）",
        hint: "卡片正文短于它就整篇带上，长于它只发摘要 + id"
      },
      "spark.maxCards": {
        kind: "integer",
        max: 5,
        label: "单次最多卡片数",
        tech: "spark.maxCards（上限 5）",
        hint: "一轮投递最多带这么多张闪回卡，超过会截断，防止刷屏"
      },
      "spark.seedCount": {
        kind: "integer",
        max: 3,
        label: "召回种子数",
        tech: "spark.seedCount（上限 3）",
        hint: "每轮最多召回的种子素材条数"
      },
      "spark.linkCount": {
        kind: "integer",
        max: 2,
        label: "关联链接数",
        tech: "spark.linkCount（上限 2）",
        hint: "每轮最多附带的 1 跳关联条数"
      }
    };

    // 软/硬/目标三者一致性收敛：硬 < 硬顶、软 ≤ 硬、目标 ∈ [软, 硬-1]。
    // 界面只有硬顶/软水位/硬水位三个可调字段，而服务端 validateConfig 要求
    // softAt ≤ targetChars < hardAt < cap——隐藏的 targetChars 必须跟着水位走，
    // 不能反过来当用户改不动的硬约束。非整数的中间态直接跳过，交给校验报错。
    function clampCoreWater(core) {
      var next = assign({}, core);
      var cap = next.hardCapChars;
      if (Number.isInteger(cap) && cap > 0) {
        if (!Number.isInteger(next.hardChars) || next.hardChars > cap - 1) next.hardChars = cap - 1;
        // 软水位跟随时要留出「严格小于」这一格：钳到相等只会立刻触发
        // 「软水位必须小于硬水位」，等于把用户按在一个必然被拒的状态上。
        if (Number.isInteger(next.softChars) && Number.isInteger(next.hardChars)
          && next.softChars > next.hardChars - 1) next.softChars = Math.max(1, next.hardChars - 1);
      }
      if (Number.isInteger(next.softChars) && Number.isInteger(next.hardChars) && next.hardChars > next.softChars) {
        if (!Number.isInteger(next.targetChars) || next.targetChars < next.softChars) next.targetChars = next.softChars;
        if (next.targetChars > next.hardChars - 1) next.targetChars = next.hardChars - 1;
      }
      return next;
    }

    // 从宿主快照 value.budgets 提取可编辑草稿。老配置只有 ratio 时按
    // hardCapChars × ratio 四舍五入换算成水位（与服务端 normalizePluginConfig 同式）。
    function extractBudgetDraft(budgets) {
      var defaults = BUDGET_FACTORY_DEFAULTS;
      var core = budgets && budgets.core ? budgets.core : {};
      var persona = budgets && budgets.persona ? budgets.persona : {};
      var spark = budgets && budgets.spark ? budgets.spark : {};
      var cap = typeof core.hardCapChars === "number" ? core.hardCapChars : defaults.core.hardCapChars;
      var soft = typeof core.softChars === "number"
        ? core.softChars
        : (typeof core.softRatio === "number" ? Math.round(cap * core.softRatio) : defaults.core.softChars);
      var hard = typeof core.hardChars === "number"
        ? core.hardChars
        : (typeof core.hardRatio === "number" ? Math.round(cap * core.hardRatio) : defaults.core.hardChars);
      return {
        core: clampCoreWater({
          hardCapChars: cap,
          softChars: soft,
          hardChars: hard,
          // 不渲染、不直接编辑；快照缺该字段时回落工厂默认值，否则区间校验/
          // 收敛整段被跳过、滑杆能拉出必然被服务端拒绝的组合。
          targetChars: typeof core.targetChars === "number"
            ? core.targetChars
            : (defaults.core && typeof defaults.core.targetChars === "number" ? defaults.core.targetChars : null)
        }),
        persona: { maxChars: typeof persona.maxChars === "number" ? persona.maxChars : undefined },
        spark: {
          maxChars: typeof spark.maxChars === "number" ? spark.maxChars : undefined,
          inlineMaxChars: typeof spark.inlineMaxChars === "number" ? spark.inlineMaxChars : undefined,
          maxCards: typeof spark.maxCards === "number" ? spark.maxCards : undefined,
          seedCount: typeof spark.seedCount === "number" ? spark.seedCount : undefined,
          linkCount: typeof spark.linkCount === "number" ? spark.linkCount : undefined
        }
      };
    }

    // 改一个字段后返回新草稿；软/硬水位互相钳制：软 ≤ 硬 < 硬顶。
    function setBudgetDraftValue(currentDraft, path, fieldValue) {
      var parts = path.split(".");
      var next = {
        core: assign({}, currentDraft.core),
        persona: assign({}, currentDraft.persona),
        spark: assign({}, currentDraft.spark)
      };
      next[parts[0]][parts[1]] = fieldValue;
      // 硬顶/软/硬任一变动都把三者（含隐藏的 targetChars）重新收敛到合法区间。
      next.core = clampCoreWater(next.core);
      return next;
    }

    // 越界校验：全部中文文案、按字段就地提示；保存按钮据此禁用。
    function budgetDraftFieldErrors(draft) {
      var errors = {};
      var core = draft.core;
      if (!Number.isInteger(core.hardCapChars) || core.hardCapChars <= 0) {
        errors["core.hardCapChars"] = "硬顶必须是正整数。";
      } else {
        if (!Number.isInteger(core.softChars) || core.softChars < 1) {
          errors["core.softChars"] = "软水位至少为 1 字符（填 0 会被换算成 0 比例，加载时直接拒绝）。";
        }
        if (!Number.isInteger(core.hardChars) || core.hardChars < 2) {
          errors["core.hardChars"] = "硬水位至少为 2 字符（必须严格大于软水位）。";
        }
        if (errors["core.softChars"] === undefined && errors["core.hardChars"] === undefined) {
          if (core.softChars >= core.hardChars) {
            errors["core.softChars"] = "软水位（" + core.softChars + " 字符）必须小于硬水位（" + core.hardChars + " 字符）：相等会导致加载校验失败。";
          }
          if (core.hardChars >= core.hardCapChars) {
            errors["core.hardChars"] = "硬水位（" + core.hardChars + " 字符）必须小于硬顶（" + core.hardCapChars + " 字符）：硬闸之上要保留超限判定的空间。";
          }
        }
      }
      // 文案一律点名界面上看得见的中文字段名：面板里没有的技术名（如隐藏的
      // targetChars）不得出现在用户要读的错误里。
      var labelOf = function (path) {
        return BUDGET_FIELD_META[path] && BUDGET_FIELD_META[path].label ? BUDGET_FIELD_META[path].label : path;
      };
      if (!Number.isInteger(draft.persona.maxChars) || draft.persona.maxChars <= 0) {
        errors["persona.maxChars"] = labelOf("persona.maxChars") + "必须是正整数。";
      } else if (draft.persona.maxChars > 60000) {
        errors["persona.maxChars"] = labelOf("persona.maxChars") + "超过上限 60000。";
      }
      var sparkRules = [["maxChars", 600], ["inlineMaxChars", 100], ["maxCards", 5], ["seedCount", 3], ["linkCount", 2]];
      for (var i = 0; i < sparkRules.length; i++) {
        var key = sparkRules[i][0];
        var max = sparkRules[i][1];
        var v = draft.spark[key];
        if (!Number.isInteger(v) || v <= 0) errors["spark." + key] = labelOf("spark." + key) + "必须是正整数。";
        else if (v > max) errors["spark." + key] = labelOf("spark." + key) + "超过上限 " + max + "。";
      }
      if (Number.isInteger(draft.spark.inlineMaxChars) && Number.isInteger(draft.spark.maxChars)
        && draft.spark.inlineMaxChars > draft.spark.maxChars) {
        errors["spark.inlineMaxChars"] = "直接带全文的门槛不能超过单次投递长度上限。";
      }
      if (Number.isInteger(draft.spark.seedCount) && Number.isInteger(draft.spark.linkCount) && Number.isInteger(draft.spark.maxCards)
        && draft.spark.seedCount + draft.spark.linkCount > draft.spark.maxCards) {
        errors["spark.seedCount"] = "召回种子数 + 关联链接数（" + (draft.spark.seedCount + draft.spark.linkCount) + "）不能超过单次最多卡片数（" + draft.spark.maxCards + "）。";
      }
      return errors;
    }

    // 顶部实时预览条：当前占用 ─ 软水位 · 硬闸 · 硬顶。占用是真实数据
    // （getStatus occupancy.l1Chars），水位随草稿实时变化；占用颜色随水位分档
    // （安全绿 / 警告黄 / 危险红，只用 token）。
    function budgetPreviewBar(draft, occupancy) {
      var cap = draft.core.hardCapChars;
      var soft = draft.core.softChars;
      var hard = draft.core.hardChars;
      var used = occupancy && typeof occupancy.chars === "number" ? occupancy.chars : null;
      var pct = function (v) {
        return Number.isInteger(cap) && cap > 0 ? Math.max(0, Math.min(100, (v / cap) * 100)) : 0;
      };
      var level = used === null || !Number.isInteger(soft) || !Number.isInteger(hard)
        ? null
        : (used >= hard ? "danger" : used >= soft ? "warn" : "safe");
      var fillColor = level === "danger"
        ? "var(--dshi-danger)"
        : (level === "warn" ? "var(--dshi-warn)" : "var(--dshi-safe)");
      return h("div", { className: "dshi_preview" },
        h("div", { className: "dshi_row" },
          h("span", { className: "dshi_cardTitle" }, "当前占用"),
          h("span", { className: "dshi_hint" },
            used === null
              ? "占用数据不可用（未取到 getStatus 的 occupancy；切换会话或刷新后重试）"
              : "记忆核心已用 " + used + " / " + cap + " 字符")),
        h("div", { className: "dshi_track" },
          used !== null ? h("div", { className: "dshi_trackFill", style: { width: pct(used) + "%", background: fillColor } }) : null,
          Number.isInteger(soft) ? h("div", { className: "dshi_trackMark", style: { left: pct(soft) + "%", background: "var(--dshi-warn)" }, title: "软水位 " + soft + " 字符" }) : null,
          Number.isInteger(hard) ? h("div", { className: "dshi_trackMark", style: { left: pct(hard) + "%", background: "var(--dshi-danger)" }, title: "硬闸 " + hard + " 字符" }) : null),
        h("div", { className: "dshi_trackLegend" },
          "软水位 " + soft, "·", "硬闸 " + hard, "·", "硬顶 " + cap,
          level === "warn" ? "—— 已过软水位：新增内容开始被压缩着写" : null,
          level === "danger" ? "—— 已过硬闸：只减不增" : null));
    }

    function BudgetsTab(props) {
      var scope = props.dsh.configScope();
      var state = useState(null);
      var snapshot = state[0];
      var setSnapshot = state[1];
      var errorState = useState(null);
      var error = errorState[0];
      var setError = errorState[1];
      var okState = useState(null);
      var okText = okState[0];
      var setOk = okState[1];
      // 编辑草稿：null=尚未改动（展示层直接用快照换算），一旦修改即持有整份草稿。
      var draftState = useState(null);
      var draftEdits = draftState[0];
      var setDraftEdits = draftState[1];
      // 真实占用（getStatus occupancy.l1Chars）；{chars:null}=不可用，如实显示。
      var occupancyState = useState(null);
      var occupancy = occupancyState[0];
      var setOccupancy = occupancyState[1];
      useEffect(function () {
        try {
          setSnapshot(scope ? scope.getSnapshot() : null);
        } catch (e) {
          setError({ code: "ui/scope", message: "读取设置命名空间失败：" + (e && e.message) });
        }
      }, []);
      useEffect(function () {
        var cancelled = false;
        props.dsh.call("getStatus", props.sessionId, {}).then(function (status) {
          if (cancelled) return;
          var occ = status && status.occupancy && typeof status.occupancy === "object" ? status.occupancy : null;
          setOccupancy({ chars: occ && typeof occ.l1Chars === "number" ? occ.l1Chars : null });
        }, function () {
          if (!cancelled) setOccupancy({ chars: null });
        });
        return function () { cancelled = true; };
      }, [props.sessionId]);
      if (!scope) {
        return h("div", { className: "dshi_error" }, "[shiori/ui-unsupported] configForms 服务不可用：无法提供原生预算配置界面（工具模式仍可用）。");
      }
      var value = snapshot && snapshot.status === "ready" ? snapshot.value : null;
      // 展示用草稿：用户改过的字段优先，其余取快照换算值（老配置只有 ratio 时
      // 按 hardCapChars × ratio 换算成水位）。
      var snapshotDraft = value ? extractBudgetDraft(value.budgets) : null;
      var draft = draftEdits
        ? { core: assign({}, snapshotDraft.core, draftEdits.core), persona: assign({}, snapshotDraft.persona, draftEdits.persona), spark: assign({}, snapshotDraft.spark, draftEdits.spark) }
        : snapshotDraft;
      var fieldErrors = draft ? budgetDraftFieldErrors(draft) : {};
      var errorCount = Object.keys(fieldErrors).length;
      var change = function (path, fieldValue) {
        var base = draft || snapshotDraft;
        if (!base) return;
        setDraftEdits(setBudgetDraftValue(base, path, fieldValue));
      };
      var resetField = function (path) {
        var parts = path.split(".");
        var factoryDefault = BUDGET_FACTORY_DEFAULTS[parts[0]] ? BUDGET_FACTORY_DEFAULTS[parts[0]][parts[1]] : undefined;
        change(path, factoryDefault);
      };
      // 字段行：界面名主位（技术名进 title tooltip）+ 后果描述 + 已修改徽章 +
      // 单字段恢复默认 + 就地中文错误。
      var integerField = function (path) {
        var meta = BUDGET_FIELD_META[path];
        var parts = path.split(".");
        var current = draft ? draft[parts[0]][parts[1]] : undefined;
        var original = snapshotDraft ? snapshotDraft[parts[0]][parts[1]] : undefined;
        var modified = current !== undefined && current !== original;
        // 三段式：字段名一行 → 输入框 + 恢复默认同一行 → 提示/错误各占一行。
        return h("div", { className: "dshi_fieldRow", key: path },
          h("label", { className: "dshi_label", title: meta.tech },
            meta.label,
            modified ? h("span", { className: "dshi_modBadge" }, "已修改") : null,
            h("div", { className: "dshi_controlRow" },
              h("input", {
              className: "dshi_input",
              type: "number",
              value: current === undefined || typeof current !== "number" ? "" : String(current),
              "data-path": path,
              min: "0",
              max: meta.max !== undefined ? String(meta.max) : undefined,
              step: "1",
              onChange: function (event) {
                var text = String(event.target.value == null ? "" : event.target.value).trim();
                if (text === "") { change(path, undefined); return; }
                var parsed = Number(text);
                change(path, Number.isFinite(parsed) ? parsed : text);
              }
            }),
            h("button", {
              className: "dshi_btn", type: "button", title: "恢复出厂默认 " + meta.tech,
              onClick: function () { resetField(path); }
            }, "恢复默认")),
            h("div", { className: "dshi_hint" }, meta.hint),
            fieldErrors[path] ? h("div", { className: "dshi_fieldError" }, fieldErrors[path]) : null));
      };
      // 水位字段行：滑杆 + 字符数联动显示；软/硬互相钳制（setBudgetDraftValue）。
      var waterField = function (key, label, tech, consequenceHint) {
        var path = "core." + key;
        var cap = draft ? draft.core.hardCapChars : 0;
        var current = draft ? draft.core[key] : undefined;
        var original = snapshotDraft ? snapshotDraft.core[key] : undefined;
        var modified = current !== undefined && current !== original;
        var other = key === "softChars" ? draft && draft.core.hardChars : draft && draft.core.softChars;
        // 滑杆边界与保存校验同口径：软 ∈ [1, 硬-1]，硬 ∈ [软+1, 硬顶-1]。
        // 隐藏的 targetChars 不再参与定界（它跟着收敛）：否则滑杆会停在一个
        // 界面上没有任何字段能解释的上限上。
        var softMax = Number.isInteger(draft && draft.core.hardChars)
          ? Math.max(1, draft.core.hardChars - 1)
          : Math.max(1, (cap || 2) - 2);
        var max = key === "softChars"
          ? softMax
          : Math.max(2, (Number.isInteger(cap) ? cap : 0) - 1);
        var min = key === "softChars" ? 1 : (Number.isInteger(other) ? Math.max(other + 1, 2) : 2);
        // 字段名一行 → 滑杆 + 数值 + 恢复默认同一行 → 后果说明一行。
        return h("div", { className: "dshi_fieldRow", key: path },
          h("label", { className: "dshi_label", title: tech },
            label,
            modified ? h("span", { className: "dshi_modBadge" }, "已修改") : null,
            h("div", { className: "dshi_controlRow" },
              h("div", { className: "dshi_sliderRow" },
              h("input", {
                className: "dshi_slider", type: "range",
                min: String(min), max: String(max), step: "1",
                value: Number.isInteger(current) ? String(current) : "0",
                "data-path": path,
                onChange: function (event) { change(path, Number(event.target.value)); }
              }),
              h("input", {
                className: "dshi_input dshi_sliderNum", type: "number",
                min: "0", max: String(max), step: "1",
                value: Number.isInteger(current) ? String(current) : "",
                "data-path": path + ".num",
                onChange: function (event) {
                  var text = String(event.target.value == null ? "" : event.target.value).trim();
                  if (text === "") { change(path, undefined); return; }
                  var parsed = Number(text);
                  change(path, Number.isFinite(parsed) ? parsed : text);
                }
              }),
              h("span", { className: "dshi_hint" }, "字符 / 硬顶 " + (Number.isInteger(cap) ? cap : "—"))),
              h("button", {
                className: "dshi_btn", type: "button", title: "恢复出厂默认 " + tech,
                onClick: function () { resetField(path); }
              }, "恢复默认")),
            h("div", { className: "dshi_hint" }, consequenceHint),
            fieldErrors[path] ? h("div", { className: "dshi_fieldError" }, fieldErrors[path]) : null));
      };
      var groupCard = function (layer, title, intro, children) {
        return h("div", { className: "dshi_bgroup", key: layer },
          h("div", { className: "dshi_row" },
            h("span", { className: "dshi_layerChip dshi_layer" + layer }, layer + " " + title),
            h("span", { className: "dshi_cardTitle" }, title)),
          h("div", { className: "dshi_bintro" }, intro),
          h("div", { className: "dshi_items" }, children));
      };
      var save = async function () {
        setError(null);
        setOk(null);
        if (!value || !draft) return;
        if (errorCount > 0) return; // 越界禁用保存（按钮已 disabled，这里双保险）
        try {
          var budgetsObject = assign({}, value.budgets || {});
          ["core", "persona", "spark"].forEach(function (section) {
            budgetsObject[section] = assign({}, budgetsObject[section] || {});
          });
          // 水位为权威（U2 产出 4）：写 softChars/hardChars，清掉旧 ratio 字段，
          // 避免双源真相。targetChars 不在界面出现，但必须一起写回收敛后的值
          // （softChars ≤ targetChars < hardChars），否则服务端加载校验会被一个
          // 用户看不见的字段拦下。
          budgetsObject.core.hardCapChars = draft.core.hardCapChars;
          budgetsObject.core.softChars = draft.core.softChars;
          budgetsObject.core.hardChars = draft.core.hardChars;
          if (Number.isInteger(draft.core.targetChars)) budgetsObject.core.targetChars = draft.core.targetChars;
          delete budgetsObject.core.softRatio;
          delete budgetsObject.core.hardRatio;
          if (draft.persona.maxChars !== undefined) budgetsObject.persona.maxChars = draft.persona.maxChars;
          ["maxChars", "inlineMaxChars", "maxCards", "seedCount", "linkCount"].forEach(function (key) {
            if (draft.spark[key] !== undefined) budgetsObject.spark[key] = draft.spark[key];
          });
          // 单批一个 revision fence：整段 budgets 写入，避免逐字段各自 fence 被拒。
          var run;
          if (typeof scope.mutate === "function") {
            run = scope.mutate([{ op: "set", path: ["budgets"], value: budgetsObject }], scope.getSnapshot().revision);
          } else {
            run = scope.set("budgets", budgetsObject);
          }
          await run;
          var applied = true;
          var next = scope.getSnapshot();
          setSnapshot(next);
          setDraftEdits(null); // 以保存后的快照为新基准
          if (next.status === "ready" && next.value && next.value.budgets) {
            for (var section in budgetsObject) {
              for (var key in budgetsObject[section]) {
                if (!next.value.budgets[section] || next.value.budgets[section][key] !== budgetsObject[section][key]) applied = false;
              }
            }
          } else {
            applied = false;
          }
          setOk(applied
            ? "已保存（旧版占比字段已升级为水位；宿主 settings 命名空间 shiori；volatile 字段由宿主热提交，不触发插件重载）。新预算将在下次插件重载或宿主重启后生效。"
            : "写入未确认生效——请重新打开本页核对当前值。");
          // U8 需重启强提示：保存成功 = 写入已确认，但 budgets 由宿主热提交、
          // 需下次插件重载 / 宿主重启才完全生效 → 「需重启」toast + 页内横幅；
          // 写入未确认生效只发失败 toast，绝不发需重启提示。
          if (applied) {
            if (typeof props.notifyRestart === "function") props.notifyRestart(RESTART_HINT);
          } else {
            shioriToast("error", "预算写入未确认生效——请重新打开本页核对当前值。");
          }
        } catch (e) {
          setError({ code: (e && e.code) || "ui/save", message: (e && e.message) || String(e) });
          // U8：保存失败只发失败 toast，不发需重启提示。
          shioriToast("error", "预算保存失败：" + ((e && e.code) ? e.code + " " : "") + ((e && e.message) || String(e)));
        }
      };
      return h("form", {
        className: "dshi_card",
        onSubmit: function (event) { event.preventDefault(); save(); }
      },
        h("div", { className: "dshi_row" },
          h("span", { className: "dshi_cardTitle" }, "记忆预算"),
          h("span", { className: "dshi_titleSub" }, "宿主原生配置；下次插件重载 / 宿主重启后生效")),
        h("div", { className: "dshi_hint" }, "水位决定记忆核心的压缩与闸门：过了软水位开始压缩着写，越过硬闸就只减不增。改动会实时反映在下面的水位条里。"),
        value && draft ? budgetPreviewBar(draft, occupancy) : null,
        value && draft ? h("div", { className: "dshi_items" },
          groupCard("L0", "人设卡", "写给模型的人设与约定，整段注入每次对话。", [
            integerField("persona.maxChars")
          ]),
          groupCard("L1", "记忆核心", "模型长期维护的记忆正文：超过软水位开始压缩，越过硬闸只减不增。", [
            integerField("core.hardCapChars"),
            waterField("softChars", "软水位", "core.softChars（旧 core.softRatio，保存时清除）", "超过这个长度就不再原样接受新增内容，开始压缩着写。"),
            waterField("hardChars", "硬水位（硬闸）", "core.hardChars（旧 core.hardRatio，保存时清除）", "越过这道闸就不再接受新增内容，只能删减。")
          ]),
          groupCard("L2", "闪回卡片", "小张的独立记忆卡，按触发词召回后作为附件投递。", [
            integerField("spark.maxChars"),
            integerField("spark.inlineMaxChars"),
            integerField("spark.maxCards"),
            integerField("spark.seedCount"),
            integerField("spark.linkCount")
          ])) : h("div", { className: "dshi_loading" }, snapshot && snapshot.status !== "ready" ? "设置命名空间不可用（服务端未注册 shiori 命名空间？）" : "加载中…"),
        errorCount > 0 ? h("div", { className: "dshi_blockError" },
          "有 " + errorCount + " 处越界，已禁用保存：", Object.keys(fieldErrors).map(function (path) {
            return h("div", { key: path }, fieldErrors[path]);
          })) : null,
        ErrorBox(error),
        okText ? h("div", { className: "dshi_ok" }, okText) : null,
        h("div", { className: "dshi_row" },
          h("button", {
            className: "dshi_btn dshi_btnPrimary", type: "submit",
            disabled: !value || !draft || errorCount > 0
          }, "保存预算")),
        h("details", null,
          h("summary", { className: "dshi_hint" }, "技术细节（技术名与原始值，一般不用看）"),
          h("div", { className: "dshi_hint" },
            "旧版占比字段（core.softRatio / core.hardRatio）已在界面隐藏，保存时自动清除、按水位生效；记忆目标长度（core.targetChars）不在界面出现，保存时自动收敛到「软水位 ~ 硬水位-1」之间并写回。",
            snapshot ? " rev " + String(snapshot.revision) : null,
            "。"),
          value ? h("pre", { className: "dshi_pre" }, stableStringify(value.budgets)) : null));
    }

    var TABS = [
      { id: "status", label: "状态" },
      { id: "memory", label: "记忆 L0/L1" },
      { id: "graph", label: "图谱" },
      { id: "candidates", label: "候选 / 计划" },
      { id: "topics", label: "L3/topic 记忆管理" },
      { id: "budgets", label: "预算配置" }
    ];

    // R6 追加：inert / shadow 时数据 tab 一律渲染「未配置」占位——不让用户点进去
    // 吃 UNSUPPORTED/NOT_CONFIGURED 错误。getStatus 在三种模式下都可用，故以它探活。
    // （shadow 收窄语义：shadow 只用于装配期探活，不提供数据浏览。）
    function ModePlaceholder(mode) {
      var inert = mode === "inert";
      return h("div", { className: "dshi_card" },
        h("div", { className: "dshi_cardTitle" }, inert ? "未配置（inert）" : "shadow 模式——数据界面停用"),
        h("div", { className: "dshi_hint" }, inert
          ? "插件尚未配置 dataRoot / stateRoot（inert）：面板仅用于装配期探活，不提供数据浏览。配置根目录并重新加载后，记忆 / 图谱 / 候选界面才会启用。"
          : "shadow 模式仅用于装配期探活，不提供数据浏览（getStatus 除外，其余操作服务端一律拒绝且永不触盘）。配置 dataRoot / stateRoot 并切换 active 后启用。"));
    }

    // 宿主 session 列表拉取的自动重试（owner 实机：首帧拿列表时远端 session 命名空间
    // 尚未就绪 / session.list 一次瞬时失败，旧代码只拉一次就永久退化成手填输入框）。
    // 最多 3 次尝试，失败后分别等 300ms、900ms 再试；判定成功只看「拿到数组」——
    // 空数组也是一次明确的成功回答（宿主说“没有会话”），不能当失败继续重试。
    var SESSION_LIST_ATTEMPTS = 3;
    var SESSION_LIST_RETRY_DELAYS = [300, 900];
    function delayMs(ms) {
      return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }
    async function listSessionsWithRetry(dsh, currentSessionId) {
      for (var attempt = 0; attempt < SESSION_LIST_ATTEMPTS; attempt++) {
        if (attempt > 0) await delayMs(SESSION_LIST_RETRY_DELAYS[attempt - 1]);
        var items;
        try {
          items = await dsh.listSessions(currentSessionId);
        } catch (error) {
          items = null; // buildApi 设计上不抛；这里防御第三方 dsh 实现抛错
        }
        if (Array.isArray(items)) return items;
      }
      return null;
    }

    // 会话下拉文案：有标题 → 标题（超过 60 个字符按 code point 截断并加 "…"，不劈开
    // 中文/代理对）；没有标题 → sessionId。完整 sessionId 走 option 的 title 属性。
    var SESSION_LABEL_LIMIT = 60;
    function sessionOptionLabel(item) {
      var title = item && typeof item.title === "string" ? item.title : "";
      if (title === "") return String((item && item.sessionId) || "");
      var chars = Array.from(title);
      return chars.length > SESSION_LABEL_LIMIT
        ? chars.slice(0, SESSION_LABEL_LIMIT).join("") + "…"
        : title;
    }

    function ShioriSection(props) {
      ensureStyle();
      var tabState = useState("status");
      var tab = tabState[0];
      var setTab = tabState[1];
      var sessionState = useState("");
      var sessionId = sessionState[0];
      var setSessionId = sessionState[1];
      var manualState = useState("");
      var manual = manualState[0];
      var setManual = manualState[1];
      var sessionsState = useState(undefined);
      var sessions = sessionsState[0];
      var setSessions = sessionsState[1];
      // 模式探测：undefined=检测中，null=getStatus 不可用（回退到旧行为，逐 tab 报错），
      // 否则为 getStatus DTO（mode: inert | shadow | active）。
      var modeState = useState(undefined);
      var modeStatus = modeState[0];
      var setModeStatus = modeState[1];
      // 会话可用性缓存（Q 槽健壮性）：同一 sessionId 的会话级失败缓存于此，
      // 切 tab 不再重复发同一 RPC，也不把会话级错误渲染成 tab 的 ErrorBox；
      // 「刷新」清空缓存并强制重新探测。
      //   { sessionId, blocked, error, probeError, skipped, probing, done }
      var availabilityState = useState({ sessionId: "", blocked: false, error: null, probeError: null, skipped: 0, probing: false, done: false });
      var availability = availabilityState[0];
      var setAvailability = availabilityState[1];
      // 刷新重试的强制探测信号（sessionId 不变时靠它重新触发探测 effect）。
      var probeTickState = useState(0);
      var probeTick = probeTickState[0];
      var setProbeTick = probeTickState[1];
      // 工作区列表：undefined=尚未拉取，null=宿主没有该服务（面板退化为平铺会话下拉），
      // 数组=可用。追加在末尾，老测试预置的 states[0..6] 下标不变。
      var workspacesState = useState(undefined);
      var workspaces = workspacesState[0];
      var setWorkspaces = workspacesState[1];
      // 会话下拉的工作区过滤："" = 全部工作区。
      var workspaceState = useState("");
      var workspaceId = workspaceState[0];
      var setWorkspaceId = workspaceState[1];
      // 会话列表拉取的并发守卫（useRef 不占 useState 下标，老测试的 states[0..6] 不变）：
      // 首帧 effect 与「刷新」可能同时触发，只允许一个请求在飞。
      var sessionsRequestRef = useRef({ pending: false });

      var noteAvailability = function (next) { setAvailability(next); };

      // 探测式自动选中：最多 SESSION_PROBE_LIMIT 个候选（跳过 value 为空的占位项）。
      // 成功 → 选中；会话级不可用 → 记住跳过并试下一个；其他错误 → 也试下一个，
      // 但错误原样留在面板提示里（不吞，见 D）。全部不可用 → 保持占位项。
      var probeCandidates = async function (items) {
        var candidates = Array.isArray(items) ? items.slice(0, SESSION_PROBE_LIMIT) : [];
        var skipped = 0;
        var lastSessionError = null;
        var ordinaryError = null;
        var inconclusive = 0;
        var attempted = 0;
        var firstId = "";
        if (candidates.length === 0) {
          noteAvailability({ sessionId: "", blocked: false, error: null, probeError: null, skipped: 0, probing: false, done: true });
          return;
        }
        noteAvailability({ sessionId: "", blocked: false, error: null, probeError: null, skipped: 0, probing: true, done: false });
        for (var i = 0; i < candidates.length; i++) {
          var candidate = candidates[i] || {};
          var id = String(candidate.sessionId !== undefined && candidate.sessionId !== null
            ? candidate.sessionId
            : (candidate.id !== undefined && candidate.id !== null ? candidate.id : ""));
          if (id === "") continue; // 占位项不探测
          if (firstId === "") firstId = id;
          attempted += 1;
          try {
            var status = await props.dsh.call("getStatus", id, {});
            setModeStatus(status && typeof status === "object" ? status : null);
            setSessionId(id);
            noteAvailability({
              sessionId: id,
              blocked: false,
              error: lastSessionError,
              probeError: ordinaryError,
              skipped: skipped,
              probing: false,
              done: true
            });
            return;
          } catch (error) {
            skipped += 1;
            if (isSessionUnavailableError(error)) {
              lastSessionError = sessionFailureOf(error);
            } else if (isProbeInconclusiveError(error)) {
              inconclusive += 1;
            } else if (!ordinaryError) {
              ordinaryError = sessionFailureOf(error);
            }
          }
        }
        if (attempted > 0 && inconclusive === attempted) {
          // transport 不可用：探测无法判定会话可用性，退回旧行为选中首条，
          // 由各 tab 的 ErrorBox 如实显示 shiori/ui-unavailable。
          setModeStatus(null);
          setSessionId(firstId);
          noteAvailability({ sessionId: firstId, blocked: false, error: null, probeError: null, skipped: 0, probing: false, done: true });
          return;
        }
        // 全部不可用：保持占位项（value 为空 / selectedIndex 0），sessionId 置空，
        // 面板不渲染任何 tab 的数据请求。
        setSessionId("");
        noteAvailability({
          sessionId: "",
          blocked: false,
          error: lastSessionError,
          probeError: ordinaryError,
          skipped: skipped,
          probing: false,
          done: true
        });
      };

      // 拉会话列表（带 3 次自动重试）并落地：
      //   成功（数组，空数组也算成功）→ 立刻 setSessions；有候选且当前没有选中会话
      //   （或来自「列表失败后手动刷新」）时立刻 probeCandidates，不额外延迟；
      //   三次都失败 → sessions=null，保持旧兜底（手填输入框 + 不可用提示 + 刷新）。
      // 读宿主工作区快照（同步）：失败/服务缺失一律当 null，面板不渲染工作区下拉。
      var loadWorkspaces = function () {
        var items = props.dsh && typeof props.dsh.listWorkspaces === "function" ? props.dsh.listWorkspaces() : null;
        setWorkspaces(Array.isArray(items) && items.length > 0 ? items : null);
      };

      var loadSessions = function (forceProbe) {
        if (sessionsRequestRef.current && sessionsRequestRef.current.pending) return;
        sessionsRequestRef.current = { pending: true };
        noteAvailability({ sessionId: sessionId, blocked: false, error: null, probeError: null, skipped: 0, probing: true, done: false });
        // 当前会话 id 透传给 normalize：blank 的当前会话不能被过滤掉
        // （用户在刚建的新会话里打开面板，下拉仍需看得到自己）。
        listSessionsWithRetry(props.dsh, props.sessionId || sessionId).then(function (items) {
          if (sessionsRequestRef.current) sessionsRequestRef.current.pending = false;
          if (Array.isArray(items)) {
            setSessions(items);
            if (items.length > 0 && (forceProbe || !sessionId)) {
              probeCandidates(items);
              return;
            }
            noteAvailability({ sessionId: sessionId, blocked: false, error: null, probeError: null, skipped: 0, probing: false, done: true });
            return;
          }
          // 明确失败：只在这里置 null（undefined=首帧未出结果，不显示不可用提示）。
          setSessions(null);
          noteAvailability({ sessionId: sessionId, blocked: false, error: null, probeError: null, skipped: 0, probing: false, done: true });
        });
      };

      useEffect(function () {
        loadWorkspaces();
        loadSessions(false);
      }, []);

      // 手动选择 / 刷新后的单会话探测：会话级失败进缓存并阻断该会话的数据请求，
      // 其他错误不缓存、不吞（回退旧行为，由对应 tab 的 ErrorBox 显示）。
      useEffect(function () {
        if (!sessionId) return undefined;
        if (availability && availability.sessionId === sessionId && availability.done && !availability.probing) return undefined;
        var cancelled = false;
        setAvailability({ sessionId: sessionId, blocked: false, error: null, probeError: null, skipped: 0, probing: true, done: false });
        props.dsh.call("getStatus", sessionId, {}).then(function (status) {
          if (cancelled) return;
          setModeStatus(status && typeof status === "object" ? status : null);
          setAvailability({ sessionId: sessionId, blocked: false, error: null, probeError: null, skipped: 0, probing: false, done: true });
        }, function (error) {
          if (cancelled) return;
          setModeStatus(null);
          if (isSessionUnavailableError(error)) {
            setAvailability({ sessionId: sessionId, blocked: true, error: sessionFailureOf(error), probeError: null, skipped: 1, probing: false, done: true });
          } else {
            // 非会话级错误：不缓存、不吞，让 tab 照旧挂载并自行显示错误（见 D）。
            setAvailability({ sessionId: sessionId, blocked: false, error: null, probeError: null, skipped: 0, probing: false, done: true });
          }
        });
        return function () { cancelled = true; };
      }, [sessionId, probeTick]);

      // tab 内部发现会话级失败（探测后会话被别的写句柄抢走等）：缓存到面板层，
      // 后续切 tab 不再重复发同一 RPC。
      var noteSessionUnavailable = function (error) {
        var previous = availability || {};
        var wasBlocked = Boolean(previous.blocked && previous.sessionId === sessionId);
        setAvailability({
          sessionId: sessionId,
          blocked: true,
          error: sessionFailureOf(error),
          probeError: null,
          // 该会话本身也算一次「不可用跳过」，与自动探测累计的跳过数合并。
          skipped: (previous.skipped || 0) + (wasBlocked ? 0 : 1),
          probing: false,
          done: true
        });
      };

      var retryProbe = function () {
        if (sessionsRequestRef.current && sessionsRequestRef.current.pending) return;
        setModeStatus(undefined);
        setAvailability({ sessionId: "", blocked: false, error: null, probeError: null, skipped: 0, probing: true, done: false });
        // 列表没拿到（null）或为空：先重新拉列表（同样带 3 次自动重试），成功后再探测。
        // 旧代码只有 sessions 非空才 probeCandidates，且从不重新拉列表，一次失败后
        // 「刷新」救不回来（只能刷新整页）——这是 owner 实机反馈的根因。
        if (sessions === null || sessions === undefined || !Array.isArray(sessions) || sessions.length === 0) {
          loadSessions(true);
          return;
        }
        if (sessionId === "") {
          probeCandidates(sessions);
          return;
        }
        setProbeTick(probeTick + 1);
      };

      var mode = modeStatus && typeof modeStatus.mode === "string" ? modeStatus.mode : null;
      var sessionBlocked = Boolean(availability && availability.blocked && availability.sessionId === sessionId);
      var sessionProbing = Boolean(availability && availability.probing);
      var hintLines = [];
      if (availability && availability.probeError) hintLines.push(sessionUnavailableText(availability.probeError));
      if (availability && availability.error) hintLines.push(sessionUnavailableText(availability.error));
      if (availability && availability.skipped > 0) hintLines.push("已跳过 " + availability.skipped + " 个宿主不可用的会话。");
      var sessionHint = sessionProbing
        ? h("div", { className: "dshi_hint" }, "正在探测会话可用性…")
        : hintLines.length > 0
          ? h("div", { className: "dshi_hint" },
              hintLines.join(" "),
              h("button", { className: "dshi_btn", style: { marginLeft: 8 }, onClick: retryProbe }, "刷新"))
          : null;
      // 工作区 → 会话 反查表：宿主 session 列表不带 workspaceId，用 workspaces 快照的
      // sessionIds 补上，才能「先选工作区、再选会话」。
      var workspaceOptions = Array.isArray(workspaces) ? workspaces : [];
      var workspaceOfSession = {};
      for (var wi = 0; wi < workspaceOptions.length; wi++) {
        var wsItem = workspaceOptions[wi];
        var wsIds = Array.isArray(wsItem.sessionIds) ? wsItem.sessionIds : [];
        for (var wj = 0; wj < wsIds.length; wj++) workspaceOfSession[String(wsIds[wj])] = wsItem.workspaceId;
      }
      // 每个工作区里「当前列表可见」的会话数（会话列表没拿到时不显示计数，避免写 0）。
      var workspaceSessionCount = {};
      var haveSessions = Array.isArray(sessions);
      if (haveSessions) {
        for (var ci = 0; ci < sessions.length; ci++) {
          var ownerWs = workspaceOfSession[String(sessions[ci].sessionId)];
          if (ownerWs !== undefined) workspaceSessionCount[ownerWs] = (workspaceSessionCount[ownerWs] || 0) + 1;
        }
      }
      // 会话下拉的可见项：选了工作区就只列该工作区的会话；当前会话始终保留，
      // 否则切工作区后选中项会从下拉里消失，看起来像「会话丢了」。
      var visibleSessions = haveSessions ? sessions : [];
      if (workspaceId !== "") {
        var filteredSessions = [];
        for (var vi = 0; vi < visibleSessions.length; vi++) {
          var visibleOne = visibleSessions[vi];
          var visibleId = String(visibleOne.sessionId !== undefined && visibleOne.sessionId !== null ? visibleOne.sessionId : "");
          if (workspaceOfSession[visibleId] === workspaceId || (sessionId !== "" && visibleId === sessionId)) filteredSessions.push(visibleOne);
        }
        visibleSessions = filteredSessions;
      }
      var budgets = props.budgets;
      // U8 sticky 壳条：工作区/会话选择器与 tab 栏包进一个 position:sticky 容器，
      // 随宿主面板滚动保持固定；三个提示行留在壳条之后不粘。壳条占据自身布局
      // 空间并有不透明底（--dshi-bg-card）+ 底边线，页面内容从壳条下方滚动，
      // 不会被遮死。
      return h("div", { className: "dshi_root" },
        h("div", { className: "dshi_hero" },
          h("span", { className: "dshi_logo" }, "栞"),
          h("div", { className: "dshi_heroText" },
            h("div", { className: "dshi_title" }, "Shiori 记忆面板"),
            h("div", { className: "dshi_titleSub" }, "dsh-shiori · 原生 bundle 面板 · 记忆的分层视图"))),
        h("div", { className: "dshi_sticky" },
          workspaceOptions.length > 0
            ? h("div", { className: "dshi_row" },
                h("label", { className: "dshi_label" }, "工作区（先选工作区，再选会话）",
                  h("select", {
                    className: "dshi_select",
                    value: workspaceId,
                    onChange: function (event) { setWorkspaceId(event.target.value); }
                  },
                    h("option", { value: "" }, "— 全部工作区 —"),
                    workspaceOptions.map(function (item) {
                      var count = workspaceSessionCount[item.workspaceId];
                      var label = count !== undefined ? item.title + "（" + count + " 个会话）" : item.title;
                      return h("option", { key: item.workspaceId, value: item.workspaceId, title: item.path || item.workspaceId }, label);
                    }))))
            : null,
          h("div", { className: "dshi_row" },
            h("label", { className: "dshi_label" }, "会话（宿主解析，owner 授权）",
              sessions === null || sessions === undefined
                ? h("input", { className: "dshi_input", placeholder: "session id", value: sessionId || manual, onChange: function (event) { setManual(event.target.value); setSessionId(event.target.value); } })
                : h("select", {
                    className: "dshi_select",
                    value: sessionId,
                    onChange: function (event) { setSessionId(event.target.value); }
                  },
                    h("option", { value: "" }, "— 选择会话 —"),
                    visibleSessions.map(function (item) {
                      var id = String(item.sessionId ?? item.id ?? "");
                      // 有标题显示标题（超长截断），无标题回退 sessionId；
                      // option 的 title 属性放完整 sessionId，便于悬停排查。
                      return h("option", { key: id, value: id, title: id }, sessionOptionLabel(item));
                    })))),
          h("div", { className: "dshi_tabs" }, TABS.map(function (entry) {
            return h("button", {
              key: entry.id,
              // U8 tab 图标：CSS mask 内联 SVG（dshi_tabIco-<id>，见 var CSS 尾部），
              // 纯装饰伪元素、不进按钮子节点——label 文本仍是唯一 children，
              // 既有标签断言与 DOM 形状零改动。
              className: "dshi_tab dshi_tabIco dshi_tabIco-" + entry.id + (tab === entry.id ? " dshi_tabOn" : ""),
              onClick: function () { setTab(entry.id); }
            }, entry.label);
          }))),
        // 只有确定失败（null）才提示；undefined=首帧结果未出，不误报「不可用」。
        sessions === null
          ? h("div", { className: "dshi_hint" },
              "宿主 session 列表不可用（remote.session 服务未挂载）；请手动输入 session id。",
              h("button", {
                className: "dshi_btn",
                style: { marginLeft: 8 },
                disabled: Boolean(availability && availability.probing),
                onClick: retryProbe
              }, "刷新"))
          : null,
        // 会话下拉下方的一行提示：自动跳过的原因 / 跳过数量 / 当前会话被判定不可用。
        sessionHint,
        workspaceId !== "" && haveSessions && visibleSessions.length === 0
          ? h("div", { className: "dshi_hint" }, "该工作区下没有可显示的会话，切到「全部工作区」看看。")
          : null,
        sessionProbing
          ? h("div", { className: "dshi_loading" }, "正在探测会话可用性…")
          : sessionId === ""
            ? h("div", { className: "dshi_hint" }, availability && availability.done && availability.skipped > 0
                ? "未选择会话：已尝试的会话均被宿主判定为不可用。换一个会话、稍后点上方「刷新」重试，或手动输入会话 id。选择或输入会话后展示（状态/记忆/图谱/候选均按该会话的可信 scope 解析）。"
                : "未选择会话。选择或输入会话后展示（状态/记忆/图谱/候选均按该会话的可信 scope 解析）。")
            : sessionBlocked
              ? h("div", { className: "dshi_hint" }, "当前会话被宿主标记为不可用，已暂停对该会话的数据请求。换一个会话，或点上方「刷新」强制重试。")
              : h(fragment, null,
                  tab === "status" ? h(StatusTab, { dsh: props.dsh, sessionId: sessionId, onSessionUnavailable: noteSessionUnavailable }) : null,
                  tab === "budgets" ? h(BudgetsTab, { dsh: props.dsh, sessionId: sessionId, notifyRestart: notifyRestart }) : null,
                  // 数据 tab（记忆/图谱/候选）：模式探测中或非 active 时以占位替代，不发数据请求
                  tab !== "status" && tab !== "budgets" && modeStatus === undefined
                    ? h("div", { className: "dshi_loading" }, "能力探测中…") : null,
                  tab !== "status" && tab !== "budgets" && modeStatus !== undefined && mode !== "active"
                    ? ModePlaceholder(mode) : null,
                  tab === "memory" && (modeStatus === null || mode === "active") ? h(MemoryTab, { dsh: props.dsh, sessionId: sessionId, budgets: budgets, onSessionUnavailable: noteSessionUnavailable }) : null,
                  tab === "graph" && (modeStatus === null || mode === "active") ? h(GraphTab, { dsh: props.dsh, sessionId: sessionId, onSessionUnavailable: noteSessionUnavailable }) : null,
                  tab === "candidates" && (modeStatus === null || mode === "active") ? h(CandidatesTab, { dsh: props.dsh, sessionId: sessionId, onSessionUnavailable: noteSessionUnavailable }) : null,
                  tab === "topics" && (modeStatus === null || mode === "active") ? h(TopicsTab, { dsh: props.dsh, sessionId: sessionId, onSessionUnavailable: noteSessionUnavailable }) : null));
    }

    // ── 客户端入口：$mount → 槽位注册，全部 disposer 逆序释放 ────────────────
    var inject = ["remote", "slots", "configForms"];

    async function apply(ctx) {
      var disposers = [];
      var api = buildApi(ctx);
      // U8 可复用通知入口（需求 b/c 的「通过 ctx 传下去」形态）：后续页面/宿主
      // 可经 ctx.shioriNotify 调 toast 三态与需重启组合提示；dispose 供卸载清理。
      // 只增不改，不覆盖宿主已有字段。
      // 真机宿主（桌面端 / web）的 ctx 可能是冻结的只读对象：直接赋值会抛
      // TypeError 让 apply 变红。这是可选便利入口，拿不到就跳过；页面内部本来
      // 就走 props.notifyRestart 的同一条通路。
      try {
        if (!ctx.shioriNotify) {
          ctx.shioriNotify = { toast: shioriToast, restart: notifyRestart, dispose: disposeToastUi };
        }
      } catch { /* 只读 ctx：这是可选入口，静默跳过 */ }
      try {
        disposers.push(await ctx.remote.$mount(TYPERT_REMOTE));
      } catch (error) {
        for (var i = disposers.length - 1; i >= 0; i--) {
          try { await disposers[i](); } catch (cleanupError) { /* 逆序尽力释放 */ }
        }
        throw error;
      }
      var slotDisposer;
      try {
        slotDisposer = ctx.slots.inject("plugins.bundle.config", function () {
          return ctx.slots.register({ name: "plugins.bundle.config", key: "dsh-shiori" }, function (props) {
            return h(ShioriSection, assign({ dsh: api }, props));
          });
        });
      } catch (error) {
        for (var j = disposers.length - 1; j >= 0; j--) {
          try { await disposers[j](); } catch (cleanupError) { /* 同上 */ }
        }
        throw error;
      }
      return async function () {
        if (typeof slotDisposer === "function") {
          try { await slotDisposer(); } catch (cleanupError) { /* 同上 */ }
        }
        for (var k = disposers.length - 1; k >= 0; k--) {
          try { await disposers[k](); } catch (cleanupError) { /* 同上 */ }
        }
        // U8：卸载即清理 toast/横幅的全部定时器与节点（不许泄漏）。
        disposeToastUi();
      };
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.TYPERT_REMOTE = TYPERT_REMOTE;
    // 纯函数导出：宿主侧可直接验证 payload 无损性（R3 守卫，isRemoteJsonValue 同规则）
    exports.ensureLosslessJson = ensureLosslessJson;
    return module.exports;
  }
});
