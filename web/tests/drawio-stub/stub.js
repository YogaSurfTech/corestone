// draw.io's embed protocol, as the rich-text editor uses it: init, load (xml or
// xmlpng), autosave, save, export (xmlpng: a PNG with the source in a tEXt chunk
// "mxfile", URL-encoded, as draw.io writes it), exit.
const xml = document.getElementById("xml");
const post = (msg) => parent.postMessage(JSON.stringify(msg), "*");

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes) => {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** A PNG with a tEXt chunk "mxfile" (before IEND). */
function withSource(png, source) {
  const text = new TextEncoder().encode("mxfile\0" + encodeURIComponent(source));
  const chunk = new Uint8Array(12 + text.length);
  const dv = new DataView(chunk.buffer);
  dv.setUint32(0, text.length);
  chunk.set(new TextEncoder().encode("tEXt"), 4);
  chunk.set(text, 8);
  dv.setUint32(8 + text.length, crc32(chunk.subarray(4, 8 + text.length)));
  const end = png.length - 12; // IEND
  const out = new Uint8Array(png.length + chunk.length);
  out.set(png.subarray(0, end));
  out.set(chunk, end);
  out.set(png.subarray(end), end + chunk.length);
  return out;
}

/** The source in a PNG's tEXt chunk "mxfile". */
function sourceOf(png) {
  const dv = new DataView(png.buffer, png.byteOffset);
  for (let i = 8; i + 8 <= png.length;) {
    const len = dv.getUint32(i), type = String.fromCharCode(...png.subarray(i + 4, i + 8));
    if (type === "tEXt") {
      const data = new TextDecoder("latin1").decode(png.subarray(i + 8, i + 8 + len));
      if (data.startsWith("mxfile\0")) return decodeURIComponent(data.slice(7));
    }
    i += 12 + len;
  }
  return "";
}

window.addEventListener("message", (e) => {
  if (e.source !== parent || typeof e.data !== "string") return;
  const msg = JSON.parse(e.data);
  if (msg.action === "load") {
    xml.value = msg.xmlpng ? sourceOf(unb64(msg.xmlpng.split(",")[1])) : msg.xml ?? "";
    document.body.dataset.loaded = "1";
  } else if (msg.action === "export" && msg.format === "xmlpng") {
    const scale = msg.scale || 1, c = document.createElement("canvas");
    c.width = 300 * scale;
    c.height = 120 * scale;
    const g = c.getContext("2d");
    g.scale(scale, scale);
    g.strokeStyle = "#1565c0";
    g.lineWidth = 2;
    g.strokeRect(10, 10, 280, 100);
    g.fillStyle = "#1565c0";
    g.font = "16px sans-serif";
    g.fillText((msg.xml ?? "").slice(0, 30), 20, 64);
    const png = withSource(unb64(c.toDataURL("image/png").split(",")[1]), msg.xml ?? "");
    post({ event: "export", format: "xmlpng", xml: msg.xml, data: "data:image/png;base64," + b64(png), message: msg });
  }
});
xml.addEventListener("input", () => post({ event: "autosave", xml: xml.value }));
document.getElementById("save").addEventListener("click", () => post({ event: "save", xml: xml.value, exit: true }));
document.getElementById("exit").addEventListener("click", () => post({ event: "exit" }));
post({ event: "init" });
