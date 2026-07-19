export function createDesktopProcessTerminator({ app, processRef = process } = {}) {
  if (!app || typeof app.exit !== "function" || !processRef || typeof processRef.once !== "function") {
    throw new TypeError("Desktop process termination requires Electron app and process dependencies.");
  }
  const signalHandlers = new Map();
  let terminating = false;

  return Object.freeze({
    listen(signal, handler) {
      if (terminating) return;
      signalHandlers.set(signal, handler);
      processRef.once(signal, handler);
    },

    terminate(code = 0) {
      if (terminating) return;
      terminating = true;
      if (processRef.platform === "darwin") {
        for (const [signal, handler] of signalHandlers) processRef.removeListener(signal, handler);
        signalHandlers.clear();
        processRef.kill(processRef.pid, "SIGTERM");
        return;
      }
      app.exit(code);
    },
  });
}
