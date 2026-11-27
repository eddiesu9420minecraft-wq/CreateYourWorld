import { spawn } from "node:child_process";
const c = spawn(process.argv[2], [], { detached: true, stdio: "ignore", env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9333" } });
c.unref(); console.log("pid", c.pid); process.exit(0);
