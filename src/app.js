const express = require("express");
const cors = require("cors");

const healthRoutes = require("./routes/healthRoutes");
const documentRoutes = require("./routes/documentRoutes");
const requestLogger = require("./middleware/requestLogger");

/*
 * Document service — versioned document templates and the documents generated from them, rendered on the server.
 *
 * A capability service of the profession-bundle platform: profession-neutral,
 * configured by the organization's installed bundle (milestone M5).
 */
const app = express();

app.use(cors());
// Template text and field values; letters are small.
app.use(express.json({ limit: "512kb" }));

app.use(requestLogger);

app.use(healthRoutes);
app.use(documentRoutes);

module.exports = app;
