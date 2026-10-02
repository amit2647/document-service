const app = require("./app");

const PORT = process.env.PORT || 4011;

async function startServer() {
  try {
    console.log("[SERVER] Starting document-service...");

    app.listen(PORT, () => {
      console.log(`[SERVER] Document service running on port ${PORT}`);
    });
  } catch (error) {
    console.error("[SERVER] Document service startup failed");

    console.error(error);

    process.exit(1);
  }
}

startServer();
