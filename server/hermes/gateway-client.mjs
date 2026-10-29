import { EventEmitter } from "node:events";

export class HermesGatewayError extends Error {
  constructor(message, code = null, data = null) {
    super(message);
    this.name = "HermesGatewayError";
    this.code = code;
    this.data = data;
  }
}

export class HermesGatewayClient extends EventEmitter {
  #socket = null;
  #requestId = 0;
  #pending = new Map();
  #readyPromise = null;
  #readyResolve = null;
  #readyReject = null;

  get connected() {
    return this.#socket?.readyState === WebSocket.OPEN;
  }

  async connect(url, timeoutMs = 15_000) {
    if (this.connected) return;
    if (this.#readyPromise) return this.#readyPromise;

    this.#readyPromise = new Promise((resolve, reject) => {
      this.#readyResolve = resolve;
      this.#readyReject = reject;
    });

    const socket = new WebSocket(url);
    this.#socket = socket;
    const timeout = setTimeout(() => {
      this.#readyReject?.(new HermesGatewayError("Hermes Gateway 连接超时。"));
      socket.close();
    }, timeoutMs);

    socket.addEventListener("message", (message) => {
      const frames = String(message.data || "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      for (const frame of frames) this.#onFrame(frame);
    });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      this.#readyReject?.(new HermesGatewayError("Hermes Gateway WebSocket 连接失败。"));
    });
    socket.addEventListener("close", (event) => {
      clearTimeout(timeout);
      const error = new HermesGatewayError(
        `Hermes Gateway 已断开${event.code ? `（${event.code}）` : ""}。`,
        event.code || null,
      );
      this.#readyReject?.(error);
      for (const pending of this.#pending.values()) pending.reject(error);
      this.#pending.clear();
      this.#readyPromise = null;
      this.emit("disconnect", error);
    });

    try {
      await this.#readyPromise;
      clearTimeout(timeout);
    } catch (error) {
      clearTimeout(timeout);
      this.#readyPromise = null;
      throw error;
    }
  }

  #onFrame(frame) {
    let message;
    try {
      message = JSON.parse(frame);
    } catch {
      this.emit("protocol-error", { frame });
      return;
    }

    if (message.id != null) {
      const pending = this.#pending.get(String(message.id));
      if (!pending) return;
      this.#pending.delete(String(message.id));
      if (message.error) {
        pending.reject(
          new HermesGatewayError(
            message.error.message || "Hermes JSON-RPC 请求失败。",
            message.error.code,
            message.error.data,
          ),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method === "event") {
      const params = message.params || {};
      if (params.type === "gateway.ready") {
        this.#readyResolve?.(params.payload || {});
        this.#readyResolve = null;
        this.#readyReject = null;
      }
      this.emit("event", {
        type: params.type || "unknown",
        sessionId: params.session_id || "",
        payload: params.payload || {},
        raw: message,
      });
    }
  }

  request(method, params = {}, timeoutMs = 30_000) {
    if (!this.connected) {
      return Promise.reject(new HermesGatewayError("Hermes Gateway 尚未连接。"));
    }
    this.#requestId += 1;
    const id = `trace-${this.#requestId}`;
    const message = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new HermesGatewayError(`Hermes RPC ${method} 超时。`));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      this.#socket.send(JSON.stringify(message));
    });
  }

  close() {
    const socket = this.#socket;
    this.#socket = null;
    this.#readyPromise = null;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, "trace-server-shutdown");
  }
}
