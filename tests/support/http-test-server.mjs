export function closeTestServer(server, { timeoutMs = 250 } = {}) {
  if (!server.listening) return Promise.resolve({ forced: false });

  return new Promise((resolve, reject) => {
    let forced = false;
    const forceTimer = setTimeout(() => {
      forced = true;
      server.closeAllConnections();
    }, timeoutMs);
    const rejectTimer = setTimeout(() => {
      reject(new Error(`test server teardown exceeded ${timeoutMs * 2}ms`));
    }, timeoutMs * 2);

    server.close((error) => {
      clearTimeout(forceTimer);
      clearTimeout(rejectTimer);
      if (error) reject(error);
      else resolve({ forced });
    });
    server.closeIdleConnections();
  });
}
