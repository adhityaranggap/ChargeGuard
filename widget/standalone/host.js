// ChargeGuard standalone widget. It needs no Übersicht.
// It opens a transparent window on the desktop layer and shows the widget in a web view.
// Run: osascript -l JavaScript widget/standalone/host.js [widget-dir]
// widget-dir holds chargeguard.widget/ and standalone/. Default: ~/.chargeguard/app/widget.
ObjC.import("Cocoa");
ObjC.import("WebKit");

const MARGIN = 8; // gap from the screen edge to the window edge. The page adds 8 px more.
const HOME = ObjC.unwrap($.NSHomeDirectory());
const DEBUG = !!ObjC.unwrap($.NSProcessInfo.processInfo.environment.objectForKey($("CG_DEBUG")));

const readText = (path) => {
  const s = $.NSString.stringWithContentsOfFileEncodingError($(path), $.NSUTF8StringEncoding, null);
  if (!s || s.isNil()) throw new Error("Cannot read " + path);
  return ObjC.unwrap(s);
};

// Runs one command in /bin/sh. Returns [ok, stdout or error text].
const sh = (cmd) => {
  const task = $.NSTask.alloc.init;
  task.launchPath = "/bin/sh";
  task.arguments = $(["-c", cmd]);
  const env = $.NSMutableDictionary.dictionaryWithDictionary($.NSProcessInfo.processInfo.environment);
  env.setObjectForKey($(HOME + "/.chargeguard/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"), $("PATH"));
  task.environment = env;
  const outPipe = $.NSPipe.pipe;
  const errPipe = $.NSPipe.pipe;
  task.standardOutput = outPipe;
  task.standardError = errPipe;
  task.launch;
  const out = outPipe.fileHandleForReading.readDataToEndOfFile;
  const err = errPipe.fileHandleForReading.readDataToEndOfFile;
  task.waitUntilExit;
  const text = (d) => ObjC.unwrap($.NSString.alloc.initWithDataEncoding(d, $.NSUTF8StringEncoding)) || "";
  return task.terminationStatus === 0 ? [true, text(out)] : [false, text(err) || "exit " + task.terminationStatus];
};

