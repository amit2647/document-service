const express = require("express");

const authenticate = require("../middleware/authenticate");
const requirePermission = require("../middleware/requirePermission");
const requireBundle = require("../middleware/requireBundle");
const templateService = require("../services/templateService");
const documentService = require("../services/documentService");
const { choicesOf } = require("../services/bundleSync");

const router = express.Router();

/*
 * Documents (DOC-01–15, CD-12). Every route but the install step answers
 * only an organization with a profession bundle. Editing a template's text
 * is a settings permission, as for the bundle's other configuration.
 */

const KEY = /^[a-z][a-z0-9-]{1,59}$/;
const ITEM = /^[a-z][a-z0-9_]{1,59}$/;
const VERSION = /^\d+\.\d+\.\d+$/;

function respond(handler) {
  return async (req, res) => {
    try {
      const result = await handler(req, res);
      if (!res.headersSent) res.json(result ?? { ok: true });
    } catch (error) {
      if (!error.statusCode) console.error("[Documents]", error);
      res.status(error.statusCode || 500).json({
        error: error.statusCode ? error.message : "The document request failed",
        ...(error.details ? { details: error.details } : {}),
      });
    }
  };
}

function bad(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function id(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw bad("Invalid id");
  return number;
}

const optionalId = (value) => (value === undefined || value === null || value === "" ? null : id(value));

function itemKey(value) {
  if (!ITEM.test(String(value || ""))) throw bad("Invalid template key");
  return value;
}

function period(value) {
  if (value === undefined || value === null || value === "") return null;
  if (!/^\d{4}(-\d{2})?$/.test(String(value))) throw bad("Invalid period");
  return String(value);
}

const auth = (req) => ({ organizationId: req.auth.organizationId, userId: req.auth.userId });
const gated = (permission) => [authenticate, requirePermission(permission), requireBundle];

// The documents step of a bundle install (runs before the install has finished).
router.put(
  "/documents/bundles/:key/:version",
  authenticate,
  requirePermission("bundles.manage"),
  respond(async (req) => {
    if (!KEY.test(req.params.key) || !VERSION.test(req.params.version)) throw bad("Invalid bundle key or version");
    const documents = req.body?.documents;
    if (!Array.isArray(documents)) throw bad("documents must be an array");

    return templateService.installTemplates(req.auth.organizationId, req.params.key, req.params.version, documents, choicesOf(req));
  }),
);

// The tiles: every current template, and whether it applies to this client and period.
router.get(
  "/documents/templates",
  ...gated("documents.read"),
  respond((req) => documentService.tiles(req.auth.organizationId, optionalId(req.query.customerId), period(req.query.period))),
);

router.get(
  "/documents/templates/:key",
  ...gated("documents.read"),
  respond((req) => documentService.templateDetail(req.auth.organizationId, itemKey(req.params.key))),
);

// A firm's own revision of a template's text.
router.put(
  "/documents/templates/:key",
  ...gated("system.settings"),
  respond(async (req) => {
    await templateService.editTemplate(auth(req), itemKey(req.params.key), req.body?.body);
    return documentService.templateDetail(req.auth.organizationId, req.params.key);
  }),
);

router.post(
  "/documents/templates/:key/restore",
  ...gated("system.settings"),
  respond(async (req) => {
    await templateService.restoreTemplate(auth(req), itemKey(req.params.key));
    return documentService.templateDetail(req.auth.organizationId, req.params.key);
  }),
);

// Renders without storing. A `body` previews unsaved template text, so it needs settings.
router.post(
  "/documents/preview",
  ...gated("documents.read"),
  respond((req) => {
    const body = req.body || {};

    if (body.body !== undefined && !req.auth.permissions.includes("system.settings")) {
      const error = new Error("Previewing template text needs the settings permission");
      error.statusCode = 403;
      throw error;
    }

    return documentService.preview(req.auth.organizationId, {
      templateKey: itemKey(body.templateKey),
      customerId: optionalId(body.customerId),
      period: period(body.period),
      fieldValues: body.fieldValues && typeof body.fieldValues === "object" ? body.fieldValues : {},
      body: body.body,
    });
  }),
);

router.get(
  "/documents",
  ...gated("documents.read"),
  respond((req) => documentService.list(req.auth.organizationId, { customerId: optionalId(req.query.customerId), period: period(req.query.period) })),
);

router.get(
  "/documents/:id",
  ...gated("documents.read"),
  respond((req) => documentService.get(req.auth.organizationId, id(req.params.id))),
);

router.post(
  "/documents",
  ...gated("documents.generate"),
  respond(async (req, res) => {
    const body = req.body || {};
    const created = await documentService.create(auth(req), {
      templateKey: itemKey(body.templateKey),
      customerId: id(body.customerId),
      period: period(body.period),
      fieldValues: body.fieldValues && typeof body.fieldValues === "object" ? body.fieldValues : {},
    });
    res.status(201);
    return created;
  }),
);

router.put(
  "/documents/:id",
  ...gated("documents.generate"),
  respond((req) => {
    const fieldValues = req.body?.fieldValues;
    if (!fieldValues || typeof fieldValues !== "object") throw bad("fieldValues is required");
    return documentService.update(auth(req), id(req.params.id), { fieldValues });
  }),
);

router.post(
  "/documents/:id/finalize",
  ...gated("documents.generate"),
  respond((req) => documentService.finalize(auth(req), id(req.params.id), { udin: req.body?.udin })),
);

router.delete(
  "/documents/:id",
  ...gated("documents.generate"),
  respond((req) => documentService.remove(auth(req), id(req.params.id))),
);

module.exports = router;
