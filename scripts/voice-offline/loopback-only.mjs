// Test-process preload, not application code. Reject TCP egress before DNS/connect.
import * as NodeNet from "node:net";
const connect = NodeNet.Socket.prototype.connect;
NodeNet.Socket.prototype.connect = function (...args) {
  const values = Array.isArray(args[0]) ? args[0] : args;
  const options = values[0];
  const host = typeof options === "object" ? options.host : values[1];
  const unix =
    typeof options === "object"
      ? options.path
      : typeof options === "string" && !/^\d+$/.test(options);
  if (
    !unix &&
    host !== undefined &&
    typeof host !== "function" &&
    !["localhost", "127.0.0.1", "::1"].includes(host)
  ) {
    throw new Error(`Offline voice harness blocked TCP egress to ${host}`);
  }
  return Reflect.apply(connect, this, args);
};
