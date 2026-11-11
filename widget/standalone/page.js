// ChargeGuard standalone page. host.js injects this file after React and Babel.
// It gives the widget a "uebersicht" module, runs the widget, and talks to host.js.
(function () {
  var post = function (msg) {
    window.webkit.messageHandlers.cg.postMessage(msg);
  };
  var log = function (text) {
    post({ type: "log", text: String(text) });
  };

  // css tagged template. Returns a class name and injects the rules once.
  var sheet = document.createElement("style");
  document.head.appendChild(sheet);
  var counter = 0;
  function css(strings) {
    var text = strings[0];
    for (var i = 1; i < strings.length; i++) text += String(arguments[i]) + strings[i];
    var name = "cg-css-" + ++counter;
    sheet.appendChild(document.createTextNode("." + name + "{" + text + "}\n"));
    return name;
  }

  // run(cmd): host.js runs the command in /bin/sh and replies through __cgReply.
  var waiting = {};
  var nextId = 0;
  function run(cmd) {
    var id = ++nextId;
    return new Promise(function (resolve, reject) {
      waiting[id] = { resolve: resolve, reject: reject };
      post({ type: "run", id: id, cmd: String(cmd) });
    });
  }
  window.__cgReply = function (id, ok, out) {
    var w = waiting[id];
    if (!w) return;
    delete waiting[id];
    if (ok) w.resolve(out);
    else w.reject(new Error(out));
  };

  window.onerror = function (msg, src, line) {
    log("error: " + msg + " at line " + line);
  };

  try {
    var out = Babel.transform(window.__CG_SRC__, {
      filename: "index.jsx",
      presets: ["react", ["env", { modules: "commonjs", targets: { safari: "15" } }]],
    }).code;
    var shim = { run: run, css: css, React: window.React };
    var mod = { exports: {} };
    new Function("module", "exports", "require", out)(mod, mod.exports, function (name) {
      if (name === "uebersicht") return shim;
      throw new Error("Unknown module: " + name);
    });
    var w = mod.exports;
  } catch (e) {
    log("widget load failed: " + (e && e.stack ? e.stack : e));
    return;
  }

  var React = window.React;
  function Host() {
    // Übersicht calls updateState(event, previousState). React calls reducer(state, action).
    var pair = React.useReducer(function (s, a) { return w.updateState(a, s); }, w.initialState);
    var dispatch = pair[1];
    React.useEffect(function () {
      var tick = function () {
        run(w.command).then(function (o) {
          dispatch({ type: "UB/COMMAND_RAN", output: o });
        }, function (e) { log("status read failed: " + e.message); });
      };
      tick();
      var id = setInterval(tick, w.refreshFrequency || 2000);
      return function () { clearInterval(id); };
    }, []);
    // The window gives the position. The widget className position is not used here.
    return w.render(pair[0], dispatch);
  }

  var root = document.getElementById("root");

  // The widget CSS uses --cg-vh for its height limit, with 100vh as the fallback.
  // Here vh is the window height, and the window fits the widget, so a vh limit
  // shrinks in a loop. Give the screen height instead.
  var setVh = function () {
    root.style.setProperty("--cg-vh", screen.availHeight + "px");
  };
  setVh();
  window.addEventListener("resize", setVh);
  ReactDOM.createRoot(root).render(React.createElement(Host));

  // The widget puts the corner from the config on .cg-wrap as data-corner.
  // Pin the content to that corner of the page, and tell host.js to move the window.
  var corner = "";
  var setCorner = function () {
    var wrap = root.querySelector(".cg-wrap[data-corner]");
    var c = wrap ? wrap.getAttribute("data-corner") : "";
    if (!c || c === corner) return;
    corner = c;
    var top = c.indexOf("top") === 0;
    var left = c.indexOf("left") > 0;
    root.style.top = top ? "0" : "auto";
    root.style.bottom = top ? "auto" : "0";
    root.style.left = left ? "0" : "auto";
    root.style.right = left ? "auto" : "0";
    post({ type: "corner", corner: c });
  };
  new MutationObserver(setCorner).observe(root, {
    subtree: true, childList: true, attributes: true, attributeFilter: ["data-corner"],
  });

  // Tell host.js the content size, so the window fits the widget and no more.
  var last = "";
  new ResizeObserver(function () {
    var r = root.getBoundingClientRect();
    var size = Math.ceil(r.width) + "x" + Math.ceil(r.height);
    if (size === last) return;
    last = size;
    post({ type: "size", w: Math.ceil(r.width), h: Math.ceil(r.height) });
  }).observe(root);
})();
