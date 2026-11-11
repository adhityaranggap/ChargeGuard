// ChargeGuard prototype: a transparent desktop-layer window with a WKWebView.
// Run: osascript -l JavaScript proto/desktop-window.js
// It writes click results to /tmp/cg-proto.txt. It stops after 120 s.
ObjC.import("Cocoa");
ObjC.import("WebKit");

const app = $.NSApplication.sharedApplication;
app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);

const W = 340, H = 180, M = 24;
const scr = $.NSScreen.screens.objectAtIndex(0).visibleFrame;
// Top-right corner. Cocoa y=0 is the bottom of the screen.
const x = scr.origin.x + scr.size.width - W - M;
const y = scr.origin.y + scr.size.height - H - M;

const win = $.NSWindow.alloc.initWithContentRectStyleMaskBackingDefer(
  $.NSMakeRect(x, y, W, H), $.NSWindowStyleMaskBorderless, $.NSBackingStoreBuffered, false);
win.setOpaque(false);
win.setBackgroundColor($.NSColor.clearColor);
win.setHasShadow(false);
// Above desktop icons, below normal windows.
win.setLevel($.CGWindowLevelForKey($.kCGDesktopIconWindowLevelKey) + 1);
win.setCollectionBehavior(
  $.NSWindowCollectionBehaviorCanJoinAllSpaces | $.NSWindowCollectionBehaviorStationary | $.NSWindowCollectionBehaviorIgnoresCycle);

const cfg = $.WKWebViewConfiguration.alloc.init;
const web = $.WKWebView.alloc.initWithFrameConfiguration($.NSMakeRect(0, 0, W, H), cfg);
web.setValueForKey(false, "drawsBackground");

const html = `<!doctype html><html><body style="margin:0;background:transparent;font:14px -apple-system">
<div id="c" style="margin:8px;padding:16px;border-radius:20px;background:rgba(22,22,24,.78);color:#fff;backdrop-filter:blur(20px)">
<b>ChargeGuard test window</b><p style="margin:6px 0 12px;opacity:.8">Click the button. The count goes up.</p>
<button id="b" style="font:inherit;padding:8px 14px;border-radius:10px;border:0;background:#0A84FF;color:#fff">Click me</button>
<span id="n" style="margin-left:12px">0</span></div>
<script>let n=0;document.body.onclick=()=>{n++;document.getElementById('n').textContent=n;document.title='clicks:'+n;};</script>
</body></html>`;
web.loadHTMLStringBaseURL($(html), $.NSURL.URLWithString("about:blank"));

win.contentView = web;
win.orderFrontRegardless;
const full = $.NSScreen.screens.objectAtIndex(0).frame;
$(JSON.stringify({cx: x + W/2, cy: full.size.height - (y + H/2)})).writeToFileAtomicallyEncodingError("/tmp/cg-proto-pos.json", true, $.NSUTF8StringEncoding, null);

const out = "/tmp/cg-proto.txt";
$("started " + new Date().toISOString() + "\n").writeToFileAtomicallyEncodingError(out, true, $.NSUTF8StringEncoding, null);

let last = "";
const end = Date.now() + 180000;
while (Date.now() < end) {
  $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.25));
  const t = ObjC.unwrap(web.title) || "";
  if (t !== last) {
    last = t;
    $(`title=${t} at ${new Date().toISOString()}\n`).writeToFileAtomicallyEncodingError(out, true, $.NSUTF8StringEncoding, null);
  }
}
