// Send one left click at the window center from /tmp/cg-proto-pos.json.
ObjC.import("Cocoa"); ObjC.import("CoreGraphics");
const p = JSON.parse(ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError("/tmp/cg-proto-pos.json", $.NSUTF8StringEncoding, null)));
const pt = $.CGPointMake(p.cx, p.cy);
for (const t of [$.kCGEventLeftMouseDown, $.kCGEventLeftMouseUp]) {
  const e = $.CGEventCreateMouseEvent(null, t, pt, $.kCGMouseButtonLeft);
  $.CGEventPost($.kCGHIDEventTap, e);
  delay(0.1);
}
"clicked " + p.cx + "," + p.cy;
