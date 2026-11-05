// Generates the static prototype pages. Run: node _build.mjs  (reads ../tokens.json, writes ./*.html)
// Static mockup only: no app code. Icons are inline SVG stand-ins for MaterialCommunityIcons (names noted in COMPONENT_CATALOG).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const T = JSON.parse(fs.readFileSync(path.join(here, '../tokens.json'), 'utf8'));
const kebab = (s) => s.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
const px = (v) => `${v}px`;

// ---- tokens -> CSS variables (inlined into every page) ----
const vars = [];
for (const [k, v] of Object.entries(T.colors)) vars.push(`--c-${kebab(k)}:${v}`);
for (const [k, v] of Object.entries(T.spacing)) vars.push(`--sp-${k.slice(1)}:${px(v)}`);
for (const [k, v] of Object.entries(T.radii)) vars.push(`--r-${k}:${px(v)}`);
for (const [k, v] of Object.entries(T.fontSizes)) vars.push(`--fs-${kebab(k)}:${px(v)}`);
for (const [k, v] of Object.entries(T.fontSizesKds)) vars.push(`--kfs-${kebab(k)}:${px(v)}`);
for (const [k, v] of Object.entries(T.touch)) vars.push(`--t-${kebab(k)}:${px(v)}`);
const ROOT = `:root{${vars.join(';')}}`;

