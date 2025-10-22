// Simple test worker for MultiTabWorkerBroker tests
self.addEventListener("message", (event: MessageEvent) => {
  const message = event.data;

  // Echo back messages for testing
  if (message && typeof message === "object") {
    self.postMessage(message);
  }
});