function run(argv) {
  const dir = (argv && argv[0]) || HOME + "/.chargeguard/app/widget";

  const app = $.NSApplication.sharedApplication;
  app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);

  // A borderless window cannot become key, and a web view in a window that is not key
  // ignores the first click. These two subclasses let each click reach the widget.
  ObjC.registerSubclass({
    name: "CGWindow",
    superclass: "NSWindow",
    methods: {
      canBecomeKeyWindow: { types: ["bool", []], implementation: () => true },
    },
  });
  ObjC.registerSubclass({
    name: "CGWebView",
    superclass: "WKWebView",
    methods: {
      "acceptsFirstMouse:": { types: ["bool", ["id"]], implementation: () => true },
    },
  });

  // Start large. The page reports its real size, then the window shrinks to fit.
  let size = { w: 480, h: 640 };
  const win = $.CGWindow.alloc.initWithContentRectStyleMaskBackingDefer(
    $.NSMakeRect(0, 0, size.w, size.h), $.NSWindowStyleMaskBorderless, $.NSBackingStoreBuffered, false);
  win.setOpaque(false);
  win.setBackgroundColor($.NSColor.clearColor);
  win.setHasShadow(false);
  win.setAcceptsMouseMovedEvents(true);
  // One level below normal windows. At the desktop icon level, macOS does not send
  // clicks to the window. That is why Übersicht needs an interaction shortcut.
  win.setLevel($.NSNormalWindowLevel - 1);
  win.setCollectionBehavior(
    $.NSWindowCollectionBehaviorCanJoinAllSpaces | $.NSWindowCollectionBehaviorStationary |
    $.NSWindowCollectionBehaviorIgnoresCycle);

  // The page sends the corner from config.widget.corner. Start at the bottom left.
  let corner = "bottom-left";

  // Put the window in the corner of the primary screen, the one with the menu bar.
  // mainScreen is not used, because it follows the focus to other screens.
  // Cocoa y=0 is the bottom of the screen.
  const place = () => {
    const vf = $.NSScreen.screens.objectAtIndex(0).visibleFrame;
    const left = corner.endsWith("left");
    const bottom = corner.startsWith("bottom");
    const x = left ? vf.origin.x + MARGIN : vf.origin.x + vf.size.width - MARGIN - size.w;
    const y = bottom ? vf.origin.y + MARGIN : vf.origin.y + vf.size.height - MARGIN - size.h;
    win.setFrameDisplay($.NSMakeRect(x, y, size.w, size.h), true);
    if (DEBUG) {
      console.log("place " + JSON.stringify(size) + " vf=" + JSON.stringify(ObjC.deepUnwrap(vf)) +
        " frame=" + JSON.stringify(ObjC.deepUnwrap(win.frame)));
    }
  };

  const cfg = $.WKWebViewConfiguration.alloc.init;
  const ucc = cfg.userContentController;
  const add = (src) => ucc.addUserScript(
    $.WKUserScript.alloc.initWithSourceInjectionTimeForMainFrameOnly($(src), $.WKUserScriptInjectionTimeAtDocumentEnd, true));
  add(readText(dir + "/standalone/vendor/react.production.min.js"));
  add(readText(dir + "/standalone/vendor/react-dom.production.min.js"));
  add(readText(dir + "/standalone/vendor/babel.min.js"));
  add("window.__CG_SRC__ = " + JSON.stringify(readText(dir + "/chargeguard.widget/index.jsx")) + ";");
  add(readText(dir + "/standalone/page.js"));

  const web = $.CGWebView.alloc.initWithFrameConfiguration($.NSMakeRect(0, 0, size.w, size.h), cfg);
  web.setValueForKey(false, "drawsBackground");
  web.autoresizingMask = $.NSViewWidthSizable | $.NSViewHeightSizable;

  // Debug only: with CG_DEBUG=1, log the widget text after each size change.
  const dumpText = () => web.evaluateJavaScriptCompletionHandler(
    $("document.getElementById('root').innerText"), (res) => console.log("text: " + ObjC.unwrap(res)));

  const reply = (id, ok, out) => web.evaluateJavaScriptCompletionHandler(
    $("window.__cgReply(" + id + "," + ok + "," + JSON.stringify(out) + ")"), () => {});

  ObjC.registerSubclass({
    name: "CGBridge",
    superclass: "NSObject",
    methods: {
      "userContentController:didReceiveScriptMessage:": {
        types: ["void", ["id", "id"]],
        implementation: function (_c, message) {
          try {
            const m = ObjC.deepUnwrap(message.body);
            if (m.type === "run") {
              const [ok, out] = sh(m.cmd);
              reply(m.id, ok, out);
            } else if (m.type === "size") {
              size = { w: Math.max(m.w, 40), h: Math.max(m.h, 40) };
              place();
              if (DEBUG) dumpText();
            } else if (m.type === "corner") {
              corner = m.corner;
              place();
            } else if (m.type === "log") {
              console.log(new Date().toISOString() + " " + m.text);
            }
          } catch (e) {
            console.log("bridge error: " + e);
          }
        },
      },
    },
  });
  ucc.addScriptMessageHandlerName($.CGBridge.alloc.init, $("cg"));

  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:transparent;overflow:hidden;font-family:-apple-system,"SF Pro Text",system-ui,sans-serif;}
#root{position:fixed;left:0;bottom:0;width:max-content;padding:8px;}
</style></head><body><div id="root"></div></body></html>`;
  web.loadHTMLStringBaseURL($(html), $.NSURL.fileURLWithPath($(dir + "/standalone/")));

  win.contentView = web;
  place();
  win.orderFrontRegardless;
  console.log(new Date().toISOString() + " widget started from " + dir);

  // Send mouse events to the window. Keep the window in place when the screen layout or the Dock changes.
  app.finishLaunching;
  // NSEventMaskAny is 2^64-1. A JS number cannot hold it, and it becomes a mask with only bit 63.
  // Bits 0 to 52 hold an exact value and include all event types.
  const ALL_EVENTS = Number.MAX_SAFE_INTEGER;
  let next = Date.now() + 5000;
  for (;;) {
    const ev = app.nextEventMatchingMaskUntilDateInModeDequeue(
      ALL_EVENTS, $.NSDate.dateWithTimeIntervalSinceNow(1), $.NSDefaultRunLoopMode, true);
    if (ev && !ev.isNil()) {
      if (DEBUG && ev.type === $.NSEventTypeLeftMouseDown) {
        console.log("mouse down " + JSON.stringify(ObjC.deepUnwrap(ev.locationInWindow)));
      }
      app.sendEvent(ev);
    }
    if (Date.now() > next) {
      next = Date.now() + 5000;
      place();
    }
  }
}