const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:#000}
body{font-family:Roboto,"Segoe UI",system-ui,sans-serif;color:var(--c-text-primary);font-size:var(--fs-body);line-height:24px;font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased}
button,input{font:inherit;color:inherit}
svg{width:24px;height:24px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;flex:none}
.phone{position:relative;width:412px;height:915px;overflow:hidden;background:var(--c-bg);display:flex;flex-direction:column}
.phone.land{width:915px;height:412px}
.sys{height:28px;flex:none;display:flex;align-items:center;justify-content:space-between;padding:0 16px;font-size:13px;font-weight:500;color:var(--c-text-secondary);line-height:28px}
.sys .r{display:flex;gap:6px;align-items:center}.sys svg{width:15px;height:15px}
.gest{height:20px;flex:none;display:flex;justify-content:center;align-items:center;background:inherit}
.gest i{width:120px;height:4px;border-radius:2px;background:var(--c-text-muted);opacity:.6}
.top{height:56px;flex:none;display:flex;align-items:center;gap:8px;padding:0 8px 0 16px;background:var(--c-surface);border-bottom:1px solid var(--c-border)}
.top.back{padding-left:4px}
.top .ttl{flex:1;min-width:0}
.top h1{font-size:20px;line-height:24px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.top .sub{font-size:14px;line-height:18px;color:var(--c-text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ib{width:48px;height:48px;border-radius:24px;border:0;background:transparent;display:flex;align-items:center;justify-content:center;color:var(--c-text-primary)}
.avatar{width:40px;height:40px;border-radius:20px;background:var(--c-surface-overlay);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px}
.content{flex:1;min-height:0;overflow:hidden;position:relative;display:flex;flex-direction:column}
.pad{padding:16px}
.scroll{flex:1;min-height:0;overflow:hidden}
/* connection pill */
.pill{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border-radius:14px;background:var(--c-surface-raised);font-size:13px;font-weight:600;line-height:28px;white-space:nowrap}
.pill i{width:10px;height:10px;border-radius:5px;display:block}
.pill.on i{background:var(--c-conn-online)}.pill.re i{background:var(--c-conn-reconnecting)}.pill.off i{background:var(--c-conn-offline)}
.pill.off{color:var(--c-danger-text)}.pill.re{color:var(--c-warning)}
/* banners */
.banner{height:36px;flex:none;display:flex;align-items:center;gap:8px;padding:0 16px;font-size:14px;font-weight:600}
.banner svg{width:18px;height:18px}
.banner.off{background:var(--c-offline-banner-bg);color:var(--c-offline-banner-fg)}
.banner.err{background:var(--c-error-banner-bg);color:var(--c-error-banner-fg)}
.banner.closed{background:var(--c-warning-tint);color:var(--c-warning)}
/* buttons */
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;border:0;border-radius:12px;height:56px;padding:0 20px;font-size:18px;font-weight:700;background:var(--c-primary);color:var(--c-text-on-accent);white-space:nowrap}
.btn.md{height:48px;font-size:16px}
.btn.sec{background:var(--c-surface-raised);color:var(--c-text-primary);box-shadow:inset 0 0 0 1.5px var(--c-text-muted)}
.btn.ghost{background:transparent;color:var(--c-primary-text)}
.btn.dng{background:var(--c-danger);color:var(--c-text-on-danger)}
.btn.dngo{background:transparent;color:var(--c-danger-text);box-shadow:inset 0 0 0 1.5px var(--c-danger-text)}
.btn.ok{background:var(--c-success);color:var(--c-success-tint)}
.btn.dis{background:var(--c-surface-raised);color:var(--c-text-disabled);box-shadow:none}
.btn.blk{width:100%}
.btn svg{width:22px;height:22px}
/* action bar + tabs */
.abar{flex:none;display:flex;gap:12px;padding:12px 16px;background:var(--c-surface);border-top:1px solid var(--c-border)}
.abar .btn{flex:1;padding:0 12px;font-size:17px}.abar .btn.w{flex:1.45}
.tabs{height:64px;flex:none;display:flex;background:var(--c-surface);border-top:1px solid var(--c-border)}
.tab{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;font-size:12px;font-weight:600;line-height:16px;color:var(--c-text-muted);position:relative}
.tab.act{color:var(--c-primary-text)}
.tab.act::before{content:"";position:absolute;top:0;left:25%;right:25%;height:3px;border-radius:0 0 3px 3px;background:var(--c-primary)}
.badge{position:absolute;top:6px;left:calc(50% + 6px);min-width:20px;height:20px;border-radius:10px;background:var(--c-danger);color:#fff;font-size:12px;font-weight:700;line-height:20px;text-align:center;padding:0 5px}
/* chips */
.chip{display:inline-flex;align-items:center;gap:4px;height:26px;padding:0 10px;border-radius:13px;font-size:13px;font-weight:700;line-height:26px;white-space:nowrap}
.chip svg{width:15px;height:15px;stroke-width:2.5}
.s-sent{background:var(--c-item-sent-bg);color:var(--c-item-sent-fg)}
.s-prog{background:var(--c-item-in-progress-bg);color:var(--c-item-in-progress-fg)}
.s-ready{background:var(--c-item-ready-bg);color:var(--c-item-ready-fg)}
.s-served{background:var(--c-item-served-bg);color:var(--c-item-served-fg)}
.s-canc{background:var(--c-item-cancelled-bg);color:var(--c-item-cancelled-fg)}
.s-free{background:var(--c-table-free-bg);color:var(--c-table-free-fg)}
.s-occ{background:var(--c-table-occupied-bg);color:var(--c-table-occupied-fg)}
.s-bill{background:var(--c-table-bill-bg);color:var(--c-table-bill-fg)}
.s-inact{background:var(--c-table-inactive-bg);color:var(--c-table-inactive-fg);box-shadow:inset 0 0 0 1px var(--c-table-inactive-border)}
/* floor */
.sec-h{display:flex;justify-content:space-between;align-items:baseline;padding:8px 16px 4px;font-size:14px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--c-text-secondary)}
.sec-h span{font-weight:500;letter-spacing:0;text-transform:none;color:var(--c-text-muted)}
.grid{display:grid;gap:8px;padding:0 16px}
.g2{grid-template-columns:1fr 1fr}.g3{grid-template-columns:1fr 1fr 1fr}
.tc{border-radius:12px;padding:8px 10px;border:1.5px solid;display:flex;flex-direction:column;justify-content:space-between;position:relative;overflow:hidden}
.tc.pool{height:76px}.tc.reg{height:68px}
.tc .code{font-size:20px;line-height:24px;font-weight:700;color:var(--c-text-primary)}
.tc .row{display:flex;justify-content:space-between;align-items:center;gap:4px}
.tc .who{font-size:14px;line-height:18px;color:var(--c-text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tc .tm{font-size:20px;font-weight:700;line-height:24px;color:var(--c-text-primary)}
.tc .lbl{font-size:12px;font-weight:700;line-height:16px;display:flex;align-items:center;gap:3px}
.tc .lbl svg{width:14px;height:14px;stroke-width:2.6}
.tc.free{background:var(--c-table-free-bg);border-color:var(--c-table-free-border)}.tc.free .lbl{color:var(--c-table-free-fg)}
.tc.occ{background:var(--c-table-occupied-bg);border-color:var(--c-table-occupied-border)}.tc.occ .lbl{color:var(--c-table-occupied-fg)}
.tc.bill{background:var(--c-table-bill-bg);border-color:var(--c-table-bill-border)}.tc.bill .lbl{color:var(--c-table-bill-fg)}
.tc.inact{background:var(--c-table-inactive-bg);border-color:var(--c-table-inactive-border);border-style:dashed}.tc.inact .lbl,.tc.inact .code{color:var(--c-table-inactive-fg)}
.tc.stale{opacity:.7}
/* toast */
.toast{position:absolute;left:12px;right:12px;top:8px;z-index:5;display:flex;align-items:center;gap:12px;min-height:56px;padding:8px 8px 8px 14px;border-radius:12px;background:var(--c-success);color:var(--c-success-tint);box-shadow:0 6px 16px rgba(0,0,0,.5);font-weight:700}
.toast .t2{font-size:14px;font-weight:500;line-height:18px}
.toast .btn{height:40px;font-size:14px;padding:0 14px;background:var(--c-success-tint);color:var(--c-success)}
/* ticket */
.hero{padding:12px 16px;background:var(--c-surface);display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--c-border)}
.hero .big{font-size:28px;line-height:32px;font-weight:700}
.hero .cap{font-size:13px;color:var(--c-text-muted);line-height:16px}
.line{display:flex;gap:12px;padding:12px 16px;border-bottom:1px solid var(--c-border);min-height:64px}
.line .q{width:32px;font-size:18px;font-weight:700;color:var(--c-primary-text);flex:none;line-height:24px}
.line .m{flex:1;min-width:0}
.line .n{font-size:16px;font-weight:600;line-height:22px}
.line .d{font-size:14px;line-height:19px;color:var(--c-text-secondary)}
.line .nt{display:inline-flex;align-items:center;gap:4px;font-size:14px;font-weight:600;color:var(--c-warning);line-height:19px}
.line .nt svg{width:14px;height:14px}
.line .p{text-align:right;display:flex;flex-direction:column;align-items:flex-end;gap:6px;flex:none}
.line .p b{font-size:16px;font-weight:700}
.line.canc .n,.line.canc .p b{text-decoration:line-through;color:var(--c-text-muted)}
.line.served .n{color:var(--c-text-secondary)}
.tot{padding:12px 16px;background:var(--c-surface);display:flex;flex-direction:column;gap:4px}
.tot .r{display:flex;justify-content:space-between;font-size:16px;line-height:24px;color:var(--c-text-secondary)}
.tot .r.t{font-size:22px;line-height:30px;font-weight:700;color:var(--c-text-primary);margin-top:4px}
.tot .est{color:var(--c-warning)}
.tot small{font-size:13px;line-height:17px;color:var(--c-text-muted)}
.draftbar{margin:8px 16px;padding:0 12px;min-height:48px;border-radius:12px;background:var(--c-warning-tint);color:var(--c-warning);display:flex;align-items:center;justify-content:space-between;font-weight:700;font-size:15px;border:1.5px solid var(--c-warning)}
/* menu */
.search{margin:12px 16px 0;height:48px;border-radius:12px;background:var(--c-surface-raised);box-shadow:inset 0 0 0 1.5px var(--c-text-muted);display:flex;align-items:center;gap:8px;padding:0 12px;color:var(--c-text-muted)}
.chips{display:flex;gap:8px;padding:12px 16px;overflow:hidden}
.cat{flex:none;height:44px;padding:0 16px;border-radius:22px;background:var(--c-surface-raised);color:var(--c-text-secondary);font-weight:600;font-size:15px;line-height:44px}
.cat.act{background:var(--c-primary);color:var(--c-text-on-accent);font-weight:700}
.mi{position:relative;background:var(--c-surface-raised);border-radius:12px;padding:10px 12px;min-height:92px;display:flex;flex-direction:column;justify-content:space-between;border:1.5px solid transparent}
.mi .n{font-size:16px;font-weight:600;line-height:20px}
.mi .pr{font-size:16px;font-weight:700;color:var(--c-primary-text)}
.mi .ro{display:flex;justify-content:space-between;align-items:center}
.mi .ro svg{width:18px;height:18px;color:var(--c-text-muted)}
.mi.sold{background:var(--c-surface);border:1.5px dashed var(--c-border)}
.mi.sold .n,.mi.sold .pr{color:var(--c-text-muted)}
.mi.sold .pr{text-decoration:none;font-weight:700;color:var(--c-danger-text)}
.mi .qb{position:absolute;top:-6px;right:-6px;min-width:26px;height:26px;border-radius:13px;background:var(--c-primary);color:var(--c-text-on-accent);font-weight:700;font-size:14px;text-align:center;line-height:26px;padding:0 6px}
.mi.in{border-color:var(--c-primary)}
/* sheet */
.scrim{position:absolute;inset:0;background:rgba(0,0,0,.62);z-index:6}
.sheet{position:absolute;left:0;right:0;bottom:0;z-index:7;background:var(--c-surface);border-radius:24px 24px 0 0;display:flex;flex-direction:column;box-shadow:0 -8px 24px rgba(0,0,0,.5)}
.sheet .grab{width:40px;height:4px;border-radius:2px;background:var(--c-text-muted);margin:8px auto 0;opacity:.7}
.sheet .hd{padding:10px 16px 8px;display:flex;justify-content:space-between;align-items:flex-start}
.sheet .hd h2{font-size:22px;line-height:28px;font-weight:700}
.grp{padding:8px 16px}
.grp .gh{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}
.grp .gh b{font-size:16px}
.req{font-size:12px;font-weight:700;padding:2px 8px;border-radius:10px;line-height:18px}
.req.m{background:var(--c-warning-tint);color:var(--c-warning)}.req.o{background:var(--c-surface-raised);color:var(--c-text-secondary)}
.opt{display:flex;align-items:center;gap:12px;min-height:52px;padding:0 12px;border-radius:12px;background:var(--c-surface-raised);margin-bottom:6px;border:1.5px solid transparent;font-size:16px;font-weight:500}
.opt .bx{width:24px;height:24px;border-radius:6px;box-shadow:inset 0 0 0 2px var(--c-text-muted);display:flex;align-items:center;justify-content:center;flex:none}
.opt .bx svg{width:18px;height:18px;stroke-width:3.5;color:var(--c-text-on-accent)}
.opt.sel{border-color:var(--c-primary);background:var(--c-primary-tint)}
.opt.sel .bx{background:var(--c-primary);box-shadow:none}
.opt .x{margin-left:auto;color:var(--c-text-secondary);font-size:15px}
.field{height:48px;border-radius:12px;background:var(--c-surface-raised);box-shadow:inset 0 0 0 1.5px var(--c-text-muted);display:flex;align-items:center;padding:0 14px;font-size:16px;gap:8px}
.field.foc{box-shadow:inset 0 0 0 2px var(--c-focus-ring)}
.field.bad{box-shadow:inset 0 0 0 2px var(--c-danger-text)}
.lab{font-size:14px;font-weight:600;color:var(--c-text-secondary);margin:0 0 6px;line-height:20px}
.help{font-size:14px;color:var(--c-text-secondary);line-height:20px}
.stp{display:flex;align-items:center;gap:0;background:var(--c-surface-raised);border-radius:12px}
.stp button{width:56px;height:56px;border:0;background:transparent;display:flex;align-items:center;justify-content:center;color:var(--c-primary-text)}
.stp b{min-width:48px;text-align:center;font-size:24px}
.stp.sm button{width:48px;height:48px}.stp.sm b{min-width:32px;font-size:18px}
/* auth */
.auth{padding:24px;display:flex;flex-direction:column;gap:16px;flex:1}
.logo{width:96px;height:96px;border-radius:24px;object-fit:cover;display:block;margin:8px auto 0;box-shadow:0 0 0 2px var(--c-border)}
.logo.sm{width:72px;height:72px;border-radius:18px}
.h1{font-size:28px;line-height:34px;font-weight:700;text-align:center}
.lang{display:inline-flex;background:var(--c-surface-raised);border-radius:12px;padding:3px}
.lang span{min-width:56px;height:42px;line-height:42px;text-align:center;border-radius:10px;font-weight:700;color:var(--c-text-secondary)}
.lang span.a{background:var(--c-primary);color:var(--c-text-on-accent)}
.res{display:flex;gap:10px;align-items:center;padding:12px;border-radius:12px;font-weight:600;font-size:15px;line-height:20px}
.res.ok{background:var(--c-success-tint);color:var(--c-success)}
.res.bad{background:var(--c-danger-tint);color:var(--c-danger-text)}
.srv{display:flex;align-items:center;gap:8px;height:44px;padding:0 12px;border-radius:22px;background:var(--c-surface-raised);font-size:14px;color:var(--c-text-secondary);align-self:center}
/* ready list */
.card{background:var(--c-surface-raised);border-radius:16px;margin:0 16px 12px;overflow:hidden}
.card .ch{display:flex;justify-content:space-between;align-items:center;padding:12px 14px;background:var(--c-surface-overlay)}
.card .ch b{font-size:20px}
.card .ci{padding:12px 14px;display:flex;align-items:center;gap:12px;border-top:1px solid var(--c-border);min-height:76px}
.card .ci .m{flex:1;min-width:0}
.card .ci .n{font-size:17px;font-weight:600;line-height:22px}
.card .ci .d{font-size:14px;color:var(--c-text-secondary);line-height:19px}
/* stat */
.stat{background:var(--c-surface-raised);border-radius:16px;padding:12px 14px;display:flex;flex-direction:column;gap:2px;min-height:96px;border:1.5px solid transparent}
.stat .v{font-size:32px;line-height:38px;font-weight:700}
.stat .l{font-size:14px;color:var(--c-text-secondary);line-height:19px}
.stat .f{font-size:13px;line-height:17px;color:var(--c-text-muted)}
.stat.w{border-color:var(--c-table-bill-border);background:var(--c-table-bill-bg)}.stat.w .v{color:var(--c-warning)}
.stat.a{border-color:var(--c-danger);background:var(--c-danger-tint)}.stat.a .v{color:var(--c-danger-text)}
.alert{display:flex;gap:12px;padding:12px 14px;border-radius:12px;background:var(--c-surface-raised);margin:0 16px 8px;align-items:flex-start;border-left:6px solid}
.alert.r{border-color:var(--c-danger)}.alert.y{border-color:var(--c-warning)}
.alert b{display:block;font-size:15px;line-height:20px}.alert span{font-size:14px;color:var(--c-text-secondary);line-height:19px}
/* rows */
.kv{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:0 16px;min-height:48px;border-bottom:1px solid var(--c-border);font-size:16px}
.kv .k{color:var(--c-text-secondary);font-size:15px}
.kv .v{font-weight:600;text-align:right;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sw{width:52px;height:32px;border-radius:16px;background:var(--c-surface-overlay);position:relative;flex:none}
.sw::after{content:"";position:absolute;top:4px;left:4px;width:24px;height:24px;border-radius:12px;background:var(--c-text-muted)}
.sw.on{background:var(--c-primary)}.sw.on::after{left:24px;background:var(--c-text-on-accent)}
.gh2{padding:10px 16px 4px;font-size:13px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--c-text-muted)}
/* states */
.center{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:12px;padding:32px}
.center .ico{width:88px;height:88px;border-radius:44px;background:var(--c-surface-raised);display:flex;align-items:center;justify-content:center}
.center .ico svg{width:44px;height:44px}
.center h2{font-size:24px;line-height:30px}
.center p{color:var(--c-text-secondary);font-size:16px;line-height:23px;max-width:320px}
/* pin */
.dlg{position:absolute;left:20px;right:20px;top:150px;z-index:7;background:var(--c-surface-raised);border-radius:24px;padding:20px 16px 16px;box-shadow:0 12px 32px rgba(0,0,0,.6)}
.dlg h2{font-size:22px;text-align:center;line-height:28px}
.dlg p{font-size:15px;color:var(--c-text-secondary);text-align:center;margin-top:4px;line-height:21px}
.dots{display:flex;justify-content:center;gap:16px;margin:16px 0}
.dots i{width:18px;height:18px;border-radius:9px;box-shadow:inset 0 0 0 2px var(--c-text-muted)}.dots i.f{background:var(--c-primary-text);box-shadow:none}
.pad3{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.key{height:60px;border-radius:12px;background:var(--c-surface-overlay);display:flex;align-items:center;justify-content:center;font-size:26px;font-weight:600}
.key.z{background:transparent}
/* KDS */
.kbar{height:56px;flex:none;display:flex;align-items:center;gap:10px;padding:0 12px 0 16px;background:var(--c-surface);border-bottom:1px solid var(--c-border)}
.kbar h1{font-size:24px;line-height:28px;font-weight:700}
.seg{display:inline-flex;background:var(--c-surface-raised);border-radius:12px;padding:3px}
.seg span{padding:0 14px;height:40px;line-height:40px;border-radius:10px;font-weight:700;font-size:15px;color:var(--c-text-secondary)}
.seg span.a{background:var(--c-primary);color:var(--c-text-on-accent)}
.kcard{background:var(--c-surface);border-radius:16px;overflow:hidden;border:2px solid var(--c-border);display:flex;flex-direction:column;flex:none}
.kcard.k-warn{border-color:var(--c-age-warn-bg)}.kcard.k-alert{border-color:var(--c-age-alert-bg)}
.kh{display:flex;align-items:center;gap:10px;padding:8px 12px;background:var(--c-surface-raised)}
.kh .code{font-size:var(--kfs-ticket-code);line-height:38px;font-weight:700}
.kh .who{font-size:var(--kfs-meta);color:var(--c-text-secondary);flex:1;line-height:20px;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.age{display:inline-flex;align-items:center;gap:6px;height:44px;padding:0 12px;border-radius:12px;font-size:var(--kfs-age);font-weight:700;background:var(--c-age-neutral-bg);color:var(--c-age-neutral-fg);flex:none}
.age svg{width:22px;height:22px}
.age.a-warn{background:var(--c-age-warn-bg);color:var(--c-age-warn-fg)}.age.a-alert{background:var(--c-age-alert-bg);color:var(--c-age-alert-fg)}
.ki{display:flex;align-items:center;gap:12px;min-height:72px;padding:8px 12px 8px 0;border-top:1px solid var(--c-border);position:relative}
.ki::before{content:"";align-self:stretch;width:8px;background:var(--c-item-sent-bg);flex:none}
.ki.p::before{background:var(--c-item-in-progress-fg)}.ki.r::before{background:var(--c-item-ready-bg)}
.ki .q{font-size:var(--kfs-item-qty);font-weight:700;width:44px;text-align:right;flex:none;line-height:30px}
.ki .m{flex:1;min-width:0}
.ki .n{font-size:var(--kfs-item);font-weight:700;line-height:27px}
.ki .md{font-size:var(--kfs-modifier);color:var(--c-text-secondary);line-height:23px}
.ki .nt{display:inline-flex;align-items:center;gap:6px;margin-top:4px;padding:2px 10px;border-radius:8px;background:var(--c-warning);color:var(--c-text-on-accent);font-size:var(--kfs-note);font-weight:700;line-height:24px}
.ki .nt svg{width:18px;height:18px}
.ki .go{flex:none;min-width:104px;height:56px;border-radius:12px;display:flex;align-items:center;justify-content:center;gap:6px;font-weight:700;font-size:18px;box-shadow:inset 0 0 0 2px var(--c-text-muted);color:var(--c-text-primary);background:var(--c-surface-raised)}
.ki .go.pr{background:var(--c-primary);color:var(--c-text-on-accent);box-shadow:none}
.ki .go.dn{background:var(--c-item-ready-bg);color:var(--c-item-ready-fg);box-shadow:none}
.kf{padding:8px 12px 12px}
.kf .btn{width:100%;height:56px}
.kcol{display:flex;flex-direction:column;gap:12px;padding:12px;overflow:hidden;flex:1;min-height:0}
.krow{display:flex;gap:12px;padding:10px 12px;overflow:hidden;flex:1;min-height:0}
.kcard>*{flex-shrink:0}.krow .kcard{width:286px;align-self:flex-start}.land .ki{min-height:64px;gap:8px;padding-right:8px}.land .ki .q{width:36px;font-size:22px}.land .ki .n{font-size:20px;line-height:24px}.land .ki .md{font-size:16px;line-height:20px}.land .ki .nt{font-size:16px;line-height:22px}.land .ki .go{min-width:84px;height:52px;font-size:17px}.land .kh .code{font-size:28px}.land .age{font-size:24px;height:40px}.land .kf .btn{height:48px}
/* index */
.idx{background:var(--c-bg);min-height:100vh;padding:32px;max-width:1200px;margin:0 auto}
.idx h1{font-size:32px;line-height:40px}
.idx p{color:var(--c-text-secondary);margin:6px 0 24px;max-width:70ch}
.idx .g{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:20px}
.idx a{display:block;text-decoration:none;color:var(--c-text-primary);background:var(--c-surface);border:1px solid var(--c-border);border-radius:16px;padding:10px;font-weight:600}
.idx a:focus-visible,.idx a:hover{border-color:var(--c-primary)}
.idx img{width:100%;border-radius:10px;display:block;margin-bottom:8px;background:var(--c-surface-raised);aspect-ratio:412/915;object-fit:cover;object-position:top}
.idx img.l{aspect-ratio:915/412}
.idx small{display:block;color:var(--c-text-muted);font-weight:400;font-size:13px}
`;

// ---- icons (stroke, 24 viewBox). mdi names in comments map to the real app. ----
const I = {
  back: '<path d="M15 18l-6-6 6-6"/>', // arrow-left
  chev: '<path d="M9 18l6-6-6-6"/>', // chevron-right
  close: '<path d="M18 6L6 18M6 6l12 12"/>', // close
  plus: '<path d="M12 5v14M5 12h14"/>', // plus
  minus: '<path d="M5 12h14"/>', // minus
  check: '<path d="M5 13l4 4L19 7"/>', // check
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>', // magnify
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', // clock-outline
  wifi: '<path d="M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M12 19.5h.01"/>', // wifi
  wifioff: '<path d="M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M12 19.5h.01M3 3l18 18"/>', // wifi-off
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0"/>', // bell-outline
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5h.01"/>', // alert-circle-outline
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5"/>', // refresh
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>', // account-outline
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>', // lock-outline
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>', // logout
  receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6"/>', // receipt-text-outline
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>', // table-furniture
  fork: '<path d="M7 3v18M4 3v6a3 3 0 0 0 6 0V3M17 21V3c-3 2-4 6-4 9h4"/>', // silverware-fork-knife
  glass: '<path d="M5 4h14l-7 9zM12 13v8M8 21h8"/>', // glass-cocktail
  sliders: '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>', // tune-variant
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>', // chart-box-outline
  server: '<rect x="3" y="4" width="18" height="6" rx="1"/><rect x="3" y="14" width="18" height="6" rx="1"/><path d="M7 7h.01M7 17h.01"/>', // server
  ball: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.5"/>', // billiards
  send: '<path d="M22 2L11 13M22 2l-7 20-4-9-9-4z"/>', // send
  note: '<path d="M4 4h16v12H8l-4 4z"/>', // note-text-outline
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6zM12 8v5M12 16h.01"/>', // shield-alert-outline
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18-3-3-3-15 0-18"/>', // translate
  bksp: '<path d="M21 5H9l-6 7 6 7h12zM17 9l-6 6M11 9l6 6"/>', // backspace-outline
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>', // eye-outline
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>', // format-list-bulleted
  flame: '<path d="M12 3c1 4 5 5 5 10a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-3-1-5 1-9z"/>', // fire
  vol: '<path d="M4 9v6h4l5 4V5L8 9zM17 9a4 4 0 0 1 0 6"/>', // volume-high
  pool: '<circle cx="12" cy="12" r="9"/><path d="M12 6v12M6 12h12" opacity=".0"/><circle cx="12" cy="9" r="2"/>',
  cash: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="3"/>', // cash
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>', // content-copy
};
const ic = (n, cls = '') => `<svg viewBox="0 0 24 24" ${cls ? `class="${cls}"` : ''} aria-hidden="true">${I[n]}</svg>`;

// ---- shared fragments ----
const sys = (t = '21:47') => `<div class="sys"><span>${t}</span><span class="r">${ic('wifi')}<svg viewBox="0 0 24 24"><rect x="6" y="3" width="12" height="18" rx="2" fill="currentColor" stroke="none"/></svg>86%</span></div>`;
const gest = '<div class="gest"><i></i></div>';
const conn = (s = 'on') => `<span class="pill ${s}"><i></i>${{ on: 'En línea', re: 'Reconectando', off: 'Sin conexión' }[s]}</span>`;
const top = ({ title, sub, back, right = '' }) => `<header class="top ${back ? 'back' : ''}">${back ? `<button class="ib" aria-label="Atrás">${ic('back')}</button>` : ''}<div class="ttl"><h1>${title}</h1>${sub ? `<div class="sub">${sub}</div>` : ''}</div>${right}</header>`;
const chip = (cls, label, icon) => `<span class="chip ${cls}">${icon ? ic(icon) : ''}${label}</span>`;
const ITEM = {
  sent: ['s-sent', 'Enviado', 'send'],
  prog: ['s-prog', 'En preparación', 'flame'],
  ready: ['s-ready', 'Listo', 'check'],
  served: ['s-served', 'Servido', 'check'],
  canc: ['s-canc', 'Cancelado', 'close'],
};
const ich = (k) => chip(ITEM[k][0], ITEM[k][1], ITEM[k][2]);
const btn = (label, { k = '', icon = '', cls = '', style = '' } = {}) => `<button class="btn ${k} ${cls}" ${style ? `style="${style}"` : ''}>${icon ? ic(icon) : ''}${label}</button>`;
const tabs = (items, active) => `<nav class="tabs">${items.map(([ico, lab, badge], i) => `<div class="tab ${i === active ? 'act' : ''}">${ic(ico)}${lab}${badge ? `<span class="badge">${badge}</span>` : ''}</div>`).join('')}</nav>`;
const WAITER_TABS = [['grid', 'Mesas'], ['bell', 'Listos', 2], ['user', 'Yo']];
const MGR_TABS = [['chart', 'Resumen'], ['receipt', 'Tickets'], ['grid', 'Piso'], ['fork', 'Cocina/Barra'], ['user', 'Yo']];
const phone = (inner, cls = '') => `<div class="phone ${cls}">${inner}</div>`;
const page = (title, body, w = 412, h = 915) => `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=${w},initial-scale=1"><title>${title}</title><style>${ROOT}${CSS}</style></head><body>${body}</body></html>`;
const out = [];
const emit = (file, title, body, land = false, note = '') => out.push({ file, title, land, note, html: page(title, body, land ? 915 : 412, land ? 412 : 915) });

// ---- 01 server setup ----
emit('01-server-setup.html', 'Configurar servidor', phone(`${sys()}<div class="content"><div class="auth">
<img class="logo" src="assets/logo.jpg" alt="Bola 8 Pool Club">
<div><div class="h1">Conecta con tu bar</div><p class="help" style="text-align:center;margin-top:6px">Escribe la dirección del servidor del POS. Tu gerente te la da.</p></div>
<div><div class="lab">Dirección del servidor</div><div class="field foc">${ic('server')}http://192.168.1.20:8080</div></div>
${btn('Probar conexión', { k: 'sec', icon: 'refresh' })}
<div class="res ok">${ic('check')}<div>Conexión exitosa<div style="font-weight:400;color:var(--c-text-secondary)">Servidor responde en 38 ms</div></div></div>
<div style="flex:1"></div>
${btn('Continuar', { cls: 'blk' })}
<div style="display:flex;justify-content:center"><div class="lang"><span class="a">ES</span><span>EN</span></div></div>
</div></div>${gest}`), false, 'SCR-AUTH-01');

// ---- 02 login ----
emit('02-login.html', 'Inicio de sesión', phone(`${sys()}<div class="content"><div class="auth">
<img class="logo sm" src="assets/logo.jpg" alt="Bola 8 Pool Club">
<div class="h1">Hola, inicia sesión</div>
<div class="srv">${ic('server')} 192.168.1.20:8080 &nbsp;<b style="color:var(--c-primary-text)">Cambiar</b></div>
<div class="res bad">${ic('alert')}<div>Usuario o contraseña incorrectos. Revísalos e inténtalo otra vez.</div></div>
<div><div class="lab">Usuario</div><div class="field bad">${ic('user')}mariana</div></div>
<div><div class="lab">Contraseña</div><div class="field">${ic('lock')}<span style="flex:1;letter-spacing:3px">••••••••</span>${ic('eye')}</div></div>
${btn('Entrar', { cls: 'blk' })}
<div style="flex:1"></div>
<div style="display:flex;justify-content:center"><div class="lang"><span class="a">ES</span><span>EN</span></div></div>
</div></div>${gest}`), false, 'SCR-AUTH-02 (error de credenciales)');

// ---- 03 floor ----
const tc = (code, st, who = '', tm = '', pool = false) => {
  const m = { free: ['free', 'Libre', 'check'], occ: ['occ', 'Ocupada', 'user'], bill: ['bill', 'Cuenta', 'bell'], inact: ['inact', 'Inactiva', 'close'] }[st];
  return `<div class="tc ${m[0]} ${pool ? 'pool' : 'reg'} STALE"><div class="row"><span class="code">${code}</span><span class="lbl">${ic(m[2])}${m[1]}</span></div>${pool ? `<div class="row"><span class="who">${who}</span><span class="tm">${tm}</span></div>` : `<div class="who">${who || '&nbsp;'}</div>`}</div>`;
};
const floorBody = (stale = false, toast = '', banner = '') => {
  const fx = (s) => (stale ? s.replace('STALE', 'stale') : s.replace(' STALE', ''));
  return `${sys()}${top({ title: 'Mesas', sub: 'Mariana R. · Mesera', right: `${conn(stale ? 'off' : 'on')}<div class="avatar">MR</div>` })}${banner}
<div class="content">${toast}<div class="scroll">
<div class="sec-h">Billar <span>3 ocupadas · 1 cuenta</span></div>
<div class="grid g2">${[tc('BT1', 'occ', 'Carlos M.', '1:23:05', 1), tc('BT2', 'free', 'Libre', '', 1), tc('BT3', 'occ', 'Ana P.', '0:42:18', 1), tc('BT4', 'bill', 'Diego', '2:05:40', 1), tc('BT5', 'free', 'Libre', '', 1), tc('BT6', 'inact', 'Fuera de servicio', '', 1)].map(fx).join('')}</div>
<div class="sec-h">Mesas <span>3 ocupadas · 1 cuenta</span></div>
<div class="grid g3">${[tc('T1', 'occ', 'Fam. Ruiz'), tc('T2', 'free'), tc('T3', 'bill', 'Luis'), tc('T4', 'occ', 'Sofía'), tc('T5', 'free'), tc('T6', 'free'), tc('T7', 'occ', 'Equipo 3'), tc('T8', 'inact')].map(fx).join('')}</div>
<div class="sec-h">Barra <span>2 ocupadas</span></div>
<div class="grid g3">${[tc('B1', 'occ', 'Beto'), tc('B2', 'free'), tc('B3', 'occ', 'Nora'), tc('B4', 'free'), tc('B5', 'free'), tc('B6', 'free')].map(fx).join('')}</div>
</div></div>${tabs(WAITER_TABS, 0)}${gest}`;
};
emit('03-floor.html', 'Mesas', phone(floorBody(false, `<div class="toast">${ic('bell')}<div style="flex:1;line-height:20px">Listo: Alitas BBQ 10 pz<div class="t2">Mesa T4 · Cocina</div></div><button class="btn">Ver</button></div>`)), false, 'SCR-W-01 con aviso de pedido listo');

// ---- 04 ticket ----
const ln = (q, n, mods, note, st, price, cls = '') => `<div class="line ${cls}"><div class="q">${q}×</div><div class="m"><div class="n">${n}</div>${mods ? `<div class="d">${mods}</div>` : ''}${note ? `<div class="nt">${ic('note')}${note}</div>` : ''}</div><div class="p"><b>${price}</b>${ich(st)}</div></div>`;
emit('04-ticket.html', 'Cuenta BT1', phone(`${sys()}${top({ title: 'Billar BT1', sub: 'Carlos M. · abierta 20:24', back: 1, right: `${conn('on')}` })}
<div class="content"><div class="hero"><div><div class="cap">Tiempo de mesa</div><div class="big">1:23:05</div></div><div style="text-align:right">${chip('s-occ', 'Ocupada', 'user')}<div class="cap" style="margin-top:4px">$120.00 / hora</div></div></div>
<div class="draftbar"><span>2 productos por enviar</span><span style="color:var(--c-text-primary)">Revisar ›</span></div>
<div class="scroll">
${ln(3, 'Cerveza Corona', '', '', 'served', '$135.00', 'served')}
${ln(1, 'Alitas BBQ 10 pz', 'Salsa: Búfalo', '', 'prog', '$145.00')}
${ln(1, 'Hamburguesa clásica', '', 'sin cebolla', 'sent', '$119.00')}
${ln(1, 'Papas a la francesa', '', '', 'ready', '$65.00')}
${ln(1, 'Michelada', 'Sal y limón', '', 'served', '$65.00', 'served')}
${ln(1, 'Coca-Cola', '', '', 'canc', '$35.00', 'canc')}
</div>
<div class="tot"><div class="r"><span>Consumo</span><span>$529.00</span></div><div class="r"><span>Tiempo de mesa <b class="est">(estimado)</b></span><span class="est">≈ $166.00</span></div><small>El total final lo calcula el servidor al pedir la cuenta.</small></div></div>
<div class="abar">${btn('Agregar productos', { cls: 'w' })}${btn('Pedir cuenta', { k: 'sec' })}</div>${gest}`), false, 'SCR-W-02');

// ---- 05 menu ----
const mi = (n, pr, ro, o = {}) => `<div class="mi ${o.sold ? 'sold' : ''} ${o.q ? 'in' : ''}">${o.q ? `<span class="qb">${o.q}</span>` : ''}<div class="n">${n}</div><div class="ro"><span class="pr">${o.sold ? 'Agotado' : pr}</span>${ic(ro === 'k' ? 'fork' : 'glass')}</div></div>`;
const menuGrid = `<div class="grid g2" style="gap:12px">${[
  mi('Alitas BBQ 10 pz', '$145.00', 'k', { q: 1 }), mi('Hamburguesa clásica', '$119.00', 'k', { q: 1 }),
  mi('Papas a la francesa', '$65.00', 'k'), mi('Nachos con queso', '$95.00', 'k'),
  mi('Cerveza Corona', '$45.00', 'b'), mi('Michelada', '$65.00', 'b'),
  mi('Margarita', '$85.00', 'b'), mi('Tacos al pastor', '$89.00', 'k', { sold: 1 }),
  mi('Coca-Cola', '$35.00', 'b'), mi('Agua mineral', '$30.00', 'b'),
].join('')}</div>`;
const menuScreen = (extra = '') => `${sys()}${top({ title: 'Agregar a BT1', sub: 'Carlos M.', back: 1, right: conn('on') })}
<div class="content"><div class="search">${ic('search')}<span>Buscar producto</span></div>
<div class="chips"><span class="cat act">Todo</span><span class="cat">Alitas</span><span class="cat">Comida</span><span class="cat">Cervezas</span><span class="cat">Cocteles</span></div>
<div class="scroll">${menuGrid}</div></div>
<div class="abar">${btn('Revisar pedido (2)', { icon: 'send' })}</div>${gest}${extra}`;
emit('05-menu.html', 'Menú', phone(menuScreen()), false, 'SCR-W-03');

// ---- 06 configurator ----
const opt = (n, sel, x = '') => `<div class="opt ${sel ? 'sel' : ''}"><span class="bx">${sel ? ic('check') : ''}</span>${n}<span class="x">${x}</span></div>`;
emit('06-item-configurator.html', 'Configurar producto', phone(menuScreen(`<div class="scrim"></div><div class="sheet"><div class="grab"></div>
<div class="hd"><div><h2>Alitas BBQ 10 pz</h2><div class="help">$145.00 c/u · Cocina</div></div><button class="ib" aria-label="Cerrar">${ic('close')}</button></div>
<div class="grp"><div class="gh"><b>Salsa</b><span class="req m">Obligatorio · elige 1 a 2</span></div>${opt('BBQ', 1)}${opt('Búfalo', 0)}${opt('Mango habanero', 1)}<div class="help" style="margin-top:-2px">2 de 2 elegidas · quita una para cambiar</div></div>
<div class="grp"><div class="gh"><b>Aderezo</b><span class="req o">Opcional</span></div>${opt('Ranch', 0, '+ $10.00')}</div>
<div class="grp"><div class="lab">Notas para cocina</div><div class="field">${ic('note')}<span>bien doradas</span></div></div>
<div style="display:flex;align-items:center;gap:12px;padding:8px 16px 12px"><div class="stp"><button aria-label="Menos">${ic('minus')}</button><b>2</b><button aria-label="Más">${ic('plus')}</button></div>${btn('Agregar al pedido', { cls: 'blk', style: 'flex:1' })}</div>${gest}</div>`)), false, 'SCR-W-04');

// ---- 07 draft review ----
const dl = (q, n, d, st, nt = '') => {
  const s = { sent: ['s-ready', 'Enviado', 'check'], sending: ['s-prog', 'Enviando…', 'refresh'], fail: ['s-canc', 'No se envió', 'alert'], pend: ['s-sent', 'Por enviar', 'clock'] }[st];
  return `<div class="line"><div class="m"><div class="n">${q}× ${n}</div>${d ? `<div class="d">${d}</div>` : ''}${nt ? `<div class="nt">${ic('note')}${nt}</div>` : ''}<div style="margin-top:6px">${chip(s[0], s[1], s[2])}</div></div><div class="p">${st === 'fail' ? `<button class="btn md sec" style="height:48px;padding:0 14px;font-size:15px">${ic('refresh')}Reintentar</button>` : st === 'pend' ? `<div class="stp sm"><button aria-label="Menos">${ic('minus')}</button><b>${q}</b><button aria-label="Más">${ic('plus')}</button></div>` : ''}</div></div>`;
};
emit('07-draft-review.html', 'Pedido por enviar', phone(`${sys()}${top({ title: 'Pedido por enviar', sub: 'Billar BT1 · Carlos M.', back: 1, right: conn('on') })}
<div class="banner err">${ic('alert')}1 producto no se envió. Revisa la conexión y reintenta.</div>
<div class="content"><div class="scroll">
${dl(1, 'Alitas BBQ 10 pz', 'Salsa: BBQ, Mango habanero', 'sent')}
${dl(1, 'Hamburguesa clásica', '', 'sending', 'sin cebolla')}
${dl(1, 'Papas a la francesa', '', 'fail')}
${dl(2, 'Michelada', 'Sal y limón', 'pend')}
</div><div class="tot"><div class="r"><span>Subtotal estimado</span><span>$459.00</span></div><small>Es una estimación. El servidor confirma precios y promociones.</small></div></div>
<div class="abar">${btn('Reintentar (2)', { icon: 'send' })}</div>${gest}`), false, 'SCR-W-05 (envío parcial con fallo)');

// ---- 08 ready list ----
const rc = (code, who, items) => `<div class="card"><div class="ch"><b>${code} <span style="font-weight:500;color:var(--c-text-secondary);font-size:16px">· ${who}</span></b>${items.length > 1 ? `<button class="btn md" style="height:44px;font-size:15px;padding:0 14px">Servir todo (${items.length})</button>` : ''}</div>${items.map(([q, n, d, src, age, w]) => `<div class="ci"><div class="m"><div class="n">${q}× ${n}</div><div class="d">${d ? d + ' · ' : ''}${src} · listo hace ${age}</div></div>${btn('Marcar servido', { k: 'ok', cls: 'md', style: 'height:56px;font-size:15px;padding:0 14px' })}</div>`).join('')}</div>`;
emit('08-ready-list.html', 'Listos', phone(`${sys()}${top({ title: 'Listos', sub: '4 productos esperando', right: conn('on') })}
<div class="content"><div class="scroll" style="padding-top:12px">
${rc('T4', 'Sofía', [[2, 'Alitas BBQ 10 pz', 'Salsa: BBQ', 'Cocina', '2:10'], [1, 'Papas a la francesa', '', 'Cocina', '0:45']])}
${rc('B1', 'Beto', [[3, 'Cerveza Corona', '', 'Barra', '1:20']])}
${rc('BT1', 'Carlos M.', [[1, 'Michelada', 'Sal y limón', 'Barra', '0:20']])}
</div></div>${tabs(WAITER_TABS, 1)}${gest}`), false, 'SCR-W-06');

// ---- KDS ----
const ki = (q, n, mods, note, st) => {
  const m = { sent: ['', 'go', 'Iniciar'], prog: ['p', 'go pr', 'Listo'], ready: ['r', 'go dn', 'Listo'] }[st];
  return `<div class="ki ${m[0]}"><div class="q">${q}×</div><div class="m"><div class="n">${n}</div>${mods ? `<div class="md">${mods}</div>` : ''}${note ? `<div class="nt">${ic('note')}${note}</div>` : ''}</div><div class="${m[1]}">${st === 'ready' ? ic('check') : ''}${m[2]}</div></div>`;
};
const kc = (code, who, age, lvl, items, all = true) => `<div class="kcard ${lvl ? 'k-' + lvl : ''}"><div class="kh"><span class="code">${code}</span><span class="who">${who}</span><span class="age ${lvl ? 'a-' + lvl : ''}">${ic('clock')}${age}</span></div>${items.join('')}${all ? `<div class="kf">${btn('Todo listo', { k: 'sec', icon: 'check' })}</div>` : ''}</div>`;
const kcards = [
  kc('BT1', 'Carlos M.', '23:10', 'alert', [ki(1, 'Alitas BBQ 10 pz', 'Salsa: Búfalo', '', 'prog'), ki(1, 'Papas a la francesa', '', '', 'sent')]),
  kc('T4', 'Sofía', '12:40', 'warn', [ki(1, 'Hamburguesa clásica', '', 'sin cebolla', 'prog'), ki(2, 'Nachos con queso', 'Extra jalapeño', '', 'sent')]),
  kc('T7', 'Equipo 3', '3:05', '', [ki(2, 'Alitas BBQ 10 pz', 'Salsa: BBQ, Mango habanero', 'bien doradas', 'sent')]),
];
emit('09-kds-portrait.html', 'KDS Cocina (vertical)', phone(`${sys()}<div class="kbar"><h1>Cocina</h1><div class="seg"><span class="a">Cocina</span><span>Barra</span></div><div style="flex:1"></div>${conn('on')}</div>
<div class="content"><div class="kcol">${kcards.join('')}</div></div>${gest}`), false, 'SCR-K-01 vertical');
emit('10-kds-landscape.html', 'KDS Cocina (horizontal)', `<div class="phone land"><div class="sys" style="height:24px;line-height:24px"><span>21:47</span><span class="r">${ic('wifi')}86%</span></div><div class="kbar" style="height:48px"><h1>Cocina</h1><span class="chip s-prog" style="height:30px;line-height:30px">5 pendientes</span><div class="seg"><span class="a" style="height:34px;line-height:34px">Cocina</span><span style="height:34px;line-height:34px">Barra</span></div><div style="flex:1"></div>${ic('vol')}${conn('on')}</div>
<div class="content"><div class="krow">${[kcards[0], kcards[1], kcards[2]].join('')}</div></div></div>`, true, 'SCR-K-01 horizontal');

// ---- 11 manager overview ----
emit('11-manager-overview.html', 'Resumen', phone(`${sys()}${top({ title: 'Resumen', sub: 'Rodrigo V. · Gerente', right: `${conn('on')}<div class="avatar">RV</div>` })}
<div class="content"><div class="scroll" style="padding-top:12px">
<div class="card" style="padding:14px;display:flex;justify-content:space-between;align-items:center"><div><div class="help">Caja</div><div style="font-size:24px;font-weight:700;line-height:30px;color:var(--c-success)">Abierta</div><div class="help">Desde 18:05 · fondo $1,000.00</div></div>${ic('cash').replace('<svg', '<svg style="width:40px;height:40px;color:var(--c-success)"')}</div>
<div class="grid g2" style="margin-bottom:12px">
<div class="stat"><div class="v">9</div><div class="l">Tickets abiertos</div><div class="f">4 billar · 5 mesas/barra</div></div>
<div class="stat w"><div class="v">2</div><div class="l">Cuentas solicitadas</div><div class="f">T3 · BT4</div></div>
<div class="stat"><div class="v">6</div><div class="l">Cocina pendientes</div><div class="f">2 en preparación</div></div>
<div class="stat"><div class="v">4</div><div class="l">Barra pendientes</div><div class="f">1 listo sin servir</div></div>
</div>
<div class="card" style="padding:14px;display:flex;align-items:center;gap:12px;border:2px solid var(--c-danger)"><span class="age a-alert">${ic('clock')}23:10</span><div><div style="font-weight:700">Producto más antiguo</div><div class="help">Cocina · BT1 · Alitas BBQ 10 pz</div></div></div>
<div class="gh2" style="padding-top:4px">Alertas</div>
<div class="alert r">${ic('alert')}<div><b>Cocina: más de 20 min</b><span>BT1 Alitas BBQ 10 pz lleva 23:10</span></div></div>
<div class="alert y">${ic('bell')}<div><b>Cuenta solicitada hace 9 min</b><span>T3 · Luis sigue abierta</span></div></div>
</div></div>${tabs(MGR_TABS, 0)}${gest}`), false, 'SCR-M-01');

// ---- 12 admin diagnostics ----
const kv = (k, v, extra = '') => `<div class="kv"><span class="k">${k}</span><span class="v" ${extra}>${v}</span></div>`;
const tg = (k, on) => `<div class="kv"><span>${k}</span><span class="sw ${on ? 'on' : ''}"></span></div>`;
emit('12-admin-diagnostics.html', 'Diagnóstico', phone(`${sys()}${top({ title: 'Sistema', sub: 'Diagnóstico y ajustes', right: conn('on') })}
<div class="content"><div class="scroll">
<div class="gh2">Conexión</div>
${kv('Servidor', 'http://192.168.1.20:8080')}${kv('Salud (/health)', `<span style="color:var(--c-success)">OK · 38 ms</span>`)}${kv('Tiempo real', `<span style="color:var(--c-success)">Conectado</span>`)}${kv('Salas', 'floor, kitchen, bar')}${kv('Última sincronización', '21:47:12 (hace 4 s)')}
<div class="gh2">Cuenta y app</div>
${kv('Usuario', 'admin · ADMIN')}${kv('Versión de la app', '0.1.0 (build 1)')}${kv('Versión del servidor', '1.4.2')}
<div class="gh2">Ajustes</div>
<div class="kv"><span>Idioma</span><div class="lang"><span class="a" style="min-width:48px;height:38px;line-height:38px">ES</span><span style="min-width:48px;height:38px;line-height:38px">EN</span></div></div>
${tg('Sonido de avisos', 1)}${tg('Vibración', 1)}${tg('Mantener pantalla encendida (KDS)', 1)}${tg('Texto grande en KDS', 0)}
<div style="display:flex;gap:12px;padding:16px">${btn('Probar conexión', { k: 'sec', cls: 'md', style: 'flex:1' })}${btn('Copiar datos', { k: 'sec', cls: 'md', icon: 'copy', style: 'flex:1' })}</div>
</div></div>${tabs([['chart', 'Resumen'], ['receipt', 'Tickets'], ['grid', 'Piso'], ['server', 'Sistema'], ['user', 'Yo']], 3)}${gest}`), false, 'SCR-A-01');

// ---- 13 offline ----
emit('13-offline.html', 'Sin conexión', phone(floorBody(true, '', `<div class="banner off">${ic('wifioff')}Sin conexión · datos de hace 3 min</div>`)), false, 'Estado sin conexión (Floor)');

// ---- 14 error ----
emit('14-error.html', 'Error', phone(`${sys()}${top({ title: 'Mesas', right: conn('on') })}
<div class="content"><div class="center"><div class="ico" style="background:var(--c-danger-tint);color:var(--c-danger-text)">${ic('alert')}</div><h2>No pudimos cargar las mesas</h2><p>El servidor respondió con un error. Inténtalo de nuevo; si sigue igual, avisa a tu gerente.</p><p style="font-size:13px;color:var(--c-text-muted)">Código: SERVER_ERROR · 21:47:31</p>${btn('Reintentar', { icon: 'refresh', cls: 'blk', style: 'width:280px' })}${btn('Ver detalles', { k: 'ghost', cls: 'md' })}</div></div>${tabs(WAITER_TABS, 0)}${gest}`), false, 'ErrorState genérico');

// ---- 15 PIN ----
emit('15-manager-pin.html', 'PIN de gerente', phone(`${sys()}${top({ title: 'Billar BT1', sub: 'Carlos M.', back: 1 })}
<div class="content"><div class="scroll">${ln(1, 'Michelada', 'Sal y limón', '', 'served', '$65.00', 'served')}${ln(1, 'Alitas BBQ 10 pz', 'Salsa: Búfalo', '', 'prog', '$145.00')}</div></div>${gest}
<div class="scrim"></div><div class="dlg"><h2>PIN de gerente</h2><p>Para cancelar Michelada pide a un gerente que escriba su PIN.</p>
<div class="dots"><i class="f"></i><i class="f"></i><i></i><i></i></div>
<div class="pad3">${['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((k) => `<div class="key">${k}</div>`).join('')}<div class="key z">${ic('close')}</div><div class="key">0</div><div class="key z">${ic('bksp')}</div></div>
<div style="display:flex;gap:12px;margin-top:12px">${btn('Cancelar', { k: 'sec', cls: 'md', style: 'flex:1' })}${btn('Confirmar', { cls: 'md dis', style: 'flex:1' })}</div></div>`), false, 'PinPad / ConfirmDialog');

// ---- 16 access denied ----
emit('16-access-denied.html', 'Sin acceso', phone(`${sys()}${top({ title: 'Sin acceso' })}
<div class="content"><div class="center"><div class="ico" style="background:var(--c-warning-tint);color:var(--c-warning)">${ic('shield')}</div><h2>Esta sección no es para tu rol</h2><p>Tu usuario (Cocina) no puede ver los reportes. Si lo necesitas, pídele acceso a tu gerente.</p>${btn('Ir a mi pantalla', { cls: 'blk', style: 'width:280px' })}${btn('Cerrar sesión', { k: 'dngo', icon: 'logout', cls: 'md' })}</div></div>${gest}`), false, 'SCR-X-01');

// ---- 17 splash / restoring session ----
emit('17-splash.html', 'Iniciando', phone(`${sys()}<div class="content"><div class="center" style="gap:20px"><img class="logo" src="assets/logo.jpg" alt="Bola 8 Pool Club"><div class="h1">Bola 8 Pool Club</div><div class="help">Restaurando tu sesión…</div><div style="width:160px;height:6px;border-radius:3px;background:var(--c-surface-raised);overflow:hidden"><div style="width:55%;height:100%;background:var(--c-primary)"></div></div></div></div>${gest}`), false, 'SCR-AUTH-00');

// ---- write files + index ----
for (const o of out) fs.writeFileSync(path.join(here, o.file), o.html);
const shots = (f) => `screenshots/${f.replace('.html', '.png')}`;
const idx = page('Prototipo Bola 8', `<main class="idx"><h1>Bola 8 Companion · prototipo</h1><p>Prototipo estático de alta fidelidad (412×915 dp). Tokens de <code>../tokens.json</code>, datos de ejemplo. Un archivo por pantalla; abre cada uno para verlo a tamaño real.</p><div class="g">${out.map((o) => `<a href="${o.file}"><img class="${o.land ? 'l' : ''}" src="${shots(o.file)}" alt="${o.title}">${o.title}<small>${o.note}</small></a>`).join('')}</div></main>`, 1200, 900);
fs.writeFileSync(path.join(here, 'index.html'), idx);
console.log(out.length + ' pages');
