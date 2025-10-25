// Test worker for MultiTabWorkerBroker tests
// This simulates a JSONRPC server that actually processes requests differently
self.addEventListener("message", (event: MessageEvent) => {
  const message = event.data;

  if (message && typeof message === "object") {
    // Handle JSONRPC requests
    if ("method" in message && message.method) {
      const response: any = {
        jsonrpc: "2.0",
        id: message.id,
      };

      // Process different methods differently
      if (message.method === "add") {
        const { a, b } = message.params || {};
        response.result = (a || 0) + (b || 0);
      } else if (message.method === "echo") {
        response.result = message.params;
      } else if (message.method === "getBrokerId") {
        // Return something unique based on the params to distinguish responses
        response.result = `response-for-${message.params?.brokerId || "unknown"}`;
      } else {
        response.error = { code: -32601, message: "Method not found" };
      }

      self.postMessage(response);
    } else if ("id" in message) {
      // Generic request - just echo back
      self.postMessage(message);
    } else {
      // Notification (no id) - echo back
      self.postMessage(message);
    }
  }
});
