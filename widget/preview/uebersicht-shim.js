// Minimal stand-in for the "uebersicht" module. Only the preview page loads it.
// It gives the widget: run(), css (tagged template), and React.
(function () {
  var counter = 0;
  var sheet = document.createElement("style");
  sheet.setAttribute("data-cg-shim", "css");
  document.head.appendChild(sheet);

  // Returns a class name. Injects the rules once.
  function css(strings) {
    var text = strings[0];
    for (var i = 1; i < strings.length; i++) {
      text += String(arguments[i]) + strings[i];
    }
    var name = "css-shim-" + ++counter;
    sheet.appendChild(document.createTextNode("." + name + "{" + text + "}\n"));
    return name;
  }

  // Logs the command. Does not run anything. Resolves with empty text.
  function run(cmd) {
    var text = String(cmd);
    if (text.indexOf("status.json") === -1) {
      console.log("[cg run]", text);
      window.dispatchEvent(new CustomEvent("cg-run", { detail: text }));
    }
    return Promise.resolve("");
  }

  window.__UEBERSICHT_SHIM__ = { run: run, css: css, React: window.React };
})();
