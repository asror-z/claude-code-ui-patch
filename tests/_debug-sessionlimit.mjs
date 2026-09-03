import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, "..", "src", "behaviorFeatures.autocontinue.ts");

const dom = new JSDOM(
  `<!doctype html><html><body><div id="root"><div role="textbox" aria-label="Message input" contenteditable="true"></div></div></body></html>`,
  { url: "https://example.test/", pretendToBeVisual: true, runScripts: "dangerously" }
);
const win = dom.window;
win.__ccOnChatDoc = function (fn) { fn(win.document, win); };
const calls = [];
let nextId = 1;
win.setTimeout = function (fn, delay) { const id = nextId++; calls.push({ id, delay }); return id; };
win.clearTimeout = function () {};

const el = win.document.createElement("div");
el.setAttribute("role", "alert");
el.className = "limitBanner_abc";
el.textContent = "You've hit your session limit · resets 11am (Asia/Karachi)";
win.document.getElementById("root").appendChild(el);

const source = readFileSync(SRC, "utf8");
const marker = "const JS = `";
const start = source.indexOf(marker);
const bodyStart = start + marker.length;
const end = source.indexOf("`.trim();", bodyStart);
let body = source.slice(bodyStart, end);
body = body.replace(/\\\\/g, "\\");

win.eval(body);
console.log("calls", JSON.stringify(calls));
console.log("localStorage armed", win.localStorage.getItem("cc-autocontinue-sessionlimit-armed"));
