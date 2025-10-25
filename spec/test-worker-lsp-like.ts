// LSP-like worker that requires an 'initialized' notification before responding
let initialized = false;

self.addEventListener("message", (event: MessageEvent) => {
  const message = event.data as any;
  if (!message || typeof message !== "object") return;

  if ("method" in message && message.method) {
    if (message.method === "initialize") {
      // Respond to initialize but do not set initialized yet
      if ("id" in message) {
        self.postMessage({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } });
      }
      return;
    }
    if (message.method === "initialized") {
      initialized = true;
      return; // notification, no response
    }

    // If not initialized yet, ignore all other requests
    if (!initialized) {
      return; // simulate servers that ignore until 'initialized'
    }

    // After initialized, respond to simple methods
    if ("id" in message) {
      if (message.method === "echo") {
        self.postMessage({ jsonrpc: "2.0", id: message.id, result: message.params });
      } else if (message.method === "add") {
        const { a, b } = message.params || {};
        self.postMessage({ jsonrpc: "2.0", id: message.id, result: (a || 0) + (b || 0) });
      } else {
        self.postMessage({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
      }
    }
    return;
  }

  // Echo notifications as-is if initialized, otherwise ignore
  if (initialized) {
    self.postMessage(message);
  }
});
